/**
 * Unit tests for the InfluxDB 2 fleet-telemetry adapter (OR-ATOM-005 / Step 5):
 * `createInfluxProvider().snapshot(query)` / `.probe(signal)` driven through
 * the PUBLIC provider interface with an injected `fetchImpl` (fake HTTP) and
 * the injectable `now` clock. The private `rowToGpuResource` /
 * `rowToRuntimeResource` are never imported — only their observable effects
 * on the snapshot are asserted.
 *
 * Deterministic + hermetic: fixed fixture clock, fake fetch, no network, no DB.
 *
 * Data semantics under test:
 *   - identity comes from TAG COLUMNS (`host_id` + `gpu_uuid` / `runtime_id`);
 *     a row without them is dropped, never fabricated;
 *   - the `output_tokens_total` counter becomes a windowed rate via
 *     `priorCounters` (no prior → unknown, never negative/invented);
 *   - sample times come from the `time` column (RFC3339 → epoch-ms);
 *   - gauge columns map with unit guards (percent [0,100], non-negative counts);
 *   - exactly the 2 version-controlled Flux queries are issued (no user Flux);
 *   - a non-2xx flux response rejects the snapshot (category "http"); an abort
 *     propagates (category "aborted").
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FleetMetricsConfig } from "../../../src/shared/topology/telemetry/fleetMetricsConfig";
import {
  FleetMetricsHttpError,
  type FetchLike,
} from "../../../src/shared/topology/telemetry/providers/fleetMetricsHttp";
import {
  INFLUX_QUERIES,
  createInfluxProvider,
} from "../../../src/shared/topology/telemetry/providers/influxdb2";
import { fixtureNow, resetFixtureClock } from "./telemetry-fixtures";

resetFixtureClock(1_700_000_000_000);
const NOW = fixtureNow();
const T0_ISO = new Date(NOW - 5_000).toISOString();

const QUERY = { windowMs: 60_000 };

function config(over: Record<string, unknown> = {}): FleetMetricsConfig {
  return {
    source: "influxdb2",
    url: "http://127.0.0.1:8086",
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

/** Recording fake fetch: routes by the Flux query in the POST body. */
function makeFakeFetch(payloads: Record<string, FakeResponseSpec> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (init?.signal?.aborted) throw new Error("fetch aborted");
    let query = "";
    if (typeof init?.body === "string") {
      try {
        query = (JSON.parse(init.body) as { query?: string }).query ?? "";
      } catch {
        query = "";
      }
    }
    const spec = payloads[query] ?? { ok: false, status: 404, body: {} };
    if (spec.error) throw spec.error;
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      text: async () => JSON.stringify(spec.body ?? {}),
    } as unknown as Response;
  };
  return { calls, fetchImpl };
}

function gpuPayload(columns: string[], rows: unknown[][]) {
  // InfluxDB HTTP v2 JSON: results[].series[] carry columns + values.
  return { results: [{ statementId: "_0", name: "gpu", series: [{ columns, values: rows }] }] };
}

describe("influx provider: probe", () => {
  it("is available when /api/v2/ping answers 2xx", async () => {
    const fetchImpl: FetchLike = async () =>
      ({ ok: true, status: 204, text: async () => "" }) as unknown as Response;
    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });
    const status = await provider.probe();
    assert.equal(provider.id, "influxdb2");
    assert.equal(provider.kind, "influxdb2");
    assert.deepEqual(status, { available: true, checkedAt: NOW });
  });

  it("is unavailable (with status) when ping is non-2xx", async () => {
    const fetchImpl: FetchLike = async () =>
      ({ ok: false, status: 500, text: async () => "" }) as unknown as Response;
    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });
    const status = await provider.probe();
    assert.equal(status.available, false);
    assert.equal(status.checkedAt, NOW);
    assert.equal(status.message, "status 500");
  });

  it("is unavailable with category 'ssrf' for a wrong-port base URL", async () => {
    const fetchImpl: FetchLike = async () =>
      ({ ok: true, status: 204, text: async () => "" }) as unknown as Response;
    // Port 9999 is not on the InfluxDB default allowlist [8086].
    const provider = createInfluxProvider({
      config: config({ url: "http://127.0.0.1:9999" }),
      fetchImpl,
      now: fixtureNow,
    });
    const status = await provider.probe();
    assert.equal(status.available, false);
    assert.equal(status.message, "ssrf");
  });
});

