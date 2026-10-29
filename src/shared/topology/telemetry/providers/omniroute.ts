/**
 * Fleet telemetry — the ONLY implemented adapter (T005 / M2, OR-ATOM-001 v2).
 *
 * M0 audit justification: no fleet backend exists anywhere in this repo
 * (zero Prometheus/InfluxDB2/Grafana/exporter/WireGuard config; wireguard
 * hits are proxy-protocol only, src/lib/proxySubscription/needsCore.ts:17-19).
 * So this adapter is the single backend, and it reads EXISTING in-repo
 * producers server-side only — no HTTP fan-out to hosts, no per-atom
 * queries:
 *
 *   producer                                   source (verified path:line)
 *   ----------------------------------------   -------------------------------------------
 *   provider connections / identity facts      provider_connections via
 *                                              src/lib/db/core.ts:220-265
 *   provider breaker state                     src/shared/utils/circuitBreaker.ts
 *                                              (CircuitBreakerStatus :204-216;
 *                                              getAllCircuitBreakerStatuses :761)
 *   in-flight active requests                  src/app/api/monitoring/health/route.ts:319-322
 *                                              (requestDedup.getInflightCount)
 *   queued limiter counts                      open-sse/services/rateLimitManager.ts:1050-1061
 *                                              (getAllRateLimitStatus → QUEUED)
 *   call-log token/duration facts              src/lib/usage/callLogs.ts:486 (getCallLogs)
 *   TTFT-excluded throughput helper            open-sse/utils/generationThroughput.ts:8-25
 *                                              (X-OmniRoute-Tokens-Per-Second,
 *                                              src/shared/constants/headers.ts:20)
 *
 * Normalization rules enforced here (and re-checked by the merge):
 * - token COUNTS are NEVER labeled tok/s. outputTokensPerSecond is only ever
 *   derived via generationDurationMs()/tokensPerSecond() (TTFT excluded),
 *   and ALWAYS carries windowMs + basis.
 * - queuedJobs/activeJobs come from real limiter/dedup counts, never
 *   invented.
 * - GPU fields are ALWAYS null with explicit "unavailable" semantics — no
 *   fabrication, no phantom devices.
 *
 * FUTURE_ADAPTERS (type-only note; intentionally NOT implemented — M0 found
 * none justified):
 *   - "prometheus"  → operator must deploy a Prometheus server with a fleet
 *                     target group + a GPU node exporter (dcgm-exporter) on
 *                     each host, then expose /api/v1/query_range to scrape.
 *   - "influxdb2"   → operator must deploy InfluxDB 2.x with a
 *                     telegraf/dcgm plugin writing gpu.* + runtime.*
 *                     measurements, then expose /api/v2/query (Flux).
 *   - "grafana"     → operator must deploy Grafana wired to a datasource
 *                     above; every proxied sample must then carry
 *                     source:"grafana" + basis:"datasource=prometheus:..."
 *                     (the Grafana-proxy rule in provenance.ts).
 *   - "runtime"     → operator must run an inference runtime exposing a
 *                     stable device/runtime identity (hostId + runtimeId,
 *                     never a bare PCI index) with queued/active jobs and
 *                     per-model throughput.
 *   Until each is deployed and provenance-audited, the corresponding Observed
 *   fields stay null with documented provenance — a feature, not a gap.
 */

import {
  buildCanonicalResourceId,
  type FleetTelemetryProvider,
  type FleetTelemetryQuery,
  type FleetTelemetrySnapshot,
  type FleetResourceObservation,
  type TelemetryProviderStatus,
} from "../types";
import { MAX_SNAPSHOT_RESOURCES, observedNumberValue } from "../provenance";
import {
  generationDurationMs,
  tokensPerSecond,
} from "@omniroute/open-sse/utils/generationThroughput";

/** GPU facts are unavailable from this backend (M0: no exporter exists). */
export const GPU_UNAVAILABLE_BASIS = "unavailable:no-gpu-exporter-in-repo";
/** Process-wide in-flight count is not per-provider; documented, not guessed. */
export const ACTIVE_JOBS_BASIS = "requestDedup:inflight-process-wide";
/** Queued jobs from the provider+connection rate limiter (QUEUED bucket). */
export const QUEUED_JOBS_BASIS = "rateLimitManager:counts.QUEUED";
/** Breaker states are discrete lifecycle facts, surfaced via basis. */
export type BreakerState = "CLOSED" | "DEGRADED" | "OPEN" | "HALF_OPEN" | "UNKNOWN";

