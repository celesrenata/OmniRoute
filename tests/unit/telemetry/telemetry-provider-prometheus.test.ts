/**
 * Unit tests for the Prometheus fleet-telemetry adapter (OR-ATOM-005 / Step 5):
 * `createPrometheusProvider().snapshot(query)` / `.probe(signal)` driven through
 * the PUBLIC provider interface with an injected `fetchImpl` (fake HTTP) and the
 * injectable `now` clock. The private `applyPrometheusSample` is never imported —
 * only its observable effects on the snapshot are asserted.
 *
 * Deterministic + hermetic: fixed fixture clock, fake fetch, no network, no DB.
 *
 * Data semantics under test:
 *   - DCGM gauges map onto `gpu` rows ONLY with proven device identity
 *     (host + gpu_uuid labels); samples without it are dropped, never fabricated;
 *   - the vLLM counter maps onto a `runtime` row ONLY with a stable runtime
 *     identity; the windowed rate needs a prior reading — first read / counter
 *     reset → unknown (null), never negative or invented;
 *   - sample timestamps come from the wire (epoch-seconds → ms); future-dated
 *     samples fall back to capturedAt; samples older than the freshness window
 *     are marked stale (value kept);
 *   - unit guards apply (percent outside [0,100] → unknown, row still emitted);
 *   - one failing or malformed metric never poisons the snapshot; an abort does
 *     propagate (category "aborted");
 *   - exactly the 14 allowlisted metrics are queried (version-controlled set:
 *     5 DCGM gauges + vLLM counter + 2 vLLM scheduler gauges + 3 macmon gauges
 *     + 3 q27 runtime-counter aliases).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FleetMetricsConfig } from "../../../src/shared/topology/telemetry/fleetMetricsConfig";
import {
  FleetMetricsHttpError,
  type FetchLike,
} from "../../../src/shared/topology/telemetry/providers/fleetMetricsHttp";
import {
  ALLOWLISTED_METRIC_NAMES,
  createCounterRateEngine,
  mappingForMetric,
} from "../../../src/shared/topology/telemetry/providers/metricMapping";
import { createPrometheusProvider } from "../../../src/shared/topology/telemetry/providers/prometheus";
import type {
  FleetResourceObservation,
  FleetTelemetrySnapshot,
} from "../../../src/shared/topology/telemetry/types";
import { advanceFixtureClock, fixtureNow, resetFixtureClock } from "./telemetry-fixtures";

resetFixtureClock(1_700_000_000_000);
const NOW = fixtureNow();
const T0_SECONDS = NOW / 1000;

const QUERY = { windowMs: 60_000 };
const GPU_LABELS = { host: "h1", gpu_uuid: "uuid-0" };
const RUNTIME_LABELS = { host: "h1", runtime_id: "rt-0" };

function config(over: Record<string, unknown> = {}): FleetMetricsConfig {
  return {
    source: "prometheus",
    url: "http://127.0.0.1:9090",
    freshnessMs: 30_000,
    ...over,
  } as unknown as FleetMetricsConfig;
}

interface FakeResponseSpec {
  ok?: boolean;
  status?: number;
  /** Parsed JSON body (stringified before delivery). */
  body?: unknown;
  /** Raw body text, as-is (for malformed payloads). */
  raw?: string;
  /** Error thrown by the fake fetch (network failure). */
  error?: Error;
}

function series(
  labels: Record<string, string>,
  value: number | string,
  tsSeconds: number = T0_SECONDS
) {
  return [{ metric: labels, value: [String(tsSeconds), String(value)] }];
}

/**
 * Recording fake fetch: routes by the encoded metric name in the query path.
 * Unknown metrics default to a 404 (so a snapshot always "sees" all eleven).
 */
