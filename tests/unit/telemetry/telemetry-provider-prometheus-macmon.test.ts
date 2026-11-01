/**
 * Unit tests for the macmon (Apple SMC) GPU metric mapping in the
 * Prometheus fleet-telemetry adapter (OR-ATOM-005 / T5.14b-2).
 *
 * Live ground truth (in-cluster kube-prometheus port-forwarded to
 * 127.0.0.1:9090, job `macmon_apple_gpu`, macmon 0.8.2 exporter on an
 * Apple MacBook Pro / M5 Max): the three mapped series each carry the
 * identity labels `hostname` + `uuid` (cluster-side relabels), plus the
 * exporter-native `chip` label. The `uuid` value is the chip display
 * name — "Apple M5 Max" — which CONTAINS A SPACE. That is a legal,
 * operator-confirmed device identity (one Apple GPU per host), so the
 * identity contract must accept space-containing label values while
 * still forbidding the structural separators `:` and `/`.
 *
 * Data semantics under test (the honesty invariant):
 *   - `macmon_gpu_scaled_ratio` (0..1) → `utilizationPercent` = value×100,
 *     provenance basis stays the REAL source name;
 *   - `macmon_gpu_temp_celsius` → `temperatureC`, `macmon_gpu_power_watts`
 *     → `powerWatts` (pass-through);
 *   - macmon/SMC exposes NO discrete GPU memory (Apple uses shared system
 *     RAM) → the macmon GPU row carries NO vram fields — absent, never a
 *     fabricated zero;
 *   - the deprecated/adjacent `macmon_gpu_*` families are NOT allowlisted
 *     → silent drop, no observation, no throw;
 *   - out-of-range scaled_ratio (>1 or <0) → dropped as unknown, never
 *     clamped;
 *   - a sample missing the uuid label is dropped (identity contract);
 *   - the DCGM names stay allowlisted (regression).
 *
 * Deterministic + hermetic: fixed fixture clock, fake fetch, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FleetMetricsConfig } from "../../../src/shared/topology/telemetry/fleetMetricsConfig";
import { labelKeysFromConfig } from "../../../src/shared/topology/telemetry/fleetMetricsConfig";
import type { FetchLike } from "../../../src/shared/topology/telemetry/providers/fleetMetricsHttp";
import {
  allowlistedMetricNames,
  gpuIdentityFromLabels,
  mappingForMetric,
} from "../../../src/shared/topology/telemetry/providers/metricMapping";
import { createPrometheusProvider } from "../../../src/shared/topology/telemetry/providers/prometheus";
import type { FleetTelemetrySnapshot } from "../../../src/shared/topology/telemetry/types";
import { fixtureNow, resetFixtureClock } from "./telemetry-fixtures";

resetFixtureClock(1_700_000_000_000);
const NOW = fixtureNow();
const T0_SECONDS = NOW / 1000;

const QUERY = { windowMs: 60_000 };

/**
 * The deployed macmon identity (OR-ATOM-005 wiring): cluster-side relabels
 * add `hostname` + `uuid`; the adapter's label keys are configured from the
 * same env (`OMNIROUTE_FLEET_METRICS_LABEL_HOST=hostname`,
 * `OMNIROUTE_FLEET_METRICS_LABEL_GPU_DEVICE=uuid`).
 */
const MACMON_LABELS = {
  __name__: "macmon_gpu_scaled_ratio",
  chip: "Apple M5 Max",
  hostname: "stabulous",
  instance: "192.168.42.201:9103",
  job: "macmon_apple_gpu",
  uuid: "Apple M5 Max",
};

function config(over: Record<string, unknown> = {}): FleetMetricsConfig {
  return {
    source: "prometheus",
    url: "http://127.0.0.1:9090",
    freshnessMs: 30_000,
    labelHost: "hostname",
    labelGpuDevice: "uuid",
    ...over,
  } as unknown as FleetMetricsConfig;
}

/** One instant-query series (metric name is injected into the labels). */
function series(labels: Record<string, string>, value: number | string, ts = T0_SECONDS) {
  return [
    {
      metric: { ...labels, __name__: labels.__name__ ?? "" },
      value: [String(ts), String(value)],
    },
  ];
}

interface FakeResponseSpec {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

/** Recording fake fetch; routes by the allowlisted metric name in the query. */
function makeFakeFetch(payloads: Record<string, FakeResponseSpec> = {}) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const m = /api\/v1\/query\?query=(.*)$/.exec(url);
    const name = m ? decodeURIComponent(m[1]).replace(/\{\}$/, "") : "";
    const spec = payloads[name] ?? { ok: false, status: 404, body: {} };
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      text: async () => JSON.stringify(spec.body ?? {}),
    } as unknown as Response;
  };
  return { calls, fetchImpl };
}