const BREAKER_STATES: readonly string[] = ["CLOSED", "DEGRADED", "OPEN", "HALF_OPEN"];

/** Call-log rows needed for TTFT-excluded throughput (callLogs.ts:486). */
export interface OmnirouteCallLogRow {
  provider: string;
  model?: string | null;
  /** total call duration in ms (call_logs.duration) */
  duration?: number | null;
  /** time-to-first-token in ms; null when unknown (typical non-streaming). */
  ttft?: number | null;
  /** output tokens (call_logs.tokens_out) — a COUNT, never tok/s. */
  tokensOut?: number | null;
}

/** Provider connection row (identity only — no credentials). */
export interface OmnirouteProviderConnectionRow {
  id: string;
  provider: string;
  /**
   * Raw `provider_specific_data` JSON string (OR-ATOM-009.2). Carried
   * opaquely; ONLY a validated `baseUrl` string may leave this module
   * (see `validatedBaseUrl`) — never any credential field.
   */
  providerSpecificData?: string;
}

/** Breaker status as emitted by getAllCircuitBreakerStatuses() (name+state). */
export interface OmnirouteBreakerStatus {
  name: string;
  state: string;
}

/** rateLimitManager.getAllRateLimitStatus() shape: "provider:connectionId". */
export type OmnirouteRateLimitStatusMap = Record<
  string,
  { queued: number; running: number; executing: number }
>;

/**
 * The in-repo producers the adapter reads. ALL are injectable so the unit
 * tests run from fixtures with NO live infrastructure (AC2).
 */
export interface OmnirouteProducers {
  /** e.g. src/lib/db/providers.getProviderConnections (identity only). */
  providerConnections: () => Promise<OmnirouteProviderConnectionRow[]>;
  /** e.g. src/shared/utils/circuitBreaker.getAllCircuitBreakerStatuses. */
  circuitBreakerStatuses: () => Promise<
    OmnirouteBreakerStatus[] | Record<string, { state: string }>
  >;
  /** e.g. open-sse rateLimitManager.getAllRateLimitStatus. */
  rateLimitStatus: () => Promise<OmnirouteRateLimitStatusMap>;
  /** Process-wide in-flight count (requestDedup.getInflightCount). */
  inflightRequestCount: () => Promise<number>;
  /** e.g. src/lib/usage/callLogs.getCallLogs — rows for the query window. */
  callLogRows: (windowMs: number) => Promise<OmnirouteCallLogRow[]>;
  /** Injectable clock (tests). */
  now?: () => number;
}

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Best observed per-call generation rate in the window: max of
 * tokensPerSecond(tokensOut, generationDurationMs(duration, ttft)) over the
 * rows where the TTFT-excluded duration is known. Returns null when no row
 * has a derivable duration — the field then stays null with documented
 * provenance instead of a fabricated number.
 */
function deriveWindowThroughput(rows: OmnirouteCallLogRow[]): {
  tps: number | null;
  basis: string;
} {
  let maxTps: number | null = null;
  let used = 0;
  for (const row of rows) {
    const duration = isFiniteNonNegative(row.duration) ? row.duration : null;
    const ttft = row.ttft == null || !Number.isFinite(row.ttft) ? null : (row.ttft as number);
    const generationMs = generationDurationMs(duration ?? 0, ttft);
    const tps =
      generationMs != null && isFiniteNonNegative(row.tokensOut)
        ? tokensPerSecond(row.tokensOut, generationMs)
        : null;
    if (tps != null && (maxTps == null || tps > maxTps)) {
      maxTps = tps;
      used += 1;
    }
  }
  return {
    tps: maxTps,
    basis: `call-logs:max-ttft-excluded:${used}of${rows.length}`,
  };
}

/**
 * Sum QUEUED counts of the limiters whose key equals or is prefixed by the
 * provider key ("provider:connectionId"). Returns 0 when the provider has no
 * limiter registered (0 is a real measurement, distinct from missing).
 */
function sumQueuedForProvider(status: OmnirouteRateLimitStatusMap, providerKey: string): number {
  const prefix = `${providerKey}:`;
  let queued = 0;
  for (const [key, counts] of Object.entries(status)) {
    if (key === providerKey || key.startsWith(prefix)) {
      if (isFiniteNonNegative(counts?.queued)) queued += counts.queued;
    }
  }
  return queued;
}