function makeFakeFetch(payloads: Record<string, FakeResponseSpec> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (init?.signal?.aborted) throw new Error("fetch aborted");
    const m = /api\/v1\/query\?query=(.*)$/.exec(url);
    const name = m ? decodeURIComponent(m[1]).replace(/\{\}$/, "") : "";
    const spec = payloads[name] ?? { ok: false, status: 404, body: {} };
    if (spec.error) throw spec.error;
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      text: async () => spec.raw ?? JSON.stringify(spec.body ?? {}),
    } as unknown as Response;
  };
  return { calls, fetchImpl };
}

/** A fake fetch whose body changes between snapshots (counter tests). */
/**
 * Counter-only fake, NAME-ROUTED (production-realistic): the live counter
 * series is answered ONLY for the vllm:generation_tokens_total name; every
 * other allowlisted name — including the 3 q27 aliases of the same field —
 * gets an empty result. An URL-ignoring fake would apply the counter field
 * once per alias name, and the second readRate at the same timestamp returns
 * null (no delta) and overwrites the computed rate.
 */
function mutableFetch(get: () => unknown) {
  const fetchImpl: FetchLike = async (url) => {
    const m = /api\/v1\/query\?query=(.*)$/.exec(url);
    const name = m ? decodeURIComponent(m[1]).replace(/\{\}$/, "") : "";
    const body = name === "vllm:generation_tokens_total" ? get() : { data: { result: [] } };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  };
  return { fetchImpl };
}

/** The DCGM gauges + the vLLM counter (a subset of the allowlist): one
 * series on the shared GPU each. */
function allMetrics(): Record<string, FakeResponseSpec> {
  return {
    DCGM_FI_DEV_GPU_UTIL: { body: { data: { result: series(GPU_LABELS, 73.5) } } },
    DCGM_FI_DEV_FB_USED: { body: { data: { result: series(GPU_LABELS, 2_147_483_648) } } },
    DCGM_FI_DEV_FB_TOTAL: { body: { data: { result: series(GPU_LABELS, 8_589_934_592) } } },
    DCGM_FI_DEV_GPU_TEMP: { body: { data: { result: series(GPU_LABELS, 61) } } },
    DCGM_FI_DEV_POWER_USAGE: { body: { data: { result: series(GPU_LABELS, 220.25) } } },
    "vllm:generation_tokens_total": { body: { data: { result: [] } } },
  };
}

/**
 * The five DCGM GPU gauges (no runtime counter). `empty` replaces the series
 * with a single identity-less series on each metric — for "nothing is
 * fabricated" tests where no metric may carry proven GPU identity.
 */
function gpuOnlyMetrics(empty = false): Record<string, FakeResponseSpec> {
  const m: Record<string, FakeResponseSpec> = { ...allMetrics() };
  delete m["vllm:generation_tokens_total"];
  if (empty) {
    for (const key of Object.keys(m)) {
      m[key] = {
        body: {
          data: { result: [{ metric: { host: "h1" }, value: [String(T0_SECONDS), "42"] }] },
        },
      };
    }
  }
  return m;
}

function findBy(
  snapshot: FleetTelemetrySnapshot,
  id: string
): FleetResourceObservation | undefined {
  return snapshot.resources.find((r) => r.resourceId === id);
}

describe("prometheus provider: probe", () => {
  it("is available when /-/ready answers 200", async () => {
    const fetchImpl: FetchLike = async () =>
      ({ ok: true, status: 200, text: async () => "" }) as unknown as Response;
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });
    const status = await provider.probe();
    assert.equal(provider.id, "prometheus");
    assert.equal(provider.kind, "prometheus");
    assert.deepEqual(status, { available: true, checkedAt: NOW });
  });

  it("is unavailable (with status) when /-/ready is non-2xx", async () => {
    const fetchImpl: FetchLike = async () =>
      ({ ok: false, status: 503, text: async () => "" }) as unknown as Response;
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });
    const status = await provider.probe();
    assert.equal(status.available, false);
    assert.equal(status.checkedAt, NOW);
    assert.equal(status.message, "status 503");
  });

  it("is unavailable with category 'ssrf' for a non-http base URL", async () => {
    const fetchImpl: FetchLike = async () =>
      ({ ok: true, status: 200, text: async () => "" }) as unknown as Response;
    const provider = createPrometheusProvider({
      config: config({ url: "file:///etc/passwd" }),
      fetchImpl,
      now: fixtureNow,
    });
    const status = await provider.probe();
    assert.equal(status.available, false);
    assert.equal(status.message, "ssrf");
  });
});

