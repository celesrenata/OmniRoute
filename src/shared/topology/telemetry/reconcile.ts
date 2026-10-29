/**
 * Fleet telemetry — runtime attribution & topology reconciliation
 * (OR-ATOM-005 / Step 5).
 *
 * Pure module: no DOM, no DB, no network. Given a merged
 * `FleetTelemetrySnapshot` (device-level + runtime-level + provider-level
 * facts) it emits a reconciliation that carries the GPU nodes and
 * provenance-carrying relationship tables needed to render the atomic
 * topology WITHOUT fabricating any association.
 *
 * Invariants (task data-semantics table):
 * - Canonical IDs exactly: `gpu:<host_id>:<device_uuid>`,
 *   `runtime:<host_id>:<runtime_id>`, `provider:<provider_id>` — built via
 *   `buildCanonicalResourceId`, never display labels / bare GPU index /
 *   guessed hostname / model name.
 * - GPU nodes ONLY for devices actually observed with a proven identity
 *   (deviceUuid). Cloud-only providers stay provider atoms.
 * - Explicit provenance-carrying relationship tables:
 *     provider→runtime, runtime→device(s), runtime→model(s).
 *   1:N and N:M are correct. If no reliable source establishes a
 *   relationship → the edge is absent (unattached), never guessed.
 * - TPS distribution: a runtime's TPS goes to a GPU ONLY when the runtime
 *   metric carries per-device attribution; NEVER an even split across
 *   GPUs. Unknown attribution → throughput stays at the runtime level.
 * - Zero vs unknown: a fresh explicit numeric measurement is a zero; a
 *   null/missing/stale sample is unknown and is never asserted.
 * - Dedup by canonical ID; stable identity across reorders.
 */

import { buildCanonicalResourceId, type FleetTelemetrySnapshot, type Observed } from "./types";

/** A provenance-carrying relationship edge. */
export interface ReconciliationEdge {
  /** Canonical source id. */
  source: string;
  /** Canonical target id. */
  target: string;
  /** Relationship kind. */
  relation: "provider_runtime" | "runtime_device" | "runtime_model";
  /** How the association was established (provenance tag). */
  basis: string;
  /** When the association was last observed. */
  sampledAt: number;
}

/** A GPU node with its observed (or unknown) facts. */
export interface ReconciledGpuNode {
  resourceId: string;
  hostId: string;
  deviceUuid: string;
  utilizationPercent?: Observed<number>;
  vramUsedBytes?: Observed<number>;
  vramTotalBytes?: Observed<number>;
  temperatureC?: Observed<number>;
  powerWatts?: Observed<number>;
  outputTokensPerSecond?: Observed<number>;
  stale: boolean;
}

/** A runtime node with its observed facts + device attribution. */
export interface ReconciledRuntimeNode {
  resourceId: string;
  hostId: string;
  runtimeId: string;
  modelId?: string;
  /** OR-ATOM-009.2 join fact: runtime metrics endpoint port (never displayed). */
  endpointPort?: number;
  outputTokensPerSecond?: Observed<number>;
  queuedJobs?: Observed<number>;
  activeJobs?: Observed<number>;
  /** GPUs this runtime is attributed to (only when per-device attribution exists). */
  attributedGpuIds: string[];
  stale: boolean;
}

/** A provider atom (unchanged — providers are never conflated with devices). */
export interface ReconciledProviderNode {
  resourceId: string;
  providerId: string;
  /** OR-ATOM-009.2 join fact: configured upstream base URL (never displayed). */
  baseUrl?: string;
  outputTokensPerSecond?: Observed<number>;
  queuedJobs?: Observed<number>;
  activeJobs?: Observed<number>;
  stale: boolean;
}

/** The reconciliation output — additive to the snapshot. */
export interface ReconciliationResult {
  schemaVersion: 1;
  capturedAt: number;
  gpuNodes: ReconciledGpuNode[];
  runtimeNodes: ReconciledRuntimeNode[];
  providerNodes: ReconciledProviderNode[];
  edges: ReconciliationEdge[];
  /** True when no GPU was observed at all (provider-centric fallback). */
  providerCentricFallback: boolean;
}

/**
 * Read the pre-computed stale flag. Staleness is computed upstream by
 * `mergeSnapshots.mergeSnapshots()` (age > 3 × windowMs → `stale: true`,
 * value decayed to `null` via `neutralizeStale`). Reconciliation receives
 * the merged snapshot, so it trusts the flag rather than re-deriving age.
 */
function isStaleObserved(o: Observed<number> | undefined): boolean {
  return o?.stale === true;
}