function macmonMetrics(
  values: {
    ratio?: number;
    temp?: number;
    power?: number;
  } = {}
): Record<string, FakeResponseSpec> {
  const out: Record<string, FakeResponseSpec> = {};
  if (values.ratio !== undefined) {
    out.macmon_gpu_scaled_ratio = {
      body: { data: { result: series(MACMON_LABELS, values.ratio) } },
    };
  }
  if (values.temp !== undefined) {
    out.macmon_gpu_temp_celsius = {
      body: { data: { result: series(MACMON_LABELS, values.temp) } },
    };
  }
  if (values.power !== undefined) {
    out.macmon_gpu_power_watts = {
      body: { data: { result: series(MACMON_LABELS, values.power) } },
    };
  }
  return out;
}

async function snapshot(
  payloads: Record<string, FakeResponseSpec>,
  over: Record<string, unknown> = {}
): Promise<FleetTelemetrySnapshot> {
  const { fetchImpl } = makeFakeFetch(payloads);
  const provider = createPrometheusProvider({ config: config(over), fetchImpl, now: fixtureNow });
  return provider.snapshot(QUERY);
}

function gpuRow(snapshot: FleetTelemetrySnapshot) {
  return snapshot.resources.find((r) => r.kind === "gpu");
}

describe("metricMapping: macmon allowlist (single source of truth)", () => {
  it("allowlists exactly the three macmon GPU gauges", () => {
    const names = allowlistedMetricNames();
    assert.ok(names.includes("macmon_gpu_scaled_ratio"), "scaled_ratio allowlisted");
    assert.ok(names.includes("macmon_gpu_temp_celsius"), "temp_celsius allowlisted");
    assert.ok(names.includes("macmon_gpu_power_watts"), "power_watts allowlisted");
  });

  it("maps scaled_ratio→gpu_util (percent), temp→temperature_c, power→power_w", () => {
    const ratio = mappingForMetric("macmon_gpu_scaled_ratio");
    assert.ok(ratio);
    assert.equal(ratio.field, "gpu_util");
    assert.equal(ratio.kind, "gpu");
    assert.equal(ratio.unit, "percent");
    assert.equal(ratio.counter, false);

    assert.equal(mappingForMetric("macmon_gpu_temp_celsius")?.field, "gpu_temperature_c");
    assert.equal(mappingForMetric("macmon_gpu_power_watts")?.field, "gpu_power_w");
  });

  it("does NOT allowlist the excluded macmon_gpu_* families (silent drop)", () => {
    for (const name of [
      "macmon_gpu_usage_ratio", // deprecated alias of scaled_ratio
      "macmon_gpu_active_ratio",
      "macmon_gpu_freq_mhz",
      "macmon_gpu_ram_power_watts",
      "macmon_gpu_clocks_active_ratio",
      "macmon_gpu_power_budget",
    ]) {
      assert.equal(mappingForMetric(name), null, `${name} stays off the allowlist`);
    }
  });

  it("keeps the DCGM + vLLM names allowlisted (regression)", () => {
    const names = allowlistedMetricNames();
    for (const name of [
      "DCGM_FI_DEV_GPU_UTIL",
      "DCGM_FI_DEV_FB_USED",
      "DCGM_FI_DEV_FB_TOTAL",
      "DCGM_FI_DEV_GPU_TEMP",
      "DCGM_FI_DEV_POWER_USAGE",
      "vllm:generation_tokens_total",
    ]) {
      assert.ok(names.includes(name), `${name} still allowlisted`);
    }
    // DCGM names must NOT be aliased away: each maps to its original field.
    assert.equal(mappingForMetric("DCGM_FI_DEV_GPU_UTIL")?.field, "gpu_util");
  });
});