describe("prometheus provider: snapshot — GPU gauges", () => {
  it("queries exactly the fourteen allowlisted metrics, one bounded request each", async () => {
    const { calls, fetchImpl } = makeFakeFetch(allMetrics());
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    await provider.snapshot(QUERY);

    assert.equal(calls.length, 14);
    // Query shape: fixed path + encoded allowlisted metric (no user PromQL).
    assert.equal(
      calls[0].url,
      "http://127.0.0.1:9090/api/v1/query?query=DCGM_FI_DEV_GPU_UTIL%7B%7D"
    );
    const names = calls
      .map((c) =>
        decodeURIComponent(c.url)
          .replace(/.*query=/, "")
          .replace(/\{\}$/, "")
      )
      .sort();
    assert.deepEqual(names, [
      "DCGM_FI_DEV_FB_TOTAL",
      "DCGM_FI_DEV_FB_USED",
      "DCGM_FI_DEV_GPU_TEMP",
      "DCGM_FI_DEV_GPU_UTIL",
      "DCGM_FI_DEV_POWER_USAGE",
      "macmon_gpu_power_watts",
      "macmon_gpu_scaled_ratio",
      "macmon_gpu_temp_celsius",
      "q27:generation_tokens_total",
      "q27:num_requests_running",
      "q27:num_requests_waiting",
      "vllm:generation_tokens_total",
      "vllm:num_requests_running",
      "vllm:num_requests_waiting",
    ]);
  });

  it("maps all five DCGM gauges onto ONE gpu row with full provenance", async () => {
    const { fetchImpl } = makeFakeFetch(allMetrics());
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

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
    assert.equal(util.source, "prometheus");
    // Real wire sample time (epoch-seconds → ms), not a fake capturedAt.
    assert.equal(util.sampledAt, NOW);
    assert.equal(util.basis, "DCGM_FI_DEV_GPU_UTIL");
    assert.equal(util.windowMs, QUERY.windowMs);
    assert.equal(util.stale, undefined);

    assert.equal(row.vramUsedBytes?.value, 2_147_483_648);
    assert.equal(row.vramUsedBytes?.basis, "DCGM_FI_DEV_FB_USED");
    assert.equal(row.vramTotalBytes?.value, 8_589_934_592);
    assert.equal(row.temperatureC?.value, 61);
    assert.equal(row.powerWatts?.value, 220.25);
  });

  it("normalizes label keys (lowercase/trim) before reading identity", async () => {
    const payloads = allMetrics();
    payloads.DCGM_FI_DEV_GPU_UTIL = {
      body: {
        data: {
          result: [
            { metric: { HOST: " h1 ", GPU_UUID: " uuid-0 " }, value: [String(T0_SECONDS), "42"] },
          ],
        },
      },
    };
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 1);
    assert.equal(snapshot.resources[0].resourceId, "gpu:h1:uuid-0");
    assert.equal(snapshot.resources[0].utilizationPercent?.value, 42);
  });

  it("drops a sample WITHOUT proven device identity (never fabricated)", async () => {
    // Every GPU metric carries only a host label — no gpu_uuid anywhere.
    const payloads = gpuOnlyMetrics(true);
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 0);
  });

  it("drops a sample whose identity value contains an id-breaking char (colon)", async () => {
    // Every GPU metric carries an unusable gpu_uuid (colon breaks canonical ids).
    const payloads = gpuOnlyMetrics(true);
    payloads.DCGM_FI_DEV_GPU_UTIL = {
      body: {
        data: {
          result: [
            { metric: { host: "h1", gpu_uuid: "uuid:0" }, value: [String(T0_SECONDS), "42"] },
          ],
        },
      },
    };
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 0);
  });

  it("keeps the row but marks unknown (null) for an out-of-unit percent value", async () => {
    const payloads = allMetrics();
    payloads.DCGM_FI_DEV_GPU_UTIL = {
      body: { data: { result: series(GPU_LABELS, 150) } },
    };
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 1);
    const util = snapshot.resources[0].utilizationPercent;
    assert.ok(util);
    assert.equal(util.value, null); // >100% is not a valid measurement
  });

  it("marks samples older than the freshness window as stale (value kept)", async () => {
    const payloads = allMetrics();
    payloads.DCGM_FI_DEV_GPU_UTIL = {
      body: { data: { result: series(GPU_LABELS, 73.5, T0_SECONDS - 120) } }, // 120s old
    };
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    const util = snapshot.resources[0].utilizationPercent;
    assert.ok(util);
    assert.equal(util.value, 73.5); // stale ≠ unknown
    assert.equal(util.stale, true);
    assert.equal(util.sampledAt, NOW - 120_000);
  });

  it("falls back to capturedAt for future-dated samples (never stale)", async () => {
    const payloads = allMetrics();
    payloads.DCGM_FI_DEV_GPU_UTIL = {
      body: { data: { result: series(GPU_LABELS, 73.5, T0_SECONDS + 120) } },
    };
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    const util = snapshot.resources[0].utilizationPercent;
    assert.ok(util);
    assert.equal(util.value, 73.5);
    assert.equal(util.sampledAt, NOW);
    assert.equal(util.stale, undefined);
  });

  it("skips series whose value is not a finite number (no field fabricated)", async () => {
    const payloads = gpuOnlyMetrics();
    payloads.DCGM_FI_DEV_GPU_UTIL = {
      body: { data: { result: series(GPU_LABELS, "NaN") } },
    };
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    // The gpu row still exists (built from the other gauges), but the
    // non-numeric series contributed NO field — it was skipped, not coerced.
    assert.equal(snapshot.resources.length, 1);
    assert.equal(snapshot.resources[0].resourceId, "gpu:h1:uuid-0");
    assert.equal(snapshot.resources[0].utilizationPercent, undefined);
    assert.equal(snapshot.resources[0].temperatureC?.value, 61);
  });
});

