/**
 * Fleet telemetry — InfluxDB 2 adapter (OR-ATOM-005 / Step 5).
 *
 * T5.0 found NO reachable InfluxDB backend on this host, so this adapter is
 * OPT-IN: it registers only when `OMNIROUTE_FLEET_METRICS_SOURCE=influxdb2`
 * and a valid `OMNIROUTE_FLEET_METRICS_URL` are configured. When disabled or
 * misconfigured, the native adapter still serves the endpoint.
 *
 * Queries are a NARROW, VERSION-CONTROLLED ALLOWLIST (no user-defined Flux):
 *   - gpu utilization: measurement `gpu`, field `utilization`
 *   - gpu VRAM: measurement `gpu`, fields `vram_used_bytes` / `vram_total_bytes`
 *   - gpu temp/power: measurement `gpu`, fields `temperature_c` / `power_w`
 *   - runtime output tok/s: measurement `runtime`, field `output_tokens_total` (counter → rate)
 *
 * Identity join key: `host_id` tag (host) + `gpu_uuid` tag (device) for gpu
 * measurements; `host_id` + `runtime_id` tags for runtime measurements.
 * A sample WITHOUT a stable identity tag is dropped.
 *
 * SSRF defense: every request goes through `fleetMetricsFetch` (SSRF-safe).
 * Flux queries are version-controlled constants — never user-supplied.
 */

import { type FleetMetricsConfig } from "../fleetMetricsConfig";
import {
  FleetMetricsHttpError,
  fleetMetricsFetch,
  httpStatusError,
  readJson,
  type FetchLike,
} from "./fleetMetricsHttp";
import { counterRate, normalizeSample } from "./normalizeSample";
import { isVramMetric, vramScaleFor } from "./metricMapping";
import {
  buildCanonicalResourceId,
  type FleetResourceObservation,
  type FleetTelemetryProvider,
  type FleetTelemetryQuery,
  type FleetTelemetrySnapshot,
  type Observed,
  type TelemetryProviderStatus,
} from "../types";

/** Allowlisted Flux — version-controlled, never user-defined. */
export const INFLUX_QUERIES = {
  gpu: `from(bucket: "gpu") |> range(start: -30m) |> group(columns: ["host_id", "gpu_uuid"])`,
  runtime: `from(bucket: "runtime") |> range(start: -30m) |> group(columns: ["host_id", "runtime_id"])`,
} as const;

const ALLOWLISTED = new Set<string>(Object.values(INFLUX_QUERIES));

export function assertAllowlistedQuery(query: string): void {
  if (!ALLOWLISTED.has(query)) {
    throw new FleetMetricsHttpError(`flux query not on allowlist`, "ssrf");
  }
}

export interface InfluxProviderOptions {
  config: FleetMetricsConfig;
  fetchImpl?: FetchLike;
  now?: () => number;
  priorCounters?: Map<string, number>;
}

