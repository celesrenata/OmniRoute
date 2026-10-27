/**
 * Unit tests for the Grafana fleet-telemetry adapter (OR-ATOM-005 / Step 5):
 * `createGrafanaProvider().snapshot(query)` / `.probe(signal)` driven through
 * the PUBLIC provider interface with an injected `fetchImpl` (fake HTTP) and
 * the injectable `now` clock. The private `applyGrafanaSample` is never
 * imported — only its observable effects on the snapshot are asserted.
 *
 * Deterministic + hermetic: fixed fixture clock, fake fetch, no network, no DB.
 *
 * Data semantics under test:
 *   - the Grafana-PROXY provenance rule: every proxied sample carries
 *     `source: "grafana"` AND `basis: "datasource=<type>:<uid>"`;
 *   - only the documented Prometheus datasource type is supported; any other
 *     type probes as unavailable WITHOUT issuing a network request;
 *   - the ds/query wire format is parsed: `results.A.frames[]`, values[0]=time
 *     column, values[1]=value column, labels on the numeric schema field;
 *   - frame times are parsed (RFC3339 / epoch-seconds / epoch-ms);
 *   - identity rules mirror the shared mapping (GPU needs host + device;
 *     runtime counter needs runtime identity; unknown → dropped, never
 *     fabricated);
 *   - exactly the 9 allowlisted metrics are queried (no user PromQL);
 *   - one failing metric never poisons the snapshot; an abort propagates
 *     (category "aborted").
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FleetMetricsConfig } from "../../../src/shared/topology/telemetry/fleetMetricsConfig";
import {
  FleetMetricsHttpError,
  type FetchLike,
} from "../../../src/shared/topology/telemetry/providers/fleetMetricsHttp";
import { createCounterRateEngine } from "../../../src/shared/topology/telemetry/providers/metricMapping";
import { createGrafanaProvider } from "../../../src/shared/topology/telemetry/providers/grafana";
import type {
  FleetResourceObservation,
  FleetTelemetrySnapshot,
} from "../../../src/shared/topology/telemetry/types";
import { advanceFixtureClock, fixtureNow, resetFixtureClock } from "./telemetry-fixtures";

resetFixtureClock(1_700_000_000_000);
const NOW = fixtureNow();
const T0_SECONDS = NOW / 1000;
const T0_ISO = new Date(NOW).toISOString();
const DS_UID = "DS-UID-1";

const QUERY = { windowMs: 60_000 };
const GPU_LABELS = { host: "h1", gpu_uuid: "uuid-0" };
const RUNTIME_LABELS = { host: "h1", runtime_id: "rt-0" };
const BASIS = `datasource=prometheus:${DS_UID}`;

function config(over: Record<string, unknown> = {}): FleetMetricsConfig {
  return {
    source: "grafana",
    url: "http://127.0.0.1:3000",
    freshnessMs: 30_000,
    ...over,
  } as unknown as FleetMetricsConfig;
}

interface FakeResponseSpec {
  ok?: boolean;
  status?: number;
  body?: unknown;
  error?: Error;
}

/** One ds/query frame: time column + value column, labels on the numeric field. */
function frame(labels: Record<string, string>, times: unknown[], values: unknown[]) {
  return {
    schema: {
      name: "frame",
      fields: [{ type: "time" }, { type: "number", name: "value", labels }],
    },
    data: { values: [times, values] },
  };
}

function resultsFor(framesByMetric: Record<string, unknown>): Record<string, FakeResponseSpec> {
  return Object.fromEntries(
    Object.entries(framesByMetric).map(([metric, frames]) => [
      metric,
      { ok: true, status: 200, body: { results: { A: { frames } } } },
    ])
  );
}

/**
 * Recording fake fetch: routes by the metric name in the POST body's
 * `queries[0].query`. Unknown metrics default to a 404 (the snapshot always
 * "sees" all nine allowlisted queries).
 */