/**
 * Reconcile a merged fleet snapshot into GPU / runtime / provider nodes with
 * provenance-carrying relationships. Pure and deterministic.
 */
export function reconcileSnapshot(snapshot: FleetTelemetrySnapshot): ReconciliationResult {
  const capturedAt = snapshot.capturedAt;
  const gpus = new Map<string, ReconciledGpuNode>();
  const runtimes = new Map<string, ReconciledRuntimeNode>();
  const providers = new Map<string, ReconciledProviderNode>();
  const edges = new Map<string, ReconciliationEdge>();

  for (const r of snapshot.resources) {
    if (r.kind === "gpu") {
      const hostId = r.hostId;
      const uuid = r.deviceUuid;
      if (!hostId || !uuid) continue; // no proven identity → drop
      const id = r.resourceId;
      let node = gpus.get(id);
      if (!node) {
        node = {
          resourceId: id,
          hostId,
          deviceUuid: uuid,
          stale: false,
        };
        gpus.set(id, node);
      }
      // Copy observed fields (a present value, even zero, is carried).
      if (r.utilizationPercent !== undefined) node.utilizationPercent = r.utilizationPercent;
      if (r.vramUsedBytes !== undefined) node.vramUsedBytes = r.vramUsedBytes;
      if (r.vramTotalBytes !== undefined) node.vramTotalBytes = r.vramTotalBytes;
      if (r.temperatureC !== undefined) node.temperatureC = r.temperatureC;
      if (r.powerWatts !== undefined) node.powerWatts = r.powerWatts;
      if (r.outputTokensPerSecond !== undefined)
        node.outputTokensPerSecond = r.outputTokensPerSecond;
      if (
        isStaleObserved(r.utilizationPercent) ||
        isStaleObserved(r.vramUsedBytes) ||
        isStaleObserved(r.outputTokensPerSecond)
      ) {
        node.stale = true;
      }
    } else if (r.kind === "runtime") {
      const hostId = r.hostId;
      const runtimeId = r.runtimeId;
      if (!hostId || !runtimeId) continue;
      const id = r.resourceId;
      let node = runtimes.get(id);
      if (!node) {
        node = {
          resourceId: id,
          hostId,
          runtimeId,
          attributedGpuIds: [],
          stale: false,
        };
        runtimes.set(id, node);
      }
      if (r.modelId) node.modelId = r.modelId;
      if (r.endpointPort != null && node.endpointPort == null) node.endpointPort = r.endpointPort;
      if (r.outputTokensPerSecond !== undefined)
        node.outputTokensPerSecond = r.outputTokensPerSecond;
      if (r.queuedJobs !== undefined) node.queuedJobs = r.queuedJobs;
      if (r.activeJobs !== undefined) node.activeJobs = r.activeJobs;
      // Per-device attribution: a runtime sample may carry a deviceUuid fact
      // (only when the runtime metric itself attributes to a device).
      if (r.deviceUuid) {
        try {
          const gpuId = buildCanonicalResourceId("gpu", r.deviceUuid, hostId);
          if (!node.attributedGpuIds.includes(gpuId)) node.attributedGpuIds.push(gpuId);
        } catch {
          // invalid id → no attribution
        }
      }
      if (isStaleObserved(r.outputTokensPerSecond) || isStaleObserved(r.queuedJobs)) {
        node.stale = true;
      }
    } else if (r.kind === "provider") {
      const providerId = r.providerId;
      if (!providerId) continue;
      const id = r.resourceId;
      let node = providers.get(id);
      if (!node) {
        node = {
          resourceId: id,
          providerId,
          stale: false,
        };
        providers.set(id, node);
      }
      if (r.baseUrl != null && node.baseUrl == null) node.baseUrl = r.baseUrl;
      if (r.outputTokensPerSecond !== undefined)
        node.outputTokensPerSecond = r.outputTokensPerSecond;
      if (r.queuedJobs !== undefined) node.queuedJobs = r.queuedJobs;
      if (r.activeJobs !== undefined) node.activeJobs = r.activeJobs;
      if (isStaleObserved(r.outputTokensPerSecond) || isStaleObserved(r.queuedJobs)) {
        node.stale = true;
      }
    }
  }

  // Relationships: runtime→device only from explicit per-device attribution.
  for (const node of runtimes.values()) {
    for (const gpuId of node.attributedGpuIds) {
      const key = `runtime_device:${node.resourceId}->${gpuId}`;
      if (!edges.has(key)) {
        edges.set(key, {
          source: node.resourceId,
          target: gpuId,
          relation: "runtime_device",
          basis: "runtime per-device attribution",
          sampledAt: capturedAt,
        });
      }
    }
    // runtime→model: a runtime observed with a modelId.
    if (node.modelId) {
      const modelTarget = `model:${node.modelId}`;
      const key = `runtime_model:${node.resourceId}->${modelTarget}`;
      if (!edges.has(key)) {
        edges.set(key, {
          source: node.resourceId,
          target: modelTarget,
          relation: "runtime_model",
          basis: "runtime observed model residency",
          sampledAt: capturedAt,
        });
      }
    }
  }

  // provider→runtime relationships are established ONLY by an explicit source:
  // the configured upstream base URL of a provider atom, reconciled against a
  // runtime atom's proven host + observed metrics-endpoint port (OR-ATOM-009.2).
  // A port-less runtime never matches; an unparseable/IPv6 base URL is skipped.
  // Absent here means unattached — we never join by display name.
  for (const p of providers.values()) {
    if (p.baseUrl == null) continue; // no configured join fact → unattached
    let url: URL;
    try {
      url = new URL(p.baseUrl);
    } catch {
      continue; // invalid URL (validated upstream, but defensive) → unattached
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    // An IPv6 literal hostname is bracketed (`[a:b::1]`) and contains ':' —
    // matching it would need bracket-aware host equality, exactly the
    // guessing we refuse to do → unattached.
    if (url.hostname.includes(":")) continue;
    const urlHost = url.hostname;
    const urlPort =
      url.port !== "" ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
    if (!Number.isFinite(urlPort) || urlPort < 1 || urlPort > 65535) continue;
    for (const r of runtimes.values()) {
      if (r.endpointPort == null) continue; // port-less runtime never matches
      if (urlHost !== r.hostId || urlPort !== r.endpointPort) continue; // no guess
      const key = `provider_runtime:${p.resourceId}->${r.resourceId}`;
      if (!edges.has(key)) {
        edges.set(key, {
          source: p.resourceId,
          target: r.resourceId,
          relation: "provider_runtime",
          basis: "configured provider baseUrl host:port match",
          sampledAt: capturedAt,
        });
      }
    }
  }
  const gpuNodes = [...gpus.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
  const runtimeNodes = [...runtimes.values()].sort((a, b) =>
    a.resourceId.localeCompare(b.resourceId)
  );
  const providerNodes = [...providers.values()].sort((a, b) =>
    a.resourceId.localeCompare(b.resourceId)
  );
  const edgeList = [...edges.values()].sort((a, b) =>
    `${a.relation}|${a.source}|${a.target}`.localeCompare(`${b.relation}|${b.source}|${b.target}`)
  );

  return {
    schemaVersion: 1,
    capturedAt,
    gpuNodes,
    runtimeNodes,
    providerNodes,
    edges: edgeList,
    providerCentricFallback: gpuNodes.length === 0,
  };
}

/**
 * Track GPU presence across snapshots. A GPU absent from `n` consecutive
 * snapshots has its node facts dropped (it is gone); provider atoms are kept
 * regardless. Returns the updated presence map + the list of dropped GPU ids.
 */
export interface GpuPresenceState {
  /** gpu id → consecutive-miss count. */
  misses: Map<string, number>;
  /** gpu id → last-seen snapshot index (for ordering stability). */
  lastSeen: Map<string, number>;
}

export function createGpuPresenceState(): GpuPresenceState {
  return { misses: new Map(), lastSeen: new Map() };
}

/**
 * Update GPU presence after a snapshot. `gpuIds` are the GPUs observed in the
 * current snapshot. Returns the ids that have now been absent for
 * `threshold` consecutive snapshots and should be dropped.
 */
export function updateGpuPresence(
  state: GpuPresenceState,
  observedGpuIds: string[],
  threshold: number
): string[] {
  const observed = new Set(observedGpuIds);
  const dropped: string[] = [];
  // Reset counters for observed GPUs.
  for (const id of observed) {
    state.misses.set(id, 0);
    state.lastSeen.set(id, Date.now());
  }
  // Increment misses for previously-seen GPUs not in this snapshot.
  for (const id of state.misses.keys()) {
    if (!observed.has(id)) {
      const misses = (state.misses.get(id) ?? 0) + 1;
      state.misses.set(id, misses);
      if (misses >= threshold) {
        dropped.push(id);
      }
    }
  }
  // Clean up dropped entries.
  for (const id of dropped) {
    state.misses.delete(id);
    state.lastSeen.delete(id);
  }
  return dropped;
}