describe("prometheus provider: snapshot — runtime counter (vLLM tokens/s)", () => {
  it("drops the counter WITHOUT a stable runtime identity (server-level fact)", async () => {
    // vLLM counter series carries only a host label — no runtime_id.
    const noId = allMetrics();
    noId["vllm:generation_tokens_total"] = {
      body: { data: { result: [{ metric: { host: "h1" }, value: [String(T0_SECONDS), "1000"] }] } },
    };
    const { fetchImpl: fetch2 } = makeFakeFetch(noId);
    const provider2 = createPrometheusProvider({
      config: config(),
      fetchImpl: fetch2,
      now: fixtureNow,
    });

    const snapshot = await provider2.snapshot(QUERY);

    // Only the gpu row survives — the server-level counter is NEVER pinned
    // to a device or emitted on a fabricated runtime row.
    assert.equal(snapshot.resources.length, 1);
    assert.equal(snapshot.resources[0].resourceId, "gpu:h1:uuid-0");
    assert.equal(findBy(snapshot, "runtime:h1:rt-0"), undefined);
  });

  it("emits an UNKNOWN rate (null) when no counter engine is injected — never invented", async () => {
    let value = 100;
    const get = () => ({
      data: { result: [{ metric: RUNTIME_LABELS, value: [String(T0_SECONDS), String(value)] }] },
    });
    const { fetchImpl } = mutableFetch(get);
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const first = await provider.snapshot(QUERY);
    value = 700;
    const second = await provider.snapshot(QUERY);

    const firstRow = findBy(first, "runtime:h1:rt-0");
    assert.ok(firstRow);
    assert.equal(firstRow.kind, "runtime");
    assert.equal(firstRow.runtimeId, "rt-0");
    assert.equal(firstRow.outputTokensPerSecond?.value, null);
    assert.equal(firstRow.outputTokensPerSecond?.source, "prometheus");
    assert.equal(firstRow.outputTokensPerSecond?.basis, "vllm:generation-tokens-rate");

    // Even with a prior reading, no engine → still unknown (no cross-snapshot state).
    const secondRow = findBy(second, "runtime:h1:rt-0");
    assert.ok(secondRow);
    assert.equal(secondRow.outputTokensPerSecond?.value, null);
  });

  it("computes a windowed rate across snapshots; first read and resets stay unknown", async () => {
    let value = 100;
    const get = () => ({
      data: { result: [{ metric: RUNTIME_LABELS, value: [String(T0_SECONDS), String(value)] }] },
    });
    const { fetchImpl } = mutableFetch(get);
    const engine = createCounterRateEngine();
    const provider = createPrometheusProvider({
      config: config(),
      fetchImpl,
      now: fixtureNow,
      counterEngine: engine,
    });

    // First read: no prior reading → unknown (never a fabricated rate).
    const first = await provider.snapshot(QUERY);
    assert.equal(findBy(first, "runtime:h1:rt-0")?.outputTokensPerSecond?.value, null);

    // 60s later, 100 → 700: 600 tokens / 60s = 10 tps.
    advanceFixtureClock(60_000);
    value = 700;
    const second = await provider.snapshot(QUERY);
    const rate = findBy(second, "runtime:h1:rt-0")?.outputTokensPerSecond;
    assert.ok(rate);
    assert.equal(rate.value, 10);
    assert.equal(rate.sampledAt, NOW + 60_000);
    assert.equal(rate.stale, undefined);

    // Counter reset (700 → 500) → unknown, never negative.
    advanceFixtureClock(60_000);
    value = 500;
    const third = await provider.snapshot(QUERY);
    assert.equal(findBy(third, "runtime:h1:rt-0")?.outputTokensPerSecond?.value, null);
  });
});