function makeFakeFetch(payloads: Record<string, FakeResponseSpec> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (init?.signal?.aborted) throw new Error("fetch aborted");
    let metric = "";
    try {
      const parsed = JSON.parse(init?.body as string) as { queries?: Array<{ query?: string }> };
      // The source sends `${metric}{}` — strip the selector braces to match keys.
      metric = (parsed.queries?.[0]?.query ?? "").replace(/\{\}$/, "");
    } catch {
      metric = "";
    }
    const spec = payloads[metric] ?? { ok: false, status: 404, body: {} };
    if (spec.error) throw spec.error;
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      text: async () => JSON.stringify(spec.body ?? {}),
    } as unknown as Response;
  };
  return { calls, fetchImpl };
}

function findBy(
  snapshot: FleetTelemetrySnapshot,
  id: string
): FleetResourceObservation | undefined {
  return snapshot.resources.find((r) => r.resourceId === id);
}

describe("grafana provider: probe", () => {
  it("is available when /api/health answers 200", async () => {
    const fetchImpl: FetchLike = async () =>
      ({ ok: true, status: 200, text: async () => "{}" }) as unknown as Response;
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });
    const status = await provider.probe();
    assert.equal(provider.id, "grafana");
    assert.equal(provider.kind, "grafana");
    assert.deepEqual(status, { available: true, checkedAt: NOW });
  });

  it("is unavailable (with status) when /api/health is non-2xx", async () => {
    const fetchImpl: FetchLike = async () =>
      ({ ok: false, status: 401, text: async () => "" }) as unknown as Response;
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });
    const status = await provider.probe();
    assert.equal(status.available, false);
    assert.equal(status.checkedAt, NOW);
    assert.equal(status.message, "status 401");
  });

  it("is unavailable for an unsupported datasource type WITHOUT any network request", async () => {
    const calls: unknown[] = [];
    const fetchImpl: FetchLike = async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    };
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      // @ts-expect-error — deliberately unsupported type, rejected at registration.
      datasourceType: "loki",
      fetchImpl,
      now: fixtureNow,
    });
    const status = await provider.probe();
    assert.equal(status.available, false);
    assert.equal(status.checkedAt, NOW);
    assert.equal(status.message, "unsupported datasource type: loki");
    assert.equal(calls.length, 0); // honest scope: no unverified Flux path is issued
  });
});

