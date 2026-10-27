/**
 * Fleet telemetry — Grafana adapter (OR-ATOM-005 / Step 5).
 *
 * T5.0 found NO reachable Grafana backend on this host, so this adapter is
 * OPT-IN: it registers only when `OMNIROUTE_FLEET_METRICS_SOURCE=grafana` and a
 * valid `OMNIROUTE_FLEET_METRICS_URL` + datasource uid are configured. When
 * disabled or misconfigured, the native adapter still serves the endpoint.
 *
 * Uses the SERVER-SIDE datasource-query API (`POST /api/ds/query`) with a
 * server-side admin/service token. We DO NOT scrape dashboards. Every proxied
 * sample MUST carry `source: "grafana"` together with
 * `basis: "datasource=<type>:<uid>"` — the Grafana-proxy rule enforced by
 * `provenance.ts`. (The old draft had a `fieldToUnit` that cast its default
 * to `"percent"`; that mislabel is gone — units now come from the shared,
 * type-correct `metricMapping.ts` table.)
 *
 * Datasource type: this adapter targets a PROMETHEUS datasource (the T5.0
 * allowlist is DCGM + the vLLM counter, which exporters expose to Prometheus).
 * Other datasource types are rejected at registration (probe → unavailable)
 * rather than issuing an unverified Flux path — nothing is invented.
 *
 * Queries are a NARROW, VERSION-CONTROLLED ALLOWLIST (no user-defined PromQL)
 * shared with the prometheus adapter via `metricMapping.ts`. Frame parsing
 * follows the documented `ds/query` response: `results.<refId>.frames[]`, each
 * frame `data.values[0]` = time column, `data.values[1]` = value column, series
 * labels on the numeric field in `schema.fields[]`.
 *
 * Identity rules mirror `metricMapping.ts`: GPU facts need host + device-uuid
 * labels (ASSUMED, operator-configurable); runtime throughput is emitted on a
 * `runtime` row ONLY with a stable runtime-identity label — never pinned to or
 * split across GPUs.
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
  isVramMetric,
  mappingForMetric,
  observationFieldFor,
  runtimeIdentityFromLabels,
  vramScaleFor,
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

/** Only the Prometheus datasource is implemented (honest scope — see header). */
export const GRAFANA_DATASOURCE_TYPES = ["prometheus"] as const;
export type GrafanaDatasourceType = (typeof GRAFANA_DATASOURCE_TYPES)[number];

export interface GrafanaProviderOptions {
  config: FleetMetricsConfig;
  /** Datasource uid (from config.datasourceUid) — required by the proxy rule. */
  datasourceUid: string;
  /** Datasource type (defaults to "prometheus"; others are unsupported). */
  datasourceType?: GrafanaDatasourceType;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Cross-snapshot counter state for windowed rates. */
  counterEngine?: CounterRateEngine;
}

/** Parse a frame time cell (RFC3339 string, epoch-seconds, or epoch-ms). */
function parseFrameTime(v: unknown, capturedAt: number): number {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : capturedAt;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    // Grafana frames usually carry epoch-ms; a small value reads as seconds.
    return v > 1e12 ? v : v * 1000;
  }
  return capturedAt;
}

/** Find the numeric field (the value column) in a ds/query frame schema. */
function numericFieldOf(
  frame: GrafanaFrame
): { name: string; labels: Record<string, string> } | null {
  const fields = frame.schema?.fields;
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    if (f && f.type === "number") {
      const labels: Record<string, string> = {};
      if (f.labels && typeof f.labels === "object") {
        for (const [k, val] of Object.entries(f.labels as Record<string, unknown>)) {
          if (typeof val === "string") labels[k.toLowerCase().trim()] = val.trim();
        }
      }
      return { name: typeof f.name === "string" ? f.name : "", labels };
    }
  }
  return null;
}

/** Grafana ds/query frame (documented shape). */
interface GrafanaField {
  name?: string;
  type?: string;
  labels?: Record<string, unknown>;
}
interface GrafanaFrame {
  schema?: { name?: string; fields?: GrafanaField[] };
  data?: { values?: unknown[][] };
}
interface GrafanaQueryResult {
  frames?: GrafanaFrame[];
}

/**
 * Build the Grafana adapter. Returns a `FleetTelemetryProvider` that issues
 * allowlisted instant queries via the datasource-query API.
 */
