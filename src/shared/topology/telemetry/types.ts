/**
 * Fleet telemetry gateway — shared contract types (T005 / M2, OR-ATOM-001 v2).
 *
 * This module is SERVER-side only. It defines one normalized snapshot shape
 * (`FleetTelemetrySnapshot`) that can carry device-level facts (future
 * exporters), runtime-level facts (inference runtimes), and OmniRoute-native
 * lifecycle facts (provider health, limiter counts, call-log-derived
 * throughput) WITHOUT any browser-to-host fan-out and WITHOUT per-atom
 * queries: the gateway issues one bounded query per registered provider.
 *
 * Grounding (M0 audit, verified path:line): no fleet backend exists anywhere
 * in this repo (no Prometheus/InfluxDB2/Grafana/exporter config; wireguard
 * hits are proxy-protocol only, src/lib/proxySubscription/needsCore.ts:17-19).
 * The ONLY adapter implemented is `providers/omniroute.ts`, which reads the
 * in-repo producers: provider_connections rows, circuit breaker states
 * (src/shared/utils/circuitBreaker.ts:130-137), limiter counts
 * (open-sse/services/rateLimitManager.ts:1050-1061), call-log facts
 * (src/lib/usage/callLogs.ts:486) and the TTFT-excluded throughput helper
 * (open-sse/utils/generationThroughput.ts:8-25).
 */

/** The telemetry backends a fleet snapshot can be sourced from. */
export type TelemetrySourceKind = "omniroute" | "prometheus" | "influxdb2" | "grafana" | "runtime";

/** A single registered telemetry backend (server-side). */
export interface FleetTelemetryProvider {
  id: string;
  kind: TelemetrySourceKind;
  /** Cheap liveness check; must not block or throw. */
  probe(signal?: AbortSignal): Promise<TelemetryProviderStatus>;
  /** One bounded snapshot for the given query; must respect the signal. */
  snapshot(query: FleetTelemetryQuery, signal?: AbortSignal): Promise<FleetTelemetrySnapshot>;
}

export interface TelemetryProviderStatus {
  available: boolean;
  checkedAt: number;
  message?: string;
}

/**
 * A bounded, server-side query. All id filters are OPTIONAL: when omitted the
 * gateway returns everything it holds (still capped by MAX_RESOURCES).
 *
 * Semantics (documented on purpose — this is where bugs would hide):
 * - `providerIds` filters which REGISTERED BACKENDS run (empty/omitted = all).
 * - `hostIds` filters resources by their `hostId` fact.
 * - `gpuIds` filters only `gpu` resources, matched against the canonical
 *   `gpu:<hostId>:<deviceUuid>` id. It never filters runtime/provider rows.
 */
export interface FleetTelemetryQuery {
  providerIds?: string[];
  hostIds?: string[];
  gpuIds?: string[];
  /** Observation window in milliseconds (must be finite and > 0). */
  windowMs: number;
}

/** One normalized, provenance-carrying observation of a numeric fact. */
export type ObservedSource =
  | "omniroute-live"
  | "omniroute-call-log"
  | "runtime"
  | "prometheus"
  | "influxdb2"
  | "grafana"
  | "derived";

export interface Observed<T> {
  /** The measured value. `null` means "observed as absent/unknown" — which is
   * strictly different from the field not existing on the resource (missing).
   * A literal `0` is a real measurement (e.g. 0 queued jobs) and is kept. */
  value: T | null;
  source: ObservedSource;
  /** Epoch ms when this particular sample was taken. */
  sampledAt: number;
  /** Sampling interval for this sample, when known. Drives the stale rule:
   * age > 3 * windowMs marks the field stale. */
  windowMs?: number;
  stale?: boolean;
  /** How the value was produced, e.g. `basis: "breakers:open"` or the
   * Grafana-proxy rule `basis: "datasource=prometheus:..."`. No PII here. */
  basis?: string;
}

/** A single resource observation inside a snapshot. */
export interface FleetResourceObservation {
  /** Canonical, stable id. GPU: `gpu:<hostId>:<deviceUuid>`; runtime:
   * `runtime:<hostId>:<runtimeId>`; provider: `provider:<providerKey>`.
   * Never a display name, never a bare PCI index (`GPU 0`) as sole identity. */
  resourceId: string;
  kind: "gpu" | "runtime" | "provider";
  hostId?: string;
  /** GPU serial/UUID fact — required when kind === "gpu". */
  deviceUuid?: string;
  /** Provider key fact — required when kind === "provider". */
  providerId?: string;
  /** Runtime identity — required when kind === "runtime". */
  runtimeId?: string;
  modelId?: string;
  /** ONLY throughput derived via the TTFT-excluded generationThroughput
   * helper, with windowMs + basis. Token COUNTS must never be placed here. */
  outputTokensPerSecond?: Observed<number>;
  queuedJobs?: Observed<number>;
  activeJobs?: Observed<number>;
  utilizationPercent?: Observed<number>;
  vramUsedBytes?: Observed<number>;
  vramTotalBytes?: Observed<number>;
  temperatureC?: Observed<number>;
  powerWatts?: Observed<number>;
}

/** The normalized output of the gateway: one bounded, mergeable snapshot. */
export interface FleetTelemetrySnapshot {
  schemaVersion: 1;
  /** Epoch ms the merged snapshot was captured. */
  capturedAt: number;
  resources: FleetResourceObservation[];
}

/** Canonical id shape: `kind[:host]:id` with single-colon segments. */
export const CANONICAL_ID_KINDS = ["gpu", "runtime", "provider"] as const;

export type CanonicalIdKind = (typeof CANONICAL_ID_KINDS)[number];

function hasForbiddenChars(s: string): boolean {
  return s.includes(":") || s.includes(" ") || s.includes("/");
}

/**
 * Build a canonical resource id from stable facts. This is the ONLY way
 * resource identity should be constructed; joins in `mergeSnapshots.ts`
 * compare these ids, never display names.
 *
 * - gpu: `gpu:<hostId>:<deviceUuid>` (deviceUuid is the stable device
 *   identity — never the PCI index)
 * - runtime: `runtime:<hostId>:<runtimeId>`
 * - provider: `provider:<providerKey>` (no host — the provider key is the
 *   stable identity of the OmniRoute backend itself)
 *
 * Throws on empty/malformed facts so identity mistakes fail loudly.
 */
export function buildCanonicalResourceId(kind: CanonicalIdKind, id: string, host?: string): string {
  if (typeof id !== "string" || id.trim() === "" || hasForbiddenChars(id)) {
    throw new Error(
      `buildCanonicalResourceId: invalid ${kind} id "${typeof id === "string" ? id : id}"`
    );
  }
  if (kind === "gpu" || kind === "runtime") {
    if (typeof host !== "string" || host.trim() === "" || hasForbiddenChars(host)) {
      throw new Error(`buildCanonicalResourceId: ${kind} ids require a stable hostId`);
    }
    return `${kind}:${host}:${id}`;
  }
  return `provider:${id}`;
}