describe("grafana provider: snapshot — GPU gauges via ds/query", () => {
  it("queries exactly the nine allowlisted metrics via POST /api/ds/query", async () => {
    const payloads = resultsFor({
      DCGM_FI_DEV_GPU_UTIL: [frame(GPU_LABELS, [T0_ISO], [73.5])],
    });
    const { calls, fetchImpl } = makeFakeFetch(payloads);
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    await provider.snapshot(QUERY);

    assert.equal(calls.length, 9);
    assert.equal(calls[0].url, "http://127.0.0.1:3000/api/ds/query");
    assert.equal(calls[0].init?.method, "POST");
    const body = JSON.parse(calls[0].init?.body as string);
    assert.deepEqual(body, {
      queries: [
        {
          refId: "A",
          datasource: { uid: DS_UID },
          query: "DCGM_FI_DEV_GPU_UTIL{}",
          queryType: "instant",
        },
      ],
      from: "now-5m",
      to: "now",
    });
  });

  it("maps a frame onto a gpu row with the grafana-proxy provenance (basis starts with datasource=)", async () => {
    const payloads = resultsFor({
      DCGM_FI_DEV_GPU_UTIL: [frame(GPU_LABELS, [T0_ISO], [73.5])],
      DCGM_FI_DEV_FB_USED: [frame(GPU_LABELS, [T0_ISO], [2_147_483_648])],
    });
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.capturedAt, NOW);
    assert.equal(snapshot.resources.length, 1);
    const row = snapshot.resources[0];
    assert.equal(row.resourceId, "gpu:h1:uuid-0");
    assert.equal(row.kind, "gpu");
    assert.equal(row.hostId, "h1");
    assert.equal(row.deviceUuid, "uuid-0");

    const util = row.utilizationPercent;
    assert.ok(util);
    assert.equal(util.value, 73.5);
    assert.equal(util.source, "grafana");
    assert.equal(util.sampledAt, NOW);
    assert.equal(util.basis, BASIS); // the grafana-proxy rule
    assert.ok(util.basis.startsWith("datasource="));
    assert.equal(util.windowMs, QUERY.windowMs);
    assert.equal(util.stale, undefined);

    assert.equal(row.vramUsedBytes?.value, 2_147_483_648);
    assert.equal(row.vramUsedBytes?.basis, BASIS);
  });

  it("parses frame times: epoch-seconds numbers become epoch-ms", async () => {
    const payloads = resultsFor({
      DCGM_FI_DEV_GPU_UTIL: [frame(GPU_LABELS, [T0_SECONDS], [50])],
    });
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources[0].utilizationPercent?.sampledAt, NOW);
  });

  it("skips non-numeric value cells but keeps the rest of the frame", async () => {
    const payloads = resultsFor({
      DCGM_FI_DEV_GPU_UTIL: [frame(GPU_LABELS, [T0_ISO, T0_ISO], ["not-a-number", 55])],
    });
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 1);
    assert.equal(snapshot.resources[0].utilizationPercent?.value, 55);
  });

  it("drops a sample WITHOUT proven device identity (never fabricated)", async () => {
    const payloads = resultsFor({
      DCGM_FI_DEV_GPU_UTIL: [frame({ host: "h1" }, [T0_ISO], [50])],
    });
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 0);
  });

  it("ignores frames without a numeric schema field or with <2 value columns", async () => {
    const payloads = resultsFor({
      DCGM_FI_DEV_GPU_UTIL: [
        // No numeric field in the schema → skipped.
        { schema: { fields: [{ type: "time" }] }, data: { values: [[T0_ISO], [50]] } },
        // Fewer than two value columns → skipped.
        {
          schema: { fields: [{ type: "time" }, { type: "number", labels: GPU_LABELS }] },
          data: { values: [[T0_ISO]] },
        },
      ],
    });
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 0);
  });

  it("marks samples older than the freshness window as stale (value kept)", async () => {
    const payloads = resultsFor({
      DCGM_FI_DEV_GPU_UTIL: [frame(GPU_LABELS, [new Date(NOW - 120_000).toISOString()], [73.5])],
    });
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);

    const util = snapshot.resources[0].utilizationPercent;
    assert.ok(util);
    assert.equal(util.value, 73.5);
    assert.equal(util.stale, true);
  });

  it("falls back to capturedAt for future-dated frame times", async () => {
    const payloads = resultsFor({
      DCGM_FI_DEV_GPU_UTIL: [frame(GPU_LABELS, [new Date(NOW + 120_000).toISOString()], [73.5])],
    });
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);

    const util = snapshot.resources[0].utilizationPercent;
    assert.ok(util);
    assert.equal(util.sampledAt, NOW);
    assert.equal(util.stale, undefined);
  });
});

describe("grafana provider: snapshot — runtime counter (vLLM tokens/s)", () => {
  it("emits an UNKNOWN rate (null) without a counter engine — never invented", async () => {
    let value = 100;
    const get = () =>
      resultsFor({ "vllm:generation_tokens_total": [frame(RUNTIME_LABELS, [T0_ISO], [value])] })[
        "vllm:generation_tokens_total"
      ]?.body;
    const fetchImpl: FetchLike = async () =>
      ({ ok: true, status: 200, text: async () => JSON.stringify(get()) }) as unknown as Response;

    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    const first = await provider.snapshot(QUERY);
    value = 700;
    const second = await provider.snapshot(QUERY);

    const firstRow = findBy(first, "runtime:h1:rt-0");
    assert.ok(firstRow);
    assert.equal(firstRow.kind, "runtime");
    assert.equal(firstRow.runtimeId, "rt-0");
    assert.equal(firstRow.outputTokensPerSecond?.value, null);
    assert.equal(firstRow.outputTokensPerSecond?.source, "grafana");
    assert.equal(firstRow.outputTokensPerSecond?.basis, BASIS);
    // No cross-snapshot state → still unknown on the second snapshot.
    assert.equal(findBy(second, "runtime:h1:rt-0")?.outputTokensPerSecond?.value, null);
  });

  it("computes a windowed rate across snapshots with a counter engine", async () => {
    let value = 100;
    const get = () =>
      resultsFor({ "vllm:generation_tokens_total": [frame(RUNTIME_LABELS, [T0_ISO], [value])] });
    const fetchImpl: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(get()["vllm:generation_tokens_total"].body),
      }) as unknown as Response;
    const engine = createCounterRateEngine();
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
      counterEngine: engine,
    });

    const first = await provider.snapshot(QUERY);
    assert.equal(findBy(first, "runtime:h1:rt-0")?.outputTokensPerSecond?.value, null);

    advanceFixtureClock(60_000);
    value = 700;
    const second = await provider.snapshot(QUERY);
    const rate = findBy(second, "runtime:h1:rt-0")?.outputTokensPerSecond;
    assert.ok(rate);
    assert.equal(rate.value, 10); // 600 tokens / 60s
  });

  it("drops the counter WITHOUT a stable runtime identity (server-level fact)", async () => {
    const payloads = resultsFor({
      "vllm:generation_tokens_total": [frame({ host: "h1" }, [T0_ISO], [1000])],
    });
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 0);
  });
});

