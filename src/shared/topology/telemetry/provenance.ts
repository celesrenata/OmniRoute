/**
 * Fleet telemetry — provenance helpers (T005 / M2, OR-ATOM-001 v2).
 *
 * Every observed field must carry `source` + `sampledAt`, plus `windowMs`
 * when the sampling interval is known and `basis` describing how the value
 * was produced. This module provides the builder + the Zod schemas used by
 * the gateway and adapters to REJECT (drop) samples that violate the
 * provenance contract instead of letting them poison a snapshot.
 */

import { z } from "zod";

import type {
  FleetResourceObservation,
  FleetTelemetrySnapshot,
  FleetTelemetryQuery,
  Observed,
  ObservedSource,
} from "./types";

/**
 * Grafana-proxy rule: when a sample is served through a Grafana datasource
 * proxy its provenance must name the underlying datasource, i.e.
 * `source: "grafana"` together with `basis: "datasource=prometheus:..."`
 * (or another datasource prefix). The schema below enforces the prefix and
 * the merge path re-checks it.
 */
export const GRAFANA_PROXY_BASIS_PREFIX = "datasource=";

const BASIS_FORBIDDEN = /(password|api[_-]?key|secret|bearer|authorization)/i;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyId(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.trim() === v;
}

function isBasis(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) return false;
  if (/\s/.test(v)) return false; // single token-ish tag, no whitespace
  if (BASIS_FORBIDDEN.test(v)) return false; // never credential-shaped
  return true;
}

/** Finite number, any value (including 0 — zero is a real measurement). */
export const finiteNumber = z.number().finite();

export const MIN_QUERY_WINDOW_MS = 1;
export const MAX_QUERY_WINDOW_MS = 777_600_000; // 9 days

const OBSERVED_SOURCES = [
  "omniroute-live",
  "omniroute-call-log",
  "runtime",
  "prometheus",
  "influxdb2",
  "grafana",
  "derived",
] as const;

/**
 * One observed field. Rejects (drops the whole field when `dropInvalid`
 * applies upstream):
 * - NaN / Infinity / non-number values
 * - missing or non-finite `sampledAt`
 * - `windowMs` present but not a finite number > 0
 * - `basis` that is empty, over-long, whitespace-containing, or
 *   credential-shaped (no PII / no keys in labels)
 * - the Grafana-proxy rule violation: `source: "grafana"` without
 *   `basis` starting with `datasource=`
 */
export const observedSchema = z
  .object({
    value: z.union([finiteNumber, z.null()]),
    source: z.enum(OBSERVED_SOURCES),
    sampledAt: z.number().finite(),
    windowMs: z
      .number()
      .finite()
      .refine((n) => n > 0, { message: "windowMs must be > 0" })
      .optional(),
    stale: z.boolean().optional(),
    basis: z.string().refine(isBasis, { message: "invalid basis" }).optional(),
  })
  .refine(
    (o) =>
      o.source !== "grafana" ||
      (typeof o.basis === "string" && o.basis.startsWith(GRAFANA_PROXY_BASIS_PREFIX)),
    { message: "grafana source requires basis starting with 'datasource='" }
  );

const observedNumber = z.custom<Observed<number>>(
  (v): v is Observed<number> => observedSchema.safeParse(v).success,
  { message: "invalid Observed<number> field" }
);

function boundedPercent(v: Observed<number> | undefined): v is Observed<number> {
  if (v === undefined) return true;
  return v.value === null || (v.value >= 0 && v.value <= 100);
}

function nonNegative(v: Observed<number> | undefined): v is Observed<number> {
  if (v === undefined) return true;
  return v.value === null || v.value >= 0;
}

/**
 * Strict resource schema. Unknown keys are rejected (`.strict()`), so a
 * provider emitting a typo'd field is dropped rather than silently carried.
 */