describe("prometheus provider: snapshot — error containment", () => {
  it("one failing metric (503) does not poison the rest of the snapshot", async () => {
    const payloads = allMetrics();
    payloads.DCGM_FI_DEV_FB_USED = { ok: false, status: 503, body: {} };
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 1);
    const row = snapshot.resources[0];
    assert.equal(row.utilizationPercent?.value, 73.5);
    assert.equal(row.vramUsedBytes, undefined); // the failing metric contributes nothing
    assert.equal(row.vramTotalBytes?.value, 8_589_934_592);
  });

  it("one malformed (non-JSON) metric does not poison the rest of the snapshot", async () => {
    const payloads = allMetrics();
    payloads.DCGM_FI_DEV_GPU_UTIL = { raw: "not json {" };
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 1);
    const row = snapshot.resources[0];
    assert.equal(row.utilizationPercent, undefined);
    assert.equal(row.vramUsedBytes?.value, 2_147_483_648);
  });

  it("an aborted request propagates as a FleetMetricsHttpError (category 'aborted')", async () => {
    const { fetchImpl } = makeFakeFetch(allMetrics());
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });
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
 *
 * The production dcgm-exporter reports `DCGM_FI_DEV_FB_USED` / `_FB_TOTAL` in
 * MiB (458 + 15567 MiB on the 16 GB RTX 4070 Ti SUPER), but the normalized
 * schema fields are BYTES. With `vramUnit: "mib"` the two VRAM gauges must be
 * scaled by 1048576 — and ONLY the two VRAM gauges (utilization / temp /
 * power / the vLLM counter are unscaled). The shared helper in
 * `metricMapping.ts` (`vramScaleFor` / `isVramMetric`) is the single decision
 * point all three adapters route through.
 */
