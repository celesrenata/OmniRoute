/**
 * Fleet telemetry — snapshot merge (T005 / M2, OR-ATOM-001 v2).
 *
 * Joins resources ONLY via their stable canonical `resourceId`
 * (`gpu:<host>:<uuid>`, `runtime:<host>:<id>`, `provider:<key>`).
 * Never display-name matching, never a bare PCI index (`GPU 0`) as sole
 * identity. Device metrics (future exporter) vs inference metrics (runtime)
 * vs OmniRoute lifecycle facts only land on the same resource row when the
 * IDs prove association; otherwise fields stay absent (or null with
 * documented provenance) — no phantom devices, no cross-wired metrics.
 */

import { MAX_SNAPSHOT_RESOURCES, isFutureSampled, resourceSchema } from "./provenance";
import type {
  FleetResourceObservation,
  FleetTelemetryQuery,
  FleetTelemetrySnapshot,
  Observed,
} from "./types";

export const STALE_FACTOR_DEFAULT = 3;

export interface MergeOptions {
  /** Max resources in the merged snapshot (default MAX_SNAPSHOT_RESOURCES). */
  maxResources?: number;
  /** Age beyond factor * windowMs marks a field stale (default 3). */
  staleFactor?: number;
}

export interface MergeResult {
  snapshot: FleetTelemetrySnapshot;
  /** True when the resource cap dropped rows (deterministic: sorted by id). */
  truncated: boolean;
  /** Resources dropped by schema validation. */
  droppedInvalid: number;
  /** Snapshots dropped because some field was sampled AFTER capturedAt. */
  droppedFuture: number;
  /** Rows dropped because the same canonical id carried two different kinds. */
  droppedConflicts: number;
}

const OBSERVED_FIELDS = [
  "outputTokensPerSecond",
  "queuedJobs",
  "activeJobs",
  "utilizationPercent",
  "vramUsedBytes",
  "vramTotalBytes",
  "temperatureC",
  "powerWatts",
] as const;

type ObservedField = (typeof OBSERVED_FIELDS)[number];

/**
 * Typed setter for observed fields on a resource. Casts through the
 * ObservedField-keyed view so the assignment stays type-safe without a raw
 * Record<string, unknown> (interfaces lack a string index signature).
 */
function setObservedField(
  target: FleetResourceObservation,
  field: ObservedField,
  value: Observed<number>
): void {
  const mutable = target as unknown as Record<ObservedField, Observed<number> | undefined>;
  mutable[field] = value;
}

/** True when the observed field is stale at `now` (age > factor * windowMs). */
export function isStale(
  observed: Observed<number>,
  now: number,
  factor = STALE_FACTOR_DEFAULT
): boolean {
  if (observed.stale) return true;
  if (observed.windowMs == null) return false; // interval unknown → never stale
  if (!Number.isFinite(observed.sampledAt) || !Number.isFinite(now)) return false;
  const age = now - observed.sampledAt;
  return age > factor * observed.windowMs;
}

/**
 * Decay-to-neutral: stale fields keep their provenance but their value
 * becomes `null`, so a consumer reading the snapshot sees "was measured,
 * now neutral/unknown" instead of acting on a stale number. Non-stale
 * fields are untouched. The returned snapshot is a new object.
 */
export function neutralizeStale(
  snapshot: FleetTelemetrySnapshot,
  now = snapshot.capturedAt
): FleetTelemetrySnapshot {
  return {
    ...snapshot,
    resources: snapshot.resources.map((r) => {
      const next: FleetResourceObservation = { ...r };
      for (const f of OBSERVED_FIELDS) {
        const o = next[f];
        if (o && isStale(o, now)) {
          setObservedField(next, f, { ...o, value: null, stale: true });
        }
      }
      return next;
    }),
  };
}

/**
 * Pick the winner for one observed field across snapshots.
 * Rule: latest `sampledAt` wins; on ties the EARLIER snapshot in the input
 * array wins (deterministic). Both null → first seen.
 */
function pickLatest(
  current: Observed<number> | undefined,
  incoming: Observed<number> | undefined
): Observed<number> | undefined {
  if (current === undefined) return incoming;
  if (incoming === undefined) return current;
  if (incoming.sampledAt > current.sampledAt) return incoming;
  return current;
}

function snapshotHasFutureSamples(snapshot: FleetTelemetrySnapshot, capturedAt: number): boolean {
  for (const r of snapshot.resources) {
    for (const f of OBSERVED_FIELDS) {
      const o = r[f];
      if (o && isFutureSampled(o.sampledAt, capturedAt)) return true;
    }
  }
  return false;
}

