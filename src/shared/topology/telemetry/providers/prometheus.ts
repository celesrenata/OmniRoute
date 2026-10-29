/**
 * Fleet telemetry — Prometheus adapter (OR-ATOM-005 / Step 5).
 *
 * T5.0 found NO reachable Prometheus backend on this host, so this adapter is
 * OPT-IN: it registers only when `OMNIROUTE_FLEET_METRICS_SOURCE=prometheus`
 * and a valid `OMNIROUTE_FLEET_METRICS_URL` are configured. When disabled or
 * misconfigured, the native adapter still serves the endpoint.
 *
 * Queries are a NARROW, VERSION-CONTROLLED ALLOWLIST (no user-defined PromQL)
 * — the allowlist lives in `metricMapping.ts` so all three adapters agree:
 *   - DCGM GPU gauges: utilization / VRAM used+total / temp / power
 *   - runtime output tok/s: `vllm:generation_tokens_total` (Counter → rate)
 *     (NOT `vllm:gpu_prefix_cache_hits_total` — that metric is not in vLLM's
 *      documented set, and prefix-cache hits are not tokens/sec.)
 *
 * Identity rules (see `metricMapping.ts`):
 *   - a GPU row needs host + device-uuid labels (label KEYS are ASSUMED,
 *     operator-configurable defaults — verify against the real DCGM exporter);
 *   - runtime throughput is SERVER-LEVEL; it is emitted on a `runtime` row ONLY
 *     when a stable runtime-identity label is present. Without it the value is
 *     dropped (unknown) — it is NEVER pinned to a device or split across GPUs.
 *
 * SSRF defense: every request goes through `fleetMetricsFetch` (SSRF-safe).
 */

import { labelKeysFromConfig, type FleetMetricsConfig } from "../fleetMetricsConfig";
import {
  FleetMetricsHttpError,
  fleetMetricsFetch,
  readJson,
  type FetchLike,
} from "./fleetMetricsHttp";
import {
  allowlistedMetricNames,
  gpuIdentityFromLabels,
  isAcceptableSampleTime,
  mappingForMetric,
  observationFieldFor,
  runtimeIdentityFromLabels,
  scaleFieldValue,
  type CounterRateEngine,
  type MetricSample,
} from "./metricMapping";
import { counterRate, normalizeSample } from "./normalizeSample";
import {
  buildCanonicalResourceId,
  type FleetResourceObservation,
  type FleetTelemetryProvider,
  type FleetTelemetryQuery,
  type FleetTelemetrySnapshot,
  type Observed,
  type TelemetryProviderStatus,
} from "../types";

export interface PrometheusProviderOptions {
  config: FleetMetricsConfig;
  fetchImpl?: FetchLike;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Cross-snapshot counter state for windowed rates (tests inject a fresh one). */
  counterEngine?: CounterRateEngine;
}

/** Allowlist chokepoint: only version-controlled metric names are queried. */
function assertAllowlistedMetric(name: string): void {
  if (!mappingForMetric(name)) {
    throw new FleetMetricsHttpError("metric not on allowlist", "ssrf");
  }
}

/** Lowercase + trim a label map (label values are read back by resolved keys). */
function normalizeLabels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k.toLowerCase().trim()] = v.trim();
    }
  }
  return out;
}

function basisForMetric(name: string): string {
  // Provenance tag: single token naming the upstream metric (no credential shape).
  return name.replace(/[^a-z0-9:_-]/gi, "-");
}

function runtimeBasis(): string {
  return "vllm:generation-tokens-rate";
}

/**
 * Build the Prometheus adapter. Returns a `FleetTelemetryProvider` that
 * queries the allowlisted metrics via the Prometheus HTTP API v1.
 */