describe("grafana provider: snapshot — error containment", () => {
  it("one failing metric (503) does not poison the rest of the snapshot", async () => {
    const payloads = resultsFor({
      DCGM_FI_DEV_GPU_UTIL: [frame(GPU_LABELS, [T0_ISO], [73.5])],
      DCGM_FI_DEV_FB_USED: [frame(GPU_LABELS, [T0_ISO], [2_147_483_648])],
    });
    const { fetchImpl } = makeFakeFetch({
      ...payloads,
      DCGM_FI_DEV_FB_USED: { ok: false, status: 503, body: {} },
    });
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 1);
    assert.equal(snapshot.resources[0].utilizationPercent?.value, 73.5);
    assert.equal(snapshot.resources[0].vramUsedBytes, undefined);
  });

  it("an aborted request propagates as a FleetMetricsHttpError (category 'aborted')", async () => {
    const { fetchImpl } = makeFakeFetch(resultsFor({}));
    const provider = createGrafanaProvider({
      config: config(),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => provider.snapshot(QUERY, controller.signal),
      (err: unknown) => err instanceof FleetMetricsHttpError && err.category === "aborted"
    );
  });
});

/**
 * T5.6b1 — DCGM VRAM unit knob: `OMNIROUTE_FLEET_METRICS_VRAM_UNIT=mib`.
 * Mirrors the prometheus/influx MiB→bytes assertions: with
 * `vramUnit: "mib"`, the two VRAM gauges scale by 1048576 through the SAME
 * shared helper (`vramScaleFor` / `isVramMetric` in `metricMapping.ts`), not
 * a copy-pasted `* 1048576` in this file. Non-VRAM gauges stay unscaled.
 */
describe("grafana provider: snapshot — DCGM VRAM MiB→bytes scale (T5.6b1)", () => {
  it("vramUnit='mib' scales DCGM_FI_DEV_FB_USED and _FB_TOTAL by 1048576", async () => {
    const payloads = resultsFor({
      DCGM_FI_DEV_GPU_UTIL: [frame(GPU_LABELS, [T0_ISO], [73.5])],
      DCGM_FI_DEV_FB_USED: [frame(GPU_LABELS, [T0_ISO], [458])],
      DCGM_FI_DEV_FB_TOTAL: [frame(GPU_LABELS, [T0_ISO], [16025])],
      DCGM_FI_DEV_GPU_TEMP: [frame(GPU_LABELS, [T0_ISO], [61])],
      DCGM_FI_DEV_POWER_USAGE: [frame(GPU_LABELS, [T0_ISO], [220.25])],
    });
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createGrafanaProvider({
      config: config({ vramUnit: "mib" }),
      datasourceUid: DS_UID,
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);
    const row = snapshot.resources.find((r) => r.resourceId === "gpu:h1:uuid-0");
    assert.ok(row);
    assert.equal(row.vramUsedBytes?.value, 458 * 1_048_576);
    assert.equal(row.vramUsedBytes?.value, 480_247_808);
    assert.equal(row.vramTotalBytes?.value, 16025 * 1_048_576);
    // The non-VRAM gauges are NEVER scaled by the knob.
    assert.equal(row.utilizationPercent?.value, 73.5);
    assert.equal(row.temperatureC?.value, 61);
    assert.equal(row.powerWatts?.value, 220.25);
  });
});