describe("prometheus provider: macmon gpu row (live label shape)", () => {
  it("(a) scaled_ratio with hostname+uuid → gpu row, util=value×100, real basis, real id", async () => {
    const snap = await snapshot(macmonMetrics({ ratio: 0.9462928 }));

    const row = gpuRow(snap);
    assert.ok(row, "a gpu row exists");
    assert.equal(row.kind, "gpu");
    // The operator-approved canonical id — uuid keeps its space.
    assert.equal(row.resourceId, "gpu:stabulous:Apple M5 Max");
    assert.equal(row.hostId, "stabulous");
    assert.equal(row.deviceUuid, "Apple M5 Max");

    const util = row.utilizationPercent;
    assert.ok(util, "utilizationPercent present");
    assert.equal(util.value, 0.9462928 * 100); // 94.62928 — scaled, not clamped/rounded
    assert.equal(util.source, "prometheus");
    // Provenance shows the REAL source metric name (no sanitizing away the
    // macmon_ prefix).
    assert.equal(util.basis, "macmon_gpu_scaled_ratio");
    assert.equal(util.windowMs, QUERY.windowMs);
    assert.equal(util.sampledAt, NOW);
  });

  it("(b) temp + power map onto the SAME row (pass-through, own bases)", async () => {
    const snap = await snapshot(macmonMetrics({ ratio: 0.25, temp: 42.5, power: 15.75 }));

    const row = gpuRow(snap);
    assert.ok(row);
    assert.equal(row.resourceId, "gpu:stabulous:Apple M5 Max");
    // One row for the one device — no extra rows per metric.
    assert.equal(snap.resources.filter((r) => r.kind === "gpu").length, 1);

    assert.equal(row.temperatureC?.value, 42.5);
    assert.equal(row.temperatureC?.basis, "macmon_gpu_temp_celsius");
    assert.equal(row.powerWatts?.value, 15.75);
    assert.equal(row.powerWatts?.basis, "macmon_gpu_power_watts");
    assert.equal(row.utilizationPercent?.value, 25);
  });

  it("(c) the macmon gpu row carries NO vram fields (shared RAM — absent, not fabricated)", async () => {
    const snap = await snapshot(macmonMetrics({ ratio: 0.5, temp: 40, power: 10 }));

    const row = gpuRow(snap);
    assert.ok(row);
    assert.equal("vramUsedBytes" in row, false, "no vramUsedBytes key");
    assert.equal("vramTotalBytes" in row, false, "no vramTotalBytes key");
    assert.equal(row.vramUsedBytes, undefined);
    assert.equal(row.vramTotalBytes, undefined);
  });

  it("(d) the excluded macmon_gpu_* families produce NO observation and do not throw", async () => {
    const excluded = [
      "macmon_gpu_usage_ratio",
      "macmon_gpu_active_ratio",
      "macmon_gpu_freq_mhz",
      "macmon_gpu_ram_power_watts",
    ];
    const payloads: Record<string, FakeResponseSpec> = {};
    for (const name of excluded) {
      payloads[name] = { body: { data: { result: series(MACMON_LABELS, 0.42) } } };
    }
    // An allowlisted sample on the same identity must still be unaffected.
    Object.assign(payloads, macmonMetrics({ ratio: 0.5 }));

    const snap = await snapshot(payloads);

    const row = gpuRow(snap);
    assert.ok(row, "the allowlisted macmon sample still lands");
    assert.equal(row.resourceId, "gpu:stabulous:Apple M5 Max");
    // The only fact on the row came from the allowlisted scaled_ratio.
    assert.equal(row.utilizationPercent?.value, 50);
    assert.equal(row.utilizationPercent?.basis, "macmon_gpu_scaled_ratio");
    // Nothing from the excluded families leaked: temp/power/vram stay absent.
    assert.equal(row.temperatureC, undefined);
    assert.equal(row.powerWatts, undefined);
    assert.equal("vramUsedBytes" in row, false);
    assert.equal("vramTotalBytes" in row, false);
  });

  it("(e) a sample missing the uuid label is dropped (identity contract)", async () => {
    const noUuid = { ...MACMON_LABELS, uuid: "" };
    const snap = await snapshot({
      macmon_gpu_scaled_ratio: { body: { data: { result: series(noUuid, 0.9) } } },
    });

    assert.equal(gpuRow(snap), undefined, "no gpu row without a stable device id");
    assert.equal(snap.resources.length, 0, "nothing fabricated from host-only labels");
  });

  it("(f) out-of-range scaled_ratio (>1 / <0) is dropped as unknown — never clamped", async () => {
    for (const bad of [1.0000001, 1.5, -0.2]) {
      const snap = await snapshot(macmonMetrics({ ratio: bad }));
      const row = gpuRow(snap);
      assert.ok(row, "row still emitted (provenance, not a value)");
      assert.equal(row.resourceId, "gpu:stabulous:Apple M5 Max");
      assert.ok(row.utilizationPercent, "utilizationPercent slot present");
      assert.equal(row.utilizationPercent.value, null, `${bad} → unknown, not clamped`);
      assert.equal(row.utilizationPercent.basis, "macmon_gpu_scaled_ratio", "real basis kept");
    }
    // Boundary values 0 and 1 are legitimate measurements — kept.
    for (const edge of [0, 1]) {
      const snap = await snapshot(macmonMetrics({ ratio: edge }));
      assert.equal(gpuRow(snap)?.utilizationPercent?.value, edge * 100);
    }
  });
});

describe("identity contract: space-containing device ids are legal", () => {
  it("gpuIdentityFromLabels accepts a space-bearing uuid under the deployed keys", () => {
    const keys = labelKeysFromConfig(config());
    assert.equal(keys.host, "hostname");
    assert.equal(keys.gpuDevice, "uuid");

    const id = gpuIdentityFromLabels(MACMON_LABELS, keys);
    assert.deepEqual(id, { hostId: "stabulous", deviceUuid: "Apple M5 Max" });
  });

  it("still rejects empty, colon-bearing, and slash-bearing identity values", () => {
    const keys = labelKeysFromConfig(config());
    assert.equal(gpuIdentityFromLabels({ hostname: "h", uuid: " " }, keys), null);
    assert.equal(gpuIdentityFromLabels({ hostname: "h", uuid: "" }, keys), null);
    assert.equal(gpuIdentityFromLabels({ hostname: "h", uuid: "a:b" }, keys), null);
    assert.equal(gpuIdentityFromLabels({ hostname: "h", uuid: "a/b" }, keys), null);
    // A space in the HOST value is equally legal (one GPU per host is the
    // Apple topology); only the structural separators are forbidden.
    assert.deepEqual(gpuIdentityFromLabels({ hostname: "my host", uuid: "u" }, keys), {
      hostId: "my host",
      deviceUuid: "u",
    });
  });
});