export function createInfluxProvider(opts: InfluxProviderOptions): FleetTelemetryProvider {
  const nowFn = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const priorCounters = opts.priorCounters ?? new Map<string, number>();
  const config = opts.config;
  const freshnessMs = config.freshnessMs;

  return {
    id: "influxdb2",
    kind: "influxdb2",
    async probe(signal?: AbortSignal): Promise<TelemetryProviderStatus> {
      try {
        const res = await fleetMetricsFetch({
          baseUrl: config.url,
          path: "/api/v2/ping",
          method: "GET",
          config,
          kind: "influxdb2",
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
      const resources: FleetResourceObservation[] = [];
      const windowMs = query.windowMs;

      for (const [name, flux] of Object.entries(INFLUX_QUERIES)) {
        assertAllowlistedQuery(flux);
        try {
          const body = JSON.stringify({ query: flux });
          const res = await fleetMetricsFetch({
            baseUrl: config.url,
            path: "/api/v2/query",
            method: "POST",
            config,
            kind: "influxdb2",
            fetchImpl,
            signal,
            headers: { "Content-Type": "application/json" },
            body,
          });
          if (!res.ok) throw httpStatusError(res);
          const parsed = await readJson<InfluxQueryResponse>(res);
          // InfluxDB HTTP API v2 JSON: results[].series[] with `columns`
          // (field + tag names) and `values` (rows). Identity is carried by
          // tag COLUMNS (host_id / gpu_uuid / runtime_id), not the measurement
          // name — a row without them has no proven identity and is dropped.
          const results = parsed.results ?? [];
          for (const result of results) {
            for (const series of result.series ?? []) {
              const columns = series.columns ?? [];
              for (const row of series.values ?? []) {
                if (!Array.isArray(row)) continue;
                const resource =
                  name === "gpu"
                    ? rowToGpuResource(
                        row,
                        columns,
                        capturedAt,
                        windowMs,
                        freshnessMs,
                        config.vramUnit
                      )
                    : rowToRuntimeResource(
                        row,
                        columns,
                        capturedAt,
                        windowMs,
                        freshnessMs,
                        priorCounters
                      );
                if (resource) resources.push(resource);
              }
            }
          }
        } catch (err) {
          if (err instanceof FleetMetricsHttpError) throw err;
        }
      }

      return { schemaVersion: 1, capturedAt, resources };
    },
  };
}

/**
 * InfluxDB HTTP API v2 JSON response shape.
 *
 * A range query returns `results[].series[]`, each with:
 *   - `columns`: string[] — field/tag names in order
 *   - `values`:  unknown[][] — rows; each row is an array of column values
 *
 * Identity tags (host_id, gpu_uuid, runtime_id) are columns, not part of
 * the measurement name. Metric fields are separate columns.
 */
interface InfluxQueryResponse {
  results?: Array<{
    series?: Array<{
      name?: string;
      columns?: string[];
      values?: unknown[][];
    }>;
  }>;
}

/** GPU metric field columns → ObservedField mapping. */
const GPU_FIELDS: ReadonlyArray<[col: string, field: ObservedField, unit: ObservedUnit]> = [
  ["utilization", "utilizationPercent", "percent"],
  ["vram_used_bytes", "vramUsedBytes", "bytes"],
  ["vram_total_bytes", "vramTotalBytes", "bytes"],
  ["temperature_c", "temperatureC", "celsius"],
  ["power_w", "powerWatts", "watts"],
];

type ObservedField =
  "utilizationPercent" | "vramUsedBytes" | "vramTotalBytes" | "temperatureC" | "powerWatts";

type ObservedUnit = "percent" | "bytes" | "celsius" | "watts" | "nonNegative";

/** Extract a string tag value from a row by column name. */
function rowTag(row: unknown[], columns: string[], col: string): string | undefined {
  const idx = columns.indexOf(col);
  if (idx < 0) return undefined;
  const v = row[idx];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Extract a numeric field value from a row by column name. */
function rowValue(row: unknown[], columns: string[], col: string): number | null {
  const idx = columns.indexOf(col);
  if (idx < 0) return null;
  const v = row[idx];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Extract the sample timestamp from a row (first column "time"). */
function rowTime(row: unknown[], columns: string[], capturedAt: number): number {
  const idx = columns.indexOf("time");
  if (idx >= 0) {
    const v = row[idx];
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return capturedAt;
}

/** Build one GPU observation from a single InfluxDB row. Returns null when
 * identity tags are missing or no metric column is present. */
function rowToGpuResource(
  row: unknown[],
  columns: string[],
  capturedAt: number,
  windowMs: number | undefined,
  freshnessMs: number,
  vramUnit: "bytes" | "mib"
): FleetResourceObservation | null {
  const hostId = rowTag(row, columns, "host_id");
  const uuid = rowTag(row, columns, "gpu_uuid");
  if (!hostId || !uuid) return null; // no proven identity → drop (honest unknown)
  let resourceId: string;
  try {
    resourceId = buildCanonicalResourceId("gpu", uuid, hostId);
  } catch {
    return null;
  }
  const resource: FleetResourceObservation = {
    resourceId,
    kind: "gpu",
    hostId,
    deviceUuid: uuid,
  };
  const sampledAt = rowTime(row, columns, capturedAt);
  let hasValue = false;
  for (const [col, field, unit] of GPU_FIELDS) {
    const raw = rowValue(row, columns, col);
    if (raw === null) continue;
    // T5.6b1: the DCGM VRAM columns are MiB on the stock exporter; scale to
    // bytes ONLY when vramUnit="mib", via the shared helper (metricMapping.ts)
    // so all three adapters agree. Non-VRAM columns are never scaled.
    const value = isVramMetric(col) ? raw * vramScaleFor(vramUnit) : raw;
    const observed = normalizeSample({
      value,
      source: "influxdb2",
      sampledAt,
      capturedAt,
      windowMs,
      basis: `field:${col}`,
      freshnessMs,
      unit,
    });
    setResourceField(resource, field, observed);
    if (observed.value !== null) hasValue = true;
  }
  return hasValue ? resource : null;
}

/** Build one runtime observation from a single InfluxDB row. */
function rowToRuntimeResource(
  row: unknown[],
  columns: string[],
  capturedAt: number,
  windowMs: number | undefined,
  freshnessMs: number,
  priorCounters: Map<string, number>
): FleetResourceObservation | null {
  const hostId = rowTag(row, columns, "host_id");
  const runtimeId = rowTag(row, columns, "runtime_id");
  if (!hostId || !runtimeId) return null;
  let resourceId: string;
  try {
    resourceId = buildCanonicalResourceId("runtime", runtimeId, hostId);
  } catch {
    return null;
  }
  const resource: FleetResourceObservation = {
    resourceId,
    kind: "runtime",
    hostId,
    runtimeId,
  };
  const sampledAt = rowTime(row, columns, capturedAt);

  // Counter: output_tokens_total → windowed rate.
  const counterVal = rowValue(row, columns, "output_tokens_total");
  if (counterVal !== null) {
    const key = `${resourceId}:output_tokens_total`;
    const prior = priorCounters.get(key);
    priorCounters.set(key, counterVal);
    resource.outputTokensPerSecond = counterRate({
      value: counterVal,
      previous: prior,
      deltaSeconds: windowMs ? windowMs / 1000 : 60,
      sampledAt,
      capturedAt,
      windowMs,
      source: "influxdb2",
      basis: "counter:output_tokens_total",
      freshnessMs,
    });
  }

  // Gauge: queued_jobs.
  const queuedVal = rowValue(row, columns, "queued_jobs");
  if (queuedVal !== null) {
    resource.queuedJobs = normalizeSample({
      value: queuedVal,
      source: "influxdb2",
      sampledAt,
      capturedAt,
      windowMs,
      basis: "field:queued_jobs",
      freshnessMs,
      unit: "nonNegative",
    });
  }

  // Gauge: active_jobs (vLLM scheduler running-request count).
  const activeVal = rowValue(row, columns, "active_jobs");
  if (activeVal !== null) {
    resource.activeJobs = normalizeSample({
      value: activeVal,
      source: "influxdb2",
      sampledAt,
      capturedAt,
      windowMs,
      basis: "field:active_jobs",
      freshnessMs,
      unit: "nonNegative",
    });
  }

  return resource.outputTokensPerSecond || resource.queuedJobs || resource.activeJobs
    ? resource
    : null;
}

function setResourceField(
  resource: FleetResourceObservation,
  field: ObservedField,
  observed: Observed<number>
): void {
  const mutable = resource as unknown as Record<string, Observed<number> | undefined>;
  mutable[field] = observed;
}