describe("prometheus provider: snapshot — DCGM VRAM MiB→bytes scale (T5.6b1)", () => {
  it("vramUnit='mib' scales DCGM_FI_DEV_FB_USED and _FB_TOTAL by 1048576, leaves the rest unscaled", async () => {
    const payloads: Record<string, FakeResponseSpec> = {
      DCGM_FI_DEV_GPU_UTIL: { body: { data: { result: series(GPU_LABELS, 73.5) } } },
      DCGM_FI_DEV_FB_USED: { body: { data: { result: series(GPU_LABELS, 458) } } },
      DCGM_FI_DEV_FB_TOTAL: { body: { data: { result: series(GPU_LABELS, 16025) } } },
      DCGM_FI_DEV_GPU_TEMP: { body: { data: { result: series(GPU_LABELS, 61) } } },
      DCGM_FI_DEV_POWER_USAGE: { body: { data: { result: series(GPU_LABELS, 220.25) } } },
      "vllm:generation_tokens_total": { body: { data: { result: [] } } },
    };
    const { fetchImpl } = makeFakeFetch(payloads);
    const provider = createPrometheusProvider({
      config: config({ vramUnit: "mib" }),
      fetchImpl,
      now: fixtureNow,
    });

    const snapshot = await provider.snapshot(QUERY);
    const row = snapshot.resources.find((r) => r.resourceId === "gpu:h1:uuid-0");
    assert.ok(row);

    // 458 MiB → 458 * 1048576 bytes (the production cluster's FB_USED).
    assert.equal(row.vramUsedBytes?.value, 458 * 1_048_576);
    assert.equal(row.vramUsedBytes?.value, 480_247_808);
    assert.equal(row.vramUsedBytes?.basis, "DCGM_FI_DEV_FB_USED");
    // 16025 MiB → 16025 * 1048576 bytes (the card's 16 GB).
    assert.equal(row.vramTotalBytes?.value, 16025 * 1_048_576);
    assert.equal(row.vramTotalBytes?.basis, "DCGM_FI_DEV_FB_TOTAL");
    // The non-VRAM gauges are NEVER scaled by the knob.
    assert.equal(row.utilizationPercent?.value, 73.5);
    assert.equal(row.temperatureC?.value, 61);
    assert.equal(row.powerWatts?.value, 220.25);
  });

  it("default (vramUnit unset) keeps the raw pass-through — byte fixtures unchanged", async () => {
    const { fetchImpl } = makeFakeFetch(allMetrics());
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);
    const row = snapshot.resources.find((r) => r.resourceId === "gpu:h1:uuid-0");
    assert.ok(row);
    assert.equal(row.vramUsedBytes?.value, 2_147_483_648);
    assert.equal(row.vramTotalBytes?.value, 8_589_934_592);
  });
});