export function createPrometheusProvider(opts: PrometheusProviderOptions): FleetTelemetryProvider {
  const nowFn = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const counterEngine = opts.counterEngine ?? null;
  const config = opts.config;
  const source = "prometheus" as const;
  const freshnessMs = config.freshnessMs;
  const labelKeys = labelKeysFromConfig(config);

  return {
    id: "prometheus",
    kind: "prometheus",
    async probe(signal?: AbortSignal): Promise<TelemetryProviderStatus> {
      try {
        const res = await fleetMetricsFetch({
          baseUrl: config.url,
          path: "/-/ready",
          method: "GET",
          config,
          kind: "prometheus",
          fetchImpl,
          signal,
        });
        if (!res.ok) {
          return { available: false, checkedAt: nowFn(), message: `status ${res.status}` };
        }
        return { available: true, checkedAt: nowFn() };
      } catch (err) {
        const msg = err instanceof FleetMetricsHttpError ? err.category : "probe failed";
        return { available: false, checkedAt: nowFn(), message: msg };
      }
    },
    async snapshot(
      query: FleetTelemetryQuery,
      signal?: AbortSignal
    ): Promise<FleetTelemetrySnapshot> {
      const capturedAt = nowFn();
      const rows = new Map<string, FleetResourceObservation>();

      for (const metricName of allowlistedMetricNames()) {
        assertAllowlistedMetric(metricName);
        const mapping = mappingForMetric(metricName);
        if (!mapping) continue;

        let series: PrometheusSeries[];
        try {
          const res = await fleetMetricsFetch({
            baseUrl: config.url,
            path: `/api/v1/query?query=${encodeURIComponent(`${metricName}{}`)}`,
            method: "GET",
            config,
            kind: "prometheus",
            fetchImpl,
            signal,
          });
          if (!res.ok) continue; // one metric failing must not poison the snapshot
          const body = await readJson<{ data?: { result?: PrometheusSeries[] } }>(res);
          series = Array.isArray(body.data?.result) ? body.data.result : [];
        } catch (err) {
          if (err instanceof FleetMetricsHttpError && err.category === "aborted") throw err;
          continue;
        }

        for (const s of series) {
          const value = Number.parseFloat(s.value?.[1]);
          if (!Number.isFinite(value)) continue;
          const labels = normalizeLabels(s.metric);
          // Prometheus instant-query tuples are [seconds, "value"]; parse the
          // real sample time (never substitute capturedAt — that fakes freshness).
          const sampleTs = Number.parseFloat(s.value?.[0]);
          const sample: MetricSample = {
            metric: metricName,
            value,
            sampledAt: Number.isFinite(sampleTs) ? sampleTs * 1000 : capturedAt,
            labels,
          };
          applyPrometheusSample({
            sample,
            mapping,
            config,
            source,
            capturedAt,
            freshnessMs,
            queryWindowMs: query.windowMs,
            labelKeys,
            counterEngine,
            rows,
          });
        }
      }

      return {
        schemaVersion: 1,
        capturedAt,
        resources: [...rows.values()].slice(0, 512),
      };
    },
  };
}

/** One Prometheus instant-query series. */
export interface PrometheusSeries {
  metric: Record<string, string>;
  /** [seconds, "value"] — value is a string. */
  value: [string, string];
}

interface SampleApplyArgs {
  sample: MetricSample;
  mapping: ReturnType<typeof mappingForMetric> & object;
  config: FleetMetricsConfig;
  source: "prometheus";
  capturedAt: number;
  freshnessMs: number;
  queryWindowMs: number;
  labelKeys: ReturnType<typeof labelKeysFromConfig>;
  counterEngine: CounterRateEngine | null;
  rows: Map<string, FleetResourceObservation>;
}

/**
 * Turn one allowlisted sample into a schema row, honoring identity + rate
 * semantics. GPU facts need a device id; runtime throughput needs a runtime id
 * (else dropped as unknown). Counter resets / first reads yield unknown.
 */