function parseBreakerState(raw: unknown): BreakerState {
  if (typeof raw !== "string") return "UNKNOWN";
  const normalized = raw.toUpperCase();
  return (BREAKER_STATES as readonly string[]).includes(normalized)
    ? (normalized as BreakerState)
    : "UNKNOWN";
}

/** Provider key from a connection row; null when unusable for canonical ids. */
function toProviderKey(row: OmnirouteProviderConnectionRow): string | null {
  if (typeof row.provider !== "string" || row.provider.trim() === "") return null;
  // Provider keys never contain ':' (Zod-validated in the provider catalog);
  // reject anything that would break the canonical id shape.
  return row.provider.includes(":") ? null : row.provider;
}

/**
 * Extract a validated JOIN-FACT base URL from raw `provider_specific_data`
 * (OR-ATOM-009.2). The DB column is a JSON blob that may also hold
 * credentials, so ONLY a top-level STRING `baseUrl` that parses as an
 * http(s) URL is returned. Any parse or validation failure → null (the
 * join fact stays absent — never guessed). No other field of the blob
 * ever leaves this module.
 */
export function validatedBaseUrl(providerSpecificData: string | undefined): string | null {
  if (typeof providerSpecificData !== "string" || providerSpecificData.trim() === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(providerSpecificData);
  } catch {
    return null; // malformed JSON → no join fact
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = (parsed as Record<string, unknown>).baseUrl;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null; // not a parseable URL → no join fact
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return raw;
}

/**
 * Build the OmniRoute-native provider. Every producer is injectable so the
 * unit tests run from fixtures with NO live infrastructure (AC2).
 */
export function buildOmnirouteTelemetryProvider(
  producers: OmnirouteProducers,
  opts: { id?: string } = {}
): FleetTelemetryProvider {
  const id = opts.id ?? "omniroute";
  const nowFn = producers.now ?? (() => Date.now());

  async function probe(signal?: AbortSignal): Promise<TelemetryProviderStatus> {
    if (signal?.aborted) {
      return { available: false, checkedAt: nowFn(), message: "aborted" };
    }
    try {
      await producers.providerConnections();
      return { available: true, checkedAt: nowFn() };
    } catch (err) {
      return {
        available: false,
        checkedAt: nowFn(),
        message: err instanceof Error ? err.message : "producer failed",
      };
    }
  }

  async function snapshot(
    query: FleetTelemetryQuery,
    signal?: AbortSignal
  ): Promise<FleetTelemetrySnapshot> {
    if (signal?.aborted) {
      throw new Error("omniroute snapshot aborted");
    }
    const capturedAt = nowFn();

    const [connections, breakers, rateLimits, inflight, rows] = await Promise.all([
      producers.providerConnections(),
      producers.circuitBreakerStatuses(),
      producers.rateLimitStatus(),
      producers.inflightRequestCount(),
      producers.callLogRows(query.windowMs),
    ]);

    // Normalize breaker state by provider key (accepts array or record form).
    const breakerByName = new Map<string, string>();
    if (Array.isArray(breakers)) {
      for (const b of breakers) {
        if (b && typeof b.name === "string" && typeof b.state === "string") {
          breakerByName.set(b.name, b.state);
        }
      }
    } else if (breakers && typeof breakers === "object") {
      for (const [name, s] of Object.entries(breakers)) {
        if (s && typeof s.state === "string") breakerByName.set(name, s.state);
      }
    }

    const inflightCount = isFiniteNonNegative(inflight) ? Math.floor(inflight) : 0;

    const resources: FleetResourceObservation[] = [];
    const seen = new Set<string>();

    for (const row of connections) {
      const providerKey = toProviderKey(row);
      if (
        providerKey == null ||
        seen.has(providerKey) ||
        resources.length >= MAX_SNAPSHOT_RESOURCES
      ) {
        continue;
      }
      seen.add(providerKey);

      const resource: FleetResourceObservation = {
        resourceId: buildCanonicalResourceId("provider", providerKey),
        kind: "provider",
        providerId: providerKey,
      };

      // Join fact only (OR-ATOM-009.2): the configured upstream base URL,
      // validated (http/https, parseable). Consumed solely to reconcile
      // proven provider→runtime edges — never displayed, never credentials.
      const baseUrl = validatedBaseUrl(row.providerSpecificData);
      if (baseUrl !== null) resource.baseUrl = baseUrl;

      // Active jobs: process-wide in-flight count (documented, not per-provider).
      resource.activeJobs = observedNumberValue(inflightCount, "omniroute-live", capturedAt, {
        basis: ACTIVE_JOBS_BASIS,
      });

      // Queued jobs: real limiter QUEUED counts for this provider key.
      resource.queuedJobs = observedNumberValue(
        sumQueuedForProvider(rateLimits, providerKey),
        "omniroute-live",
        capturedAt,
        { basis: QUEUED_JOBS_BASIS }
      );

      // Throughput: ONLY the TTFT-excluded derivation from call logs.
      const providerRows = rows.filter((r) => r.provider === providerKey);
      const derived = deriveWindowThroughput(providerRows);
      resource.outputTokensPerSecond = observedNumberValue(
        derived.tps,
        "omniroute-call-log",
        capturedAt,
        { windowMs: query.windowMs, basis: derived.basis }
      );

      // GPU fields: ALWAYS null + explicit unavailable semantics (no fabrication).
      for (const field of [
        "utilizationPercent",
        "vramUsedBytes",
        "vramTotalBytes",
        "temperatureC",
        "powerWatts",
      ] as const) {
        resource[field] = observedNumberValue(null, "derived", capturedAt, {
          basis: GPU_UNAVAILABLE_BASIS,
        });
      }

      // Discrete lifecycle fact (string) carried via basis — the snapshot
      // schema has no dedicated breaker field, and basis is the provenance
      // slot that can hold a bounded, non-PII tag.
      const breakerState = parseBreakerState(breakerByName.get(providerKey));
      if (breakerState !== "CLOSED" && breakerState !== "UNKNOWN") {
        resource.activeJobs.basis = `${ACTIVE_JOBS_BASIS};breakers:${breakerState.toLowerCase()}`;
      }

      // modelId enrichment from call logs (stable fact, no PII).
      for (const r of providerRows) {
        if (r.model) {
          resource.modelId = r.model;
          break;
        }
      }

      resources.push(resource);
    }

    return { schemaVersion: 1, capturedAt, resources };
  }

  return { id, kind: "omniroute", probe, snapshot };
}

/**
 * Production wiring (server-side only). Uses the same in-repo producers the
 * monitoring health route uses — imported dynamically to avoid pulling the
 * DB into test bundles. Never returns credentials or raw bodies.
 */
export async function createProductionOmnirouteProvider(
  opts: { id?: string } = {}
): Promise<FleetTelemetryProvider> {
  const now = () => Date.now();
  const [cbModule, rlmModule, dedupModule, callLogsModule, providersModule] = await Promise.all([
    import("@/shared/utils/circuitBreaker"),
    import("@omniroute/open-sse/services/rateLimitManager"),
    import("@omniroute/open-sse/services/requestDedup.ts"),
    import("@/lib/usage/callLogs"),
    import("@/lib/db/providers"),
  ]);

  const producers: OmnirouteProducers = {
    now,
    providerConnections: async () => {
      const rows = (await providersModule.getProviderConnections()) as Array<
        Record<string, unknown>
      >;
      return rows.map((c) => ({
        id: typeof c.id === "string" ? c.id : String(c.id),
        provider: typeof c.provider === "string" ? c.provider : String(c.provider),
        // Only the opaque JSON string rides through — credential columns
        // (api_key, access_token, …) are never mapped (OR-ATOM-009.2).
        ...(typeof c.provider_specific_data === "string"
          ? { providerSpecificData: c.provider_specific_data }
          : {}),
      }));
    },
    circuitBreakerStatuses: async () => {
      const statuses = cbModule.getAllCircuitBreakerStatuses();
      return statuses.map((b) => ({ name: b.name, state: b.state }));
    },
    rateLimitStatus: async () => rlmModule.getAllRateLimitStatus(),
    inflightRequestCount: async () => dedupModule.getInflightCount(),
    callLogRows: async (windowMs) => {
      const raw = (await callLogsModule.getCallLogs({ limit: 500 })) as Array<
        Record<string, unknown>
      >;
      const since = now() - windowMs;
      return raw
        .filter((l) => typeof l.timestamp === "string" && Date.parse(l.timestamp) >= since)
        .map((l) => {
          const tokens = l.tokens as Record<string, unknown> | undefined;
          return {
            provider: typeof l.provider === "string" ? l.provider : String(l.provider),
            model: typeof l.model === "string" ? l.model : null,
            duration: typeof l.duration === "number" ? l.duration : null,
            ttft: typeof l.ttft === "number" ? l.ttft : null,
            tokensOut: tokens && typeof tokens.out === "number" ? (tokens.out as number) : null,
          };
        });
    },
  };
  return buildOmnirouteTelemetryProvider(producers, opts);
}
