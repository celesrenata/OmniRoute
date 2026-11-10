/**
 * Declared runtime -> GPU attribution (scrape relabels `gpu_uuid` + `gpu_host` +
 * `model_id`) and the Intel Arc exporter gauges, through the real Prometheus
 * adapter and reconcile. Hermetic: fake fetch, fixed clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FleetMetricsConfig } from "../../../src/shared/topology/telemetry/fleetMetricsConfig";
import type { FetchLike } from "../../../src/shared/topology/telemetry/providers/fleetMetricsHttp";
import { createPrometheusProvider } from "../../../src/shared/topology/telemetry/providers/prometheus";
import { reconcileSnapshot } from "../../../src/shared/topology/telemetry/reconcile";
import { resourceSchema } from "../../../src/shared/topology/telemetry/provenance";
import { fixtureNow, resetFixtureClock } from "./telemetry-fixtures";

resetFixtureClock(1_700_000_000_000);
const T0 = fixtureNow() / 1000;

const config = {
  source: "prometheus",
  url: "http://127.0.0.1:9090",
  freshnessMs: 30_000,
  labelHost: "hostname",
  labelGpuDevice: "uuid",
} as unknown as FleetMetricsConfig;

function fetchFor(payloads: Record<string, Array<Record<string, string>>>, value = "3") {
  const fetchImpl: FetchLike = async (url) => {
    const m = /api\/v1\/query\?query=(.*)$/.exec(url);
    const name = m ? decodeURIComponent(m[1]).replace(/\{\}$/, "") : "";
    const result = (payloads[name] ?? []).map((labels) => ({
      metric: { ...labels, __name__: name },
      value: [String(T0), value],
    }));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { result } }),
    } as unknown as Response;
  };
  return fetchImpl;
}

describe("declared runtime -> GPU attribution", () => {
  it("joins the q27 runtime to the Esnixi GPU by gpu_uuid + gpu_host and records its model", async () => {
    const gpu = { hostname: "esnixi", uuid: "GPU-5090" };
    const rt = {
      hostname: "192.168.133.3",
      runtime_id: "q27",
      instance: "192.168.133.3:2701",
      gpu_uuid: "GPU-5090",
      gpu_host: "esnixi",
      model_id: "qwen3.8-27b-nvfp4",
    };
    const provider = createPrometheusProvider({
      config,
      fetchImpl: fetchFor({ DCGM_FI_DEV_GPU_UTIL: [gpu], "q27:num_requests_running": [rt] }),
      now: fixtureNow,
    });
    const snap = await provider.snapshot({ windowMs: 60_000 });
    // The gateway validates every resource strictly; an unknown field drops the snapshot.
    for (const res of snap.resources)
      assert.ok(resourceSchema.safeParse(res).success, res.resourceId);
    const r = reconcileSnapshot(snap);
    const runtime = r.runtimeNodes.find((n) => n.runtimeId === "q27");
    assert.ok(runtime);
    assert.deepEqual(runtime.attributedGpuIds, ["gpu:esnixi:GPU-5090"]);
    assert.equal(runtime.modelId, "qwen3.8-27b-nvfp4");
    assert.ok(
      r.edges.some(
        (e) =>
          e.relation === "runtime_device" &&
          e.source === runtime.resourceId &&
          e.target === "gpu:esnixi:GPU-5090"
      )
    );
  });

  it("without the declared labels the runtime stays unattributed (never inferred)", async () => {
    const rt = { hostname: "192.168.133.3", runtime_id: "q27", instance: "192.168.133.3:2701" };
    const provider = createPrometheusProvider({
      config,
      fetchImpl: fetchFor({ "q27:num_requests_running": [rt] }),
      now: fixtureNow,
    });
    const r = reconcileSnapshot(await provider.snapshot({ windowMs: 60_000 }));
    assert.deepEqual(r.runtimeNodes[0]?.attributedGpuIds, []);
    assert.equal(r.runtimeNodes[0]?.modelId, undefined);
  });
});

describe("Intel Arc exporter gauges", () => {
  it("map onto a gpu row (util %, power W) keyed by node hostname + intel-arc", async () => {
    const arc = { hostname: "gremlin-2", uuid: "intel-arc" };
    const provider = createPrometheusProvider({
      config,
      fetchImpl: fetchFor(
        {
          intel_gpu_busy_percent: [arc],
          intel_gpu_power_watts: [arc],
          intel_gpu_package_temp_celsius: [arc],
        },
        "12.5"
      ),
      now: fixtureNow,
    });
    const r = reconcileSnapshot(await provider.snapshot({ windowMs: 60_000 }));
    const g = r.gpuNodes.find((n) => n.hostId === "gremlin-2");
    assert.ok(g);
    assert.equal(g.deviceUuid, "intel-arc");
    assert.equal(g.utilizationPercent?.value, 12.5);
    assert.equal(g.powerWatts?.value, 12.5);
    assert.equal(g.temperatureC?.value, 12.5);
    assert.equal(g.temperatureC?.basis, "intel_gpu_package_temp_celsius");
    assert.equal(g.vramUsedBytes, undefined, "shared system RAM: no VRAM fabricated");
  });
});