describe("prometheus provider: snapshot — scheduler gauges + macmon (name-keyed allowlist)", () => {
  it("maps the vLLM scheduler gauges onto ONE runtime row (queuedJobs / activeJobs)", async () => {
    const { fetchImpl } = makeFakeFetch({
      "vllm:num_requests_waiting": { body: { data: { result: series(RUNTIME_LABELS, 7) } } },
      "vllm:num_requests_running": { body: { data: { result: series(RUNTIME_LABELS, 11) } } },
    });
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 1);
    const row = findBy(snapshot, "runtime:h1:rt-0");
    assert.ok(row);
    assert.equal(row.kind, "runtime");
    assert.equal(row.hostId, "h1");
    assert.equal(row.runtimeId, "rt-0");
    assert.equal(row.queuedJobs?.value, 7);
    assert.equal(row.queuedJobs?.source, "prometheus");
    assert.equal(row.queuedJobs?.basis, "vllm:num_requests_waiting");
    assert.equal(row.activeJobs?.value, 11);
    assert.equal(row.activeJobs?.basis, "vllm:num_requests_running");
  });

  it("scales the macmon scaled ratio (0..1) to 0..100 percent on a gpu row (no VRAM)", async () => {
    const { fetchImpl } = makeFakeFetch({
      macmon_gpu_scaled_ratio: { body: { data: { result: series(GPU_LABELS, 0.5) } } },
    });
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    assert.equal(snapshot.resources.length, 1);
    const row = snapshot.resources[0];
    assert.equal(row.resourceId, "gpu:h1:uuid-0");
    assert.equal(row.utilizationPercent?.value, 50);
    assert.equal(row.utilizationPercent?.source, "prometheus");
    assert.equal(row.utilizationPercent?.basis, "macmon_gpu_scaled_ratio");
    // macmon exposes NO discrete VRAM — absent, never a fabricated zero.
    assert.equal(row.vramUsedBytes, undefined);
    assert.equal(row.vramTotalBytes, undefined);
  });

  it("reports an out-of-range macmon ratio as UNKNOWN (never clamped, never fabricated)", async () => {
    const { fetchImpl } = makeFakeFetch({
      macmon_gpu_scaled_ratio: { body: { data: { result: series(GPU_LABELS, 1.5) } } },
    });
    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });

    const snapshot = await provider.snapshot(QUERY);

    const row = snapshot.resources[0];
    assert.ok(row);
    assert.equal(row.resourceId, "gpu:h1:uuid-0");
    assert.equal(row.utilizationPercent?.value, null);
    assert.equal(row.utilizationPercent?.source, "prometheus");
    assert.equal(row.utilizationPercent?.basis, "macmon_gpu_scaled_ratio");
  });

  it("allowlist is name-keyed: DCGM + macmon + q27 collisions survive (all 14 names resolve)", () => {
    // Regression guard for the old field-keyed Map: the macmon entries shared
    // the gpu_util / gpu_temperature_c / gpu_power_w fields with DCGM, and a
    // field-keyed map silently dropped the DCGM names (5 of 11 never queried);
    // the same guard now covers the 3 q27 runtime-counter aliases (14 total).
    assert.equal(ALLOWLISTED_METRIC_NAMES.size, 14);
    assert.deepEqual([...ALLOWLISTED_METRIC_NAMES.keys()].sort(), [
      "DCGM_FI_DEV_FB_TOTAL",
      "DCGM_FI_DEV_FB_USED",
      "DCGM_FI_DEV_GPU_TEMP",
      "DCGM_FI_DEV_GPU_UTIL",
      "DCGM_FI_DEV_POWER_USAGE",
      "macmon_gpu_power_watts",
      "macmon_gpu_scaled_ratio",
      "macmon_gpu_temp_celsius",
      "q27:generation_tokens_total",
      "q27:num_requests_running",
      "q27:num_requests_waiting",
      "vllm:generation_tokens_total",
      "vllm:num_requests_running",
      "vllm:num_requests_waiting",
    ]);
    assert.equal(
      mappingForMetric("q27:generation_tokens_total")?.field,
      "runtime_output_tokens_total"
    );
    assert.equal(mappingForMetric("DCGM_FI_DEV_GPU_UTIL")?.field, "gpu_util");
    assert.equal(mappingForMetric("macmon_gpu_scaled_ratio")?.field, "gpu_util");
    assert.equal(mappingForMetric("vllm:num_requests_waiting")?.field, "runtime_scheduler_waiting");
    assert.equal(mappingForMetric("vllm:num_requests_running")?.field, "runtime_scheduler_running");
    assert.equal(mappingForMetric("not_a_metric"), null);
  });
});