/**
 * Merge provider snapshots into ONE bounded snapshot.
 *
 * Steps (all documented + tested):
 * 1. drop whole snapshots with future samples (out-of-order rejection);
 * 2. validate every resource with the strict resource schema;
 * 3. join by canonical resourceId only — same id + different kind is a
 *    conflict and the rows are dropped (no phantom devices);
 * 4. per-field latest-sampledAt-wins merge;
 * 5. mark fields stale when age > staleFactor * windowMs;
 * 6. cap resources (sorted by resourceId, deterministic) and report
 *    truncation.
 */
export function mergeSnapshots(
  snapshots: FleetTelemetrySnapshot[],
  capturedAt: number,
  opts: MergeOptions = {}
): MergeResult {
  const maxResources = opts.maxResources ?? MAX_SNAPSHOT_RESOURCES;
  const staleFactor = opts.staleFactor ?? STALE_FACTOR_DEFAULT;
  if (!Number.isFinite(capturedAt)) {
    throw new Error("mergeSnapshots: capturedAt must be a finite number");
  }

  let droppedFuture = 0;
  const validSnapshots = snapshots.filter((s) => {
    if (s.schemaVersion !== 1 || !Number.isFinite(s.capturedAt)) return false;
    if (snapshotHasFutureSamples(s, capturedAt)) {
      droppedFuture += 1;
      return false;
    }
    return true;
  });

  let droppedInvalid = 0;
  let droppedConflicts = 0;
  const byId = new Map<string, FleetResourceObservation>();
  const kindsById = new Map<string, string>();

  for (const s of validSnapshots) {
    for (const r of s.resources) {
      if (!resourceSchema.safeParse(r).success) {
        droppedInvalid += 1;
        continue;
      }
      const prevKind = kindsById.get(r.resourceId);
      if (prevKind != null && prevKind !== r.kind) {
        // Same canonical id, different kind → unprovable association.
        byId.delete(r.resourceId);
        droppedConflicts += 1;
        continue;
      }
      kindsById.set(r.resourceId, r.kind);
      const prev = byId.get(r.resourceId);
      if (prev === undefined) {
        byId.set(r.resourceId, { ...r });
        continue;
      }
      const merged: FleetResourceObservation = { ...prev };
      for (const f of OBSERVED_FIELDS) {
        const w = pickLatest(prev[f], r[f]);
        if (w !== undefined) {
          setObservedField(merged, f, { ...w, stale: false });
        }
      }
      // Non-metric identity facts: fill gaps only, never overwrite.
      merged.hostId = prev.hostId ?? r.hostId;
      merged.deviceUuid = prev.deviceUuid ?? r.deviceUuid;
      merged.providerId = prev.providerId ?? r.providerId;
      merged.runtimeId = prev.runtimeId ?? r.runtimeId;
      merged.modelId = prev.modelId ?? r.modelId;
      byId.set(r.resourceId, merged);
    }
  }

  let truncated = false;
  let resources = [...byId.values()].sort((a, b) =>
    a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0
  );
  if (resources.length > maxResources) {
    resources = resources.slice(0, maxResources);
    truncated = true;
  }

  for (const r of resources) {
    for (const f of OBSERVED_FIELDS) {
      const o = r[f];
      if (o && isStale(o, capturedAt, staleFactor)) {
        setObservedField(r, f, { ...o, stale: true });
      }
    }
  }

  return {
    snapshot: { schemaVersion: 1, capturedAt, resources },
    truncated,
    droppedInvalid,
    droppedFuture,
    droppedConflicts,
  };
}

/**
 * Apply the query's resource filters AFTER merging.
 * - hostIds: only rows whose hostId matches survive (rows without hostId,
 *   e.g. provider rows, do NOT survive a host filter).
 * - gpuIds: only `gpu` rows whose canonical resourceId matches survive.
 * - providerIds are handled by the gateway (provider selection), not here.
 */
export function filterResourcesByQuery(
  resources: FleetResourceObservation[],
  query: Pick<FleetTelemetryQuery, "hostIds" | "gpuIds">
): FleetResourceObservation[] {
  const hostSet = query.hostIds?.length ? new Set(query.hostIds) : null;
  const gpuSet = query.gpuIds?.length ? new Set(query.gpuIds) : null;
  return resources.filter((r) => {
    if (hostSet != null) {
      return r.hostId != null && hostSet.has(r.hostId);
    }
    if (gpuSet != null) {
      return r.kind === "gpu" && gpuSet.has(r.resourceId);
    }
    return true;
  });
}