export const resourceSchema = z
  .object({
    resourceId: z.string().refine(isNonEmptyId, { message: "invalid resourceId" }),
    kind: z.enum(["gpu", "runtime", "provider"]),
    hostId: z.string().refine(isNonEmptyId).optional(),
    deviceUuid: z.string().refine(isNonEmptyId).optional(),
    providerId: z.string().refine(isNonEmptyId).optional(),
    runtimeId: z.string().refine(isNonEmptyId).optional(),
    modelId: z.string().refine(isNonEmptyId).optional(),
    /** Provider JOIN FACT (OR-ATOM-009.2): configured upstream base URL.
     * Join-only — never displayed, never credentials (validated on write). */
    baseUrl: z.string().refine(isNonEmptyId).optional(),
    /** Runtime JOIN FACT (OR-ATOM-009.2): metrics endpoint port. Join-only. */
    endpointPort: z.number().int().positive().optional(),
    outputTokensPerSecond: observedNumber.optional(),
    queuedJobs: observedNumber.optional(),
    activeJobs: observedNumber.optional(),
    utilizationPercent: observedNumber.optional(),
    vramUsedBytes: observedNumber.optional(),
    vramTotalBytes: observedNumber.optional(),
    temperatureC: observedNumber.optional(),
    powerWatts: observedNumber.optional(),
  })
  .strict()
  .refine((r) => r.kind !== "gpu" || r.deviceUuid != null, {
    message: "gpu resources require deviceUuid",
  })
  .refine((r) => r.kind !== "runtime" || (r.hostId != null && r.runtimeId != null), {
    message: "runtime resources require hostId + runtimeId",
  })
  .refine((r) => r.kind !== "provider" || r.providerId != null, {
    message: "provider resources require providerId",
  })
  .refine((r) => boundedPercent(r.utilizationPercent), {
    message: "utilizationPercent must be within [0, 100]",
  })
  .refine((r) => nonNegative(r.queuedJobs), { message: "queuedJobs must be >= 0" })
  .refine((r) => nonNegative(r.activeJobs), { message: "activeJobs must be >= 0" })
  .refine((r) => nonNegative(r.outputTokensPerSecond), {
    message: "outputTokensPerSecond must be >= 0",
  });

/**
 * Snapshot schema. `capturedAt` must be a finite epoch-ms number. Resources
 * are capped by MAX_SNAPSHOT_RESOURCES at the gateway; this schema only
 * validates shape.
 */
export const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.number().finite(),
  resources: z.array(resourceSchema),
});

/**
 * Query schema. Id filters must be non-empty, non-padded ids; windowMs must
 * be a finite number within [MIN_QUERY_WINDOW_MS, MAX_QUERY_WINDOW_MS].
 */
export const querySchema = z
  .object({
    providerIds: z.array(z.string().refine(isNonEmptyId)).max(64).optional(),
    hostIds: z.array(z.string().refine(isNonEmptyId)).max(64).optional(),
    gpuIds: z.array(z.string().refine(isNonEmptyId)).max(256).optional(),
    windowMs: z
      .number()
      .finite()
      .refine((n) => n >= MIN_QUERY_WINDOW_MS && n <= MAX_QUERY_WINDOW_MS, {
        message: `windowMs must be within [${MIN_QUERY_WINDOW_MS}, ${MAX_QUERY_WINDOW_MS}]`,
      }),
  })
  .strict();

/** Hard cap on resources per merged snapshot (bounded result sizes). */
export const MAX_SNAPSHOT_RESOURCES = 512;

/**
 * Bounded clock-skew tolerance for future-stamped samples at snapshot merge
 * (OR-ATOM-005 T5.6c). Metrics backends run on a different machine than the
 * OmniRoute host: the Prometheus instant-query tuple carries the REAL wire
 * timestamp, which in the live k3s cluster runs ~20ms AHEAD of the host's
 * clock (NTP skew between the cluster node and the host). Small positive
 * skew is legitimate, not a spoofed timestamp. Tolerating it keeps the real
 * wire timestamp — samples are NEVER re-stamped with `capturedAt` (that
 * would fabricate freshness). 5s is generous without accepting real clock
 * faults (e.g. samples seconds ahead), which are still rejected.
 */
export const FUTURE_TOLERANCE_MS_DEFAULT = 5_000;

/**
 * True when `sampledAt` is after the snapshot's `capturedAt` by more than
 * `toleranceMs` (default 0 — strictly future only, backward compatible).
 */
export function isFutureSampled(sampledAt: number, capturedAt: number, toleranceMs = 0): boolean {
  return (
    isFiniteNumber(sampledAt) && isFiniteNumber(capturedAt) && sampledAt > capturedAt + toleranceMs
  );
}

/** Parse a raw provider snapshot, dropping the whole snapshot on failure. */
export function parseProviderSnapshot(
  raw: unknown
): { ok: true; snapshot: FleetTelemetrySnapshot } | { ok: false } {
  const r = snapshotSchema.safeParse(raw);
  return r.success ? { ok: true, snapshot: r.data } : { ok: false };
}

/** Parse a raw query, returning `null` when invalid (gateway rejects it). */
export function parseQuery(raw: unknown): FleetTelemetryQuery | null {
  const r = querySchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** True when the resource passes the strict resource schema. */
export function isValidResource(raw: unknown): raw is FleetResourceObservation {
  return resourceSchema.safeParse(raw).success;
}

/**
 * Build an `Observed` field with provenance. The adapter is responsible for
 * choosing the right `source`; this helper only guarantees the shape.
 */
export function observedNumberValue(
  value: number | null,
  source: ObservedSource,
  sampledAt: number,
  opts?: { windowMs?: number; stale?: boolean; basis?: string }
): Observed<number> {
  const out: Observed<number> = { value, source, sampledAt };
  if (opts?.windowMs != null) out.windowMs = opts.windowMs;
  if (opts?.stale != null) out.stale = opts.stale;
  if (opts?.basis != null) out.basis = opts.basis;
  return out;
}