describe("influx provider: snapshot — GPU rows", () => {
  it("issues exactly the two version-controlled Flux queries (no user Flux)", async () => {
    const { calls, fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: { body: { results: [] } },
      [INFLUX_QUERIES.runtime]: { body: { results: [] } },
    });
    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });

    await provider.snapshot(QUERY);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "http://127.0.0.1:8086/api/v2/query");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.headers?.["Content-Type"], "application/json");
    const body0 = JSON.parse(calls[0].init?.body as string);
    assert.deepEqual(body0, { query: INFLUX_QUERIES.gpu });
    const body1 = JSON.parse(calls[1].init?.body as string);
    assert.deepEqual(body1, { query: INFLUX_QUERIES.runtime });
  });

  it("maps one tagged row onto a gpu row; fields carry column-based provenance", async () => {
    const { fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: {
        body: gpuPayload(
          [
            "time",
            "host_id",
            "gpu_uuid",
            "utilization",
            "vram_used_bytes",
            "temperature_c",
            "power_w",
          ],
          [
            [
              T0_ISO,
              "h1",
              "uuid-0",
              88, // percent
              3_221_225_472, // bytes
              57, // celsius
              199.5, // watts
            ],
          ]
        ),
      },
      [INFLUX_QUERIES.runtime]: { body: { results: [] } },
    });
    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });

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
    assert.equal(util.value, 88);
    assert.equal(util.source, "influxdb2");
    // Real sample time parsed from the `time` column (RFC3339 → epoch-ms).
    assert.equal(util.sampledAt, NOW - 5_000);
    assert.equal(util.basis, "field:utilization");
    assert.equal(util.windowMs, QUERY.windowMs);
    assert.equal(util.stale, undefined);

    assert.equal(row.vramUsedBytes?.value, 3_221_225_472);
    assert.equal(row.vramUsedBytes?.basis, "field:vram_used_bytes");
    assert.equal(row.temperatureC?.value, 57);
    assert.equal(row.powerWatts?.value, 199.5);
    assert.equal(row.vramTotalBytes, undefined); // column absent → field absent
  });

  it("drops rows without proven identity tags (host_id or gpu_uuid missing)", async () => {
    const { fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: {
        body: gpuPayload(
          ["time", "host_id", "gpu_uuid", "utilization"],
          [
            [T0_ISO, "h1", "uuid-0", 40], // valid
            [T0_ISO, undefined, "uuid-1", 41], // no host → dropped
            [T0_ISO, "h2", "", 42], // empty uuid → dropped
          ]
        ),
      },
      [INFLUX_QUERIES.runtime]: { body: { results: [] } },
    });
    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 1);
    assert.equal(snapshot.resources[0].resourceId, "gpu:h1:uuid-0");
    assert.equal(snapshot.resources[0].utilizationPercent?.value, 40);
  });

  it("drops rows whose values are all out-of-unit (a 150% utilization is unknown)", async () => {
    const { fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: {
        body: gpuPayload(
          ["time", "host_id", "gpu_uuid", "utilization"],
          [[T0_ISO, "h1", "uuid-0", 150]]
        ),
      },
      [INFLUX_QUERIES.runtime]: { body: { results: [] } },
    });
    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    // No valid value on the row → the whole row is an honest unknown (dropped).
    assert.equal(snapshot.resources.length, 0);
  });

  it("coerces string field values; marks stale samples (value kept)", async () => {
    const { fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: {
        body: gpuPayload(
          ["time", "host_id", "gpu_uuid", "utilization"],
          [[new Date(NOW - 120_000).toISOString(), "h1", "uuid-0", "65.25"]]
        ),
      },
      [INFLUX_QUERIES.runtime]: { body: { results: [] } },
    });
    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    const util = snapshot.resources[0].utilizationPercent;
    assert.ok(util);
    assert.equal(util.value, 65.25);
    assert.equal(util.stale, true); // 120s old > 30s freshness
  });
});