export function createGrafanaProvider(opts: GrafanaProviderOptions): FleetTelemetryProvider {
  const nowFn = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const counterEngine = opts.counterEngine ?? null;
  const config = opts.config;
  const source = "grafana" as const;
  const freshnessMs = config.freshnessMs;
  const labelKeys = labelKeysFromConfig(config);
  const dsType: string = opts.datasourceType ?? "prometheus";
  const supported = (GRAFANA_DATASOURCE_TYPES as readonly string[]).includes(dsType);
  // Grafana-proxy provenance rule: basis MUST start with `datasource=`.
  const basis = `datasource=${dsType}:${opts.datasourceUid}`;

  return {
    id: "grafana",
    kind: "grafana",
    async probe(signal?: AbortSignal): Promise<TelemetryProviderStatus> {
      if (!supported) {
        return {
          available: false,
          checkedAt: nowFn(),
          message: `unsupported datasource type: ${dsType}`,
        };
      }
      try {
        const res = await fleetMetricsFetch({
          baseUrl: config.url,
          path: "/api/health",
          method: "GET",
          config,
          kind: "grafana",
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
        if (!mappingForMetric(metricName)) continue;
        const refId = `A`;
        const body = JSON.stringify({
          queries: [
            {
              refId,
              datasource: { uid: opts.datasourceUid },
              query: `${metricName}{}`,
              queryType: "instant",
            },
          ],
          from: "now-5m",
          to: "now",
        });

        let result: GrafanaQueryResult;
        try {
          const res = await fleetMetricsFetch({
            baseUrl: config.url,
            path: "/api/ds/query",
            method: "POST",
            config,
            kind: "grafana",
            fetchImpl,
            signal,
            body,
          });
          if (!res.ok) continue; // one metric failing must not poison the snapshot
          const parsed = await readJson<{ results?: Record<string, GrafanaQueryResult> }>(res);
          result = parsed.results?.[refId] ?? {};
        } catch (err) {
          if (err instanceof FleetMetricsHttpError && err.category === "aborted") throw err;
          continue;
        }

        const frames = Array.isArray(result.frames) ? result.frames : [];
        for (const frame of frames) {
          const numeric = numericFieldOf(frame);
          if (!numeric) continue;
          const values = frame.data?.values;
          if (!Array.isArray(values) || values.length < 2) continue;
          const timeCol = values[0];
          const valCol = values[1];
          if (!Array.isArray(timeCol) || !Array.isArray(valCol)) continue;

          for (let i = 0; i < valCol.length; i++) {
            const value = Number(valCol[i]);
            if (!Number.isFinite(value)) continue;
            const sampleTs = parseFrameTime(timeCol[i], capturedAt);
            const sample: MetricSample = {
              metric: metricName,
              value,
              sampledAt: isAcceptableSampleTime(sampleTs, capturedAt) ? sampleTs : capturedAt,
              labels: numeric.labels,
            };
            applyGrafanaSample({
              sample,
              metricName,
              config,
              source,
              capturedAt,
              freshnessMs,
              queryWindowMs: query.windowMs,
              labelKeys,
              counterEngine,
              rows,
              basis,
            });
          }
        }
      }

      return { schemaVersion: 1, capturedAt, resources: [...rows.values()].slice(0, 512) };
    },
  };
}

interface GrafanaSampleArgs {
  sample: MetricSample;
  metricName: string;
  config: FleetMetricsConfig;
  source: "grafana";
  capturedAt: number;
  freshnessMs: number;
  queryWindowMs: number;
  labelKeys: ReturnType<typeof labelKeysFromConfig>;
  counterEngine: CounterRateEngine | null;
  rows: Map<string, FleetResourceObservation>;
  /** Grafana-proxy basis (`datasource=<type>:<uid>`). */
  basis: string;
}

function applyGrafanaSample(args: GrafanaSampleArgs): void {
  const {
    sample,
    metricName,
    source,
    capturedAt,
    freshnessMs,
    queryWindowMs,
    labelKeys,
    rows,
    basis,
  } = args;
  const mapping = mappingForMetric(metricName);
  if (!mapping) return;
  const { field, unit } = observationFieldFor(mapping);
  // T5.6b1: DCGM VRAM gauges are MiB on the stock dcgm-exporter; scale to
  // bytes ONLY when the operator configured vramUnit="mib". The decision
  // lives in the shared helper (metricMapping.ts) so all three adapters agree;
  // non-VRAM gauges (util/temp/power) and the vLLM counter are never scaled.
  const value = isVramMetric(metricName)
    ? sample.value * vramScaleFor(args.config.vramUnit)
    : sample.value;

  if (mapping.kind === "gpu") {
    const id = gpuIdentityFromLabels(sample.labels, labelKeys);
    if (!id) return;
    const key = buildCanonicalResourceId("gpu", id.deviceUuid, id.hostId);
    const obs = normalizeSample({
      value,
      source,
      sampledAt: sample.sampledAt,
      capturedAt,
      windowMs: queryWindowMs,
      basis,
      freshnessMs,
      unit,
    });
    upsert(rows, key, "gpu", id.hostId, { deviceUuid: id.deviceUuid, field, obs });
  } else {
    const id = runtimeIdentityFromLabels(sample.labels, labelKeys);
    if (!id) return; // no runtime identity → unattributed → unknown (dropped)
    const key = buildCanonicalResourceId("runtime", id.runtimeId, id.hostId);
    let obs: Observed<number>;
    if (mapping.counter) {
      const reading = args.counterEngine
        ? args.counterEngine.readRate(key, sample.value, capturedAt)
        : null;
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
        basis,
        freshnessMs,
      });
    } else {
      obs = normalizeSample({
        value: sample.value,
        source,
        sampledAt: sample.sampledAt,
        capturedAt,
        windowMs: queryWindowMs,
        basis,
        freshnessMs,
        unit,
      });
    }
    upsert(rows, key, "runtime", id.hostId, { runtimeId: id.runtimeId, field, obs });
  }
}

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
    row = { resourceId: key, kind, hostId };
    rows.set(key, row);
  }
  if (patch.deviceUuid) row.deviceUuid = patch.deviceUuid;
  if (patch.runtimeId) row.runtimeId = patch.runtimeId;
  (row as unknown as Record<string, Observed<number>>)[patch.field] = patch.obs;
}