function applyPrometheusSample(args: SampleApplyArgs): void {
  const { sample, mapping, config, source, capturedAt, freshnessMs, queryWindowMs, labelKeys } =
    args;
  if (mapping === null) return;
  const { field, unit } = observationFieldFor(mapping);
  // The single scaling decision point (metricMapping.ts) all three adapters
  // route through: DCGM VRAM gauges are MiB on the stock exporter → bytes
  // ONLY when vramUnit="mib"; the macmon scaled ratio (0..1) → 0..100
  // (out-of-range → null, never clamped). Everything else passes through.
  // A null scaling (out-of-range macmon ratio) is reported as UNKNOWN with
  // provenance by normalizeSample — never a fabricated/clamped gauge.
  const scaled = scaleFieldValue(sample.value, config.vramUnit, sample.metric);

  if (mapping.kind === "gpu") {
    const id = gpuIdentityFromLabels(sample.labels, labelKeys);
    if (!id) return; // no proven device identity → drop, never fabricate
    const key = buildCanonicalResourceId("gpu", id.deviceUuid, id.hostId);
    const obs = normalizeSample({
      value: scaled,
      source,
      sampledAt: isAcceptableSampleTime(sample.sampledAt, capturedAt)
        ? sample.sampledAt
        : capturedAt,
      capturedAt,
      windowMs: queryWindowMs,
      basis: basisForMetric(sample.metric),
      freshnessMs,
      unit,
    });
    upsert(args.rows, key, "gpu", id.hostId, { deviceUuid: id.deviceUuid, field, obs });
  } else {
    // runtime: SERVER-LEVEL. Needs a stable runtime identity to be attributable.
    const id = runtimeIdentityFromLabels(sample.labels, labelKeys);
    if (!id) return; // no runtime identity → unattributed → unknown (dropped)
    const key = buildCanonicalResourceId("runtime", id.runtimeId, id.hostId);
    let obs: Observed<number>;
    if (mapping.counter) {
      const counterEngine = args.counterEngine;
      if (!counterEngine) {
        // No cross-snapshot state → rate is unknown (never a fabricated value).
        obs = { value: null, source, sampledAt: capturedAt, basis: runtimeBasis() };
      } else {
        // Windowed rate over a REAL elapsed span. No prior reading / a counter
        // reset / too-far-apart → `readRate` returns null → unknown (null),
        // never a fabricated or negative rate.
        const reading = counterEngine.readRate(key, sample.value, capturedAt);
        obs = counterRate({
          value: sample.value,
          previous: reading?.previousValue,
          deltaSeconds: reading
            ? Math.max((reading.currentAtMs - reading.previousAtMs) / 1000, 0)
            : 0,
          sampledAt: capturedAt,
          capturedAt,
          windowMs: queryWindowMs,
          source,
          basis: runtimeBasis(),
          freshnessMs,
        });
      }
    } else {
      // Scheduler gauges are never VRAM-scaled, so `scaled === sample.value`;
      // routed through the same decision point so no adapter rescales on its own.
      obs = normalizeSample({
        value: scaled,
        source,
        sampledAt: capturedAt,
        capturedAt,
        windowMs: queryWindowMs,
        // Provenance: raw gauge sample → basis is the upstream metric name
        // (runtimeBasis() is reserved for the derived counter rate).
        basis: basisForMetric(sample.metric),
        freshnessMs,
        unit,
      });
    }
    upsert(args.rows, key, "runtime", id.hostId, { runtimeId: id.runtimeId, field, obs });
  }
}

/** Insert or merge a field into the row keyed by its canonical id. */
function upsert(
  rows: Map<string, FleetResourceObservation>,
  key: string,
  kind: "gpu" | "runtime",
  hostId: string,
  patch: {
    deviceUuid?: string;
    runtimeId?: string;
    field: keyof FleetResourceObservation;
    obs: Observed<number>;
  }
): void {
  let row = rows.get(key);
  if (!row) {
    row = {
      resourceId: key,
      kind,
      hostId,
    };
    rows.set(key, row);
  }
  if (patch.deviceUuid) row.deviceUuid = patch.deviceUuid;
  if (patch.runtimeId) row.runtimeId = patch.runtimeId;
  (row as unknown as Record<string, Observed<number>>)[patch.field] = patch.obs;
}