describe("influx provider: snapshot — runtime counter", () => {
  it("maps a runtime row with a gauge field (queued_jobs) and no fabricated throughput", async () => {
    const { fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: { body: { results: [] } },
      [INFLUX_QUERIES.runtime]: {
        body: {
          results: [
            {
              statementId: "_0",
              name: "runtime",
              series: [
                {
                  columns: ["time", "host_id", "runtime_id", "queued_jobs"],
                  values: [[T0_ISO, "h1", "rt-0", 3]],
                },
              ],
            },
          ],
        },
      },
    });
    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 1);
    const row = snapshot.resources[0];
    assert.equal(row.resourceId, "runtime:h1:rt-0");
    assert.equal(row.kind, "runtime");
    assert.equal(row.runtimeId, "rt-0");
    assert.equal(row.queuedJobs?.value, 3);
    assert.equal(row.queuedJobs?.basis, "field:queued_jobs");
    assert.equal(row.outputTokensPerSecond, undefined); // no counter column → no TPS
  });

  it("computes the token counter as a windowed rate from priorCounters", async () => {
    const priorCounters = new Map<string, number>([["runtime:h1:rt-0:output_tokens_total", 100]]);
    const { fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: { body: { results: [] } },
      [INFLUX_QUERIES.runtime]: {
        body: {
          results: [
            {
              statementId: "_0",
              name: "runtime",
              series: [
                {
                  columns: ["time", "host_id", "runtime_id", "output_tokens_total"],
                  values: [[T0_ISO, "h1", "rt-0", 700]],
                },
              ],
            },
          ],
        },
      },
    });
    const provider = createInfluxProvider({
      config: config(),
      fetchImpl,
      now: fixtureNow,
      priorCounters,
    });

    const snapshot = await provider.snapshot(QUERY);

    const tps = snapshot.resources[0].outputTokensPerSecond;
    assert.ok(tps);
    // (700 - 100) / (windowMs 60_000 / 1000 = 60s) = 10 tps.
    assert.equal(tps.value, 10);
    assert.equal(tps.source, "influxdb2");
    assert.equal(tps.basis, "counter:output_tokens_total");
    // The map is updated in place so the NEXT snapshot has a prior.
    assert.equal(priorCounters.get("runtime:h1:rt-0:output_tokens_total"), 700);
  });

  it("emits an UNKNOWN rate when there is no prior reading (never invented)", async () => {
    const { fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: { body: { results: [] } },
      [INFLUX_QUERIES.runtime]: {
        body: {
          results: [
            {
              statementId: "_0",
              name: "runtime",
              series: [
                {
                  columns: ["time", "host_id", "runtime_id", "output_tokens_total"],
                  values: [[T0_ISO, "h1", "rt-0", 700]],
                },
              ],
            },
          ],
        },
      },
    });
    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    const tps = snapshot.resources[0].outputTokensPerSecond;
    assert.ok(tps);
    assert.equal(tps.value, null);
  });

  it("treats a counter reset (value < prior) as unknown, never negative", async () => {
    const priorCounters = new Map<string, number>([["runtime:h1:rt-0:output_tokens_total", 1000]]);
    const { fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: { body: { results: [] } },
      [INFLUX_QUERIES.runtime]: {
        body: {
          results: [
            {
              statementId: "_0",
              name: "runtime",
              series: [
                {
                  columns: ["time", "host_id", "runtime_id", "output_tokens_total"],
                  values: [[T0_ISO, "h1", "rt-0", 400]],
                },
              ],
            },
          ],
        },
      },
    });
    const provider = createInfluxProvider({
      config: config(),
      fetchImpl,
      now: fixtureNow,
      priorCounters,
    });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources[0].outputTokensPerSecond?.value, null);
  });
});

describe("influx provider: snapshot — error handling", () => {
  it("a non-2xx flux response rejects the snapshot (category 'http')", async () => {
    const { fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: { ok: false, status: 500, body: {} },
      [INFLUX_QUERIES.runtime]: { body: { results: [] } },
    });
    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });

    await assert.rejects(
      () => provider.snapshot(QUERY),
      (err: unknown) => err instanceof FleetMetricsHttpError && err.category === "http"
    );
  });

  it("an aborted request propagates as category 'aborted'", async () => {
    const { fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: { body: { results: [] } },
      [INFLUX_QUERIES.runtime]: { body: { results: [] } },
    });
    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });
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
 * Mirrors the prometheus/grafana MiB→bytes assertions: with
 * `vramUnit: "mib"`, the two VRAM columns scale by 1048576 through the SAME
 * shared helper (`vramScaleFor` / `isVramMetric` in `metricMapping.ts`), not
 * a copy-pasted `* 1048576` in this file. Non-VRAM columns stay unscaled.
 */
describe("influx provider: snapshot — DCGM VRAM MiB→bytes scale (T5.6b1)", () => {
  it("vramUnit='mib' scales vram_used_bytes / vram_total_bytes columns by 1048576", async () => {
    const { fetchImpl } = makeFakeFetch({
      [INFLUX_QUERIES.gpu]: {
        body: gpuPayload(
          [
            "time",
            "host_id",
            "gpu_uuid",
            "utilization",
            "vram_used_bytes",
            "vram_total_bytes",
            "temperature_c",
            "power_w",
          ],
          [
            [
              T0_ISO,
              "h1",
              "uuid-0",
              73.5, // percent
              458, // MiB (production cluster's FB_USED)
              16025, // MiB (the card's 16 GB)
              61, // celsius
              220.25, // watts
            ],
          ]
        ),
      },
      [INFLUX_QUERIES.runtime]: { body: { results: [] } },
    });
    const provider = createInfluxProvider({
      config: config({ vramUnit: "mib" }),
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);
    const row = snapshot.resources.find((r) => r.resourceId === "gpu:h1:uuid-0");
    assert.ok(row);
    assert.equal(row.vramUsedBytes?.value, 458 * 1_048_576);
    assert.equal(row.vramUsedBytes?.value, 480_247_808);
    assert.equal(row.vramTotalBytes?.value, 16025 * 1_048_576);
    // The non-VRAM columns are NEVER scaled by the knob.
    assert.equal(row.utilizationPercent?.value, 73.5);
    assert.equal(row.temperatureC?.value, 61);
    assert.equal(row.powerWatts?.value, 220.25);
  });
});
