/**
 * Normalize the home-page topology inputs (provider entries, live active
 * requests, last/error providers) into a renderer-neutral
 * {@link TopologySceneSnapshot} (OR-ATOM-001 v2, T004 / M1).
 *
 * The mapping mirrors the visual state resolution of the legacy 2D topology
 * (`ProviderTopology2D` / original `ProviderTopology`):
 *   traffic precedence  active > traffic-error > last-used > idle
 *   health base state   error > healthy(active connection) > unknown
 * with alias matching via `isTopologyEntryInSet` and friendly labels via
 * `resolveTopologyNodeLabel` — both reused verbatim, so the snapshot carries
 * exactly the same state the legacy graph resolved.
 *
 * Invariants:
 * - Absent data is `null` / `undefined`, never `0`: a node with no observed
 *   in-flight traffic has no `activeRequests` observation at all (not
 *   `{ value: 0 }`), and `lastRoutedAt` / `latestErrorAt` are omitted when the
 *   input only carried an id (no timestamp exists in M1).
 * - Stable canonical IDs via `layoutIdentity` (`hub`, `provider:<id>`).
 * - M1 never emits `kind: "gpu"` — provider routes are not devices.
 */
import { AI_PROVIDERS } from "@/shared/constants/providers";

import {
  isTopologyEntryInSet,
  type TopologyActiveRequest,
} from "@/app/(dashboard)/home/topologyUtils";
import type { ReconciliationResult } from "@/shared/topology/telemetry/reconcile";
import { resolveTopologyNodeLabel } from "@/app/(dashboard)/home/topologyLabel";

import { HUB_NODE_ID, providerNodeId, providerRouteLinkId } from "./layoutIdentity";
import { deriveLaneForProvider } from "./lane";
import type {
  TopologyLifecycleEvent,
  TopologySceneLink,
  TopologySceneNode,
  TopologySceneSnapshot,
} from "./types";

type ProviderConfig = { color?: string; name?: string; textIcon?: string };

/**
 * Provider entry as consumed by the host. Mirrors `topologyUtils.TopologyEntry`
 * but keeps `id` optional (the host's entries may lack an id; it is only used
 * for click-through and never by the normalization itself).
 */
export interface TopologyProviderEntry {
  id?: string;
  provider: string;
  name?: string;
  status?: "active" | "error" | "idle";
  aliases?: string[];
  routeId?: string;
}

// ── M4 — bounded live-request lifecycle stream ───────────────────────────

/**
 * Upper bound on lifecycle events a single snapshot carries. The live feed is
 * unbounded by nature (every request starts and ends), so the snapshot keeps
 * only the newest transitions — old ones have already been consumed by the
 * renderer's discharge pipeline.
 */
export const MAX_LIFECYCLE_EVENTS = 256;

/**
 * The bounded set of lifecycle transitions the live feed can emit. Anything
 * else (e.g. streaming ticks) is not a lifecycle event the topology can
 * represent — it is dropped, never guessed.
 */
const LIFECYCLE_PHASES = new Set<string>(["started", "completed", "failed"]);

/** Lifecycle input as the host hands it in: one row per bounded event. */
export interface TopologyLifecycleInput {
  /** Lifecycle transition (`started` / `completed` / `failed`). */
  phase: string;
  /** Source request id; rows without one are untracked and dropped. */
  requestId?: string;
  /** Provider the request was addressed to (when the source carried one). */
  provider?: string;
  /** Model the request targeted (when the source carried one). */
  model?: string;
  /** Terminal outcome (`success` / `error` / `unknown`). */
  outcome?: string;
  /** Upstream error label, when present. */
  error?: string;
  /** Source event timestamp (epoch ms) — the event's provenance. */
  observedAt: number;
}

/**
 * Reduce a stream of bounded lifecycle events into snapshot-ready rows.
 *
 * Protection invariants (M4):
 * - **Bounded**: the input is trimmed to the last `maxEvents` rows, so the
 *   snapshot can never grow without limit.
 * - **Duplicate-safe**: events with the same (phase, requestId, observedAt)
 *   are collapsed — the same logical transition arriving twice (e.g. the
 *   welcome backlog replay plus the live delivery) becomes one observation.
 * - **Out-of-order-safe**: rows are sorted ascending by (observedAt, phase,
 *   requestId), so the snapshot is deterministic regardless of arrival order;
 *   the tie-break order makes ties reproducible.
 * - **Provenance-carrying**: every row keeps the source event's timestamp as
 *   `observedAt`; nothing is re-stamped with the snapshot capture time.
 * - **Immutable**: the returned array AND every row are frozen (all row
 *   fields are scalars), so renderers can hold the stream without ever
 *   mutating core-owned data.
 */
export function normalizeLifecycleEvents(
  input: TopologyLifecycleInput[] | null | undefined,
  maxEvents = MAX_LIFECYCLE_EVENTS
): TopologyLifecycleEvent[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const max =
    typeof maxEvents === "number" && Number.isFinite(maxEvents) && maxEvents > 0
      ? Math.floor(maxEvents)
      : MAX_LIFECYCLE_EVENTS;

  // 1. Keep only rows the topology can represent: a known phase, a stable
  //    request id, and a valid timestamp. Unknown phases and id-less rows are
  //    dropped, never coerced.
  const known = input.filter(
    (row): row is TopologyLifecycleInput =>
      !!row &&
      typeof row.requestId === "string" &&
      row.requestId.length > 0 &&
      typeof row.observedAt === "number" &&
      Number.isFinite(row.observedAt) &&
      LIFECYCLE_PHASES.has(row.phase)
  );

  // 2. Collapse duplicates: same (phase, requestId, observedAt) → one row.
  //    The dedupe key identifies the logical transition, so a replayed event
  //    (backlog + live) contributes exactly one observation.
  const seen = new Set<string>();
  const unique: TopologyLifecycleInput[] = [];
  for (const row of known) {
    const key = `${row.phase}:${row.requestId}:${row.observedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  // 3. Bounded: keep only the newest `max` events.
  const bounded = unique.slice(-max);

  // 4. Deterministic order: ascending by (observedAt, phase, requestId).
  //    `requestId` is optional on the input shape, but step 1's type guard
  //    already dropped every row with a missing/empty id — the assertions
  //    below are safe, not a coercion.
  bounded.sort((a, b) => {
    if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
    if (a.phase !== b.phase) return a.phase < b.phase ? -1 : 1;
    const left = a.requestId as string;
    const right = b.requestId as string;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  // 5. Map to the renderer-ready shape, freezing each row. The container
  //    array is frozen too: a frozen row set inside a mutable array could
  //    still be reordered or spliced by a renderer.
  const events = bounded.map((row) => {
    const event: TopologyLifecycleEvent = {
      phase: row.phase as TopologyLifecycleEvent["phase"],
      requestId: row.requestId as string,
      observedAt: row.observedAt,
    };
    if (row.provider) event.provider = row.provider;
    if (row.model) event.model = row.model;
    if (row.outcome === "success" || row.outcome === "error" || row.outcome === "unknown") {
      event.outcome = row.outcome;
    }
    if (row.error) event.error = row.error;
    return Object.freeze(event);
  });
  // `Object.freeze` returns a `readonly` array at the type level, but the
  // declared contract (and `TopologySceneSnapshot.lifecycle`) is the
  // mutable-shaped array; the freeze is still enforced at runtime.
  return Object.freeze(events) as TopologyLifecycleEvent[];
}

/** Inputs the host component has on hand (same shape the legacy view consumed). */
export interface TopologyNormalizeInput {
  /** Provider entries (provider / name / status / aliases / routeId). */
  providers: TopologyProviderEntry[];
  /** In-flight requests (provider + model; the set of providers is what matters). */
  activeRequests: Array<{ provider?: string; model?: string }>;
  /** Most recently routed provider id ("" when unknown). */
  lastProvider?: string;
  /** Provider id currently in an error state ("" when unknown). */
  errorProvider?: string;
  /**
   * Bounded live-request lifecycle events observed on the existing gated
   * live-requests feed (M4). `null` / `undefined` → no `lifecycle` field on
   * the snapshot (absent, never an empty claim). The normalization is pure
   * and deterministic for a given input + `capturedAt`; the event stream is
   * only *reduced* here — it is never generated.
   */
  lifecycleEvents?: TopologyLifecycleInput[] | null;
  /**
   * Optional fleet-telemetry reconciliation (OR-ATOM-005 / Step 5). When
   * present, carried verbatim (deep-frozen with the snapshot) onto the
   * `fleetTelemetry` field. Absent / `null` → no `fleetTelemetry` block on
   * the snapshot. The 2D ReactFlow renderer ignores the block; the 3D
   * atomic renderer consumes it to place GPU / runtime atoms.
   */
  reconciliation?: ReconciliationResult | null;
  /** Snapshot timestamp; defaults to `Date.now()`. */
  capturedAt?: number;
}

/** Lowercased set of provider ids that have at least one in-flight request. */
function buildActiveSet(activeRequests: Array<{ provider?: string }>): Set<string> {
  const set = new Set<string>();
  for (const request of activeRequests) {
    const provider = request.provider?.toLowerCase();
    if (provider) set.add(provider);
  }
  return set;
}

/**
 * Number of in-flight requests that identify this entry (provider id or alias).
 * `0` when none — callers must only surface a non-zero observation.
 */
function countActiveRequests(
  entry: { provider: string; aliases?: string[] },
  activeRequests: Array<{ provider?: string }>
): number {
  let count = 0;
  for (const request of activeRequests) {
    const key = request.provider?.toLowerCase();
    if (!key) continue;
    if (isTopologyEntryInSet(entry, new Set([key]))) count += 1;
  }
  return count;
}

/**
 * Collect the model ids of in-flight requests that identify this entry
 * (provider id or alias). Used to derive a job-lane observation from actual
 * traffic rather than fabricating one. Returns `[]` when the entry has no
 * in-flight requests with a model id — the caller skips the `lane` field
 * entirely in that case (absence, not "unknown").
 */
function collectInFlightModels(
  entry: { provider: string; aliases?: string[] },
  activeRequests: Array<{ provider?: string; model?: string }>
): string[] {
  const set = new Set<string>();
  for (const request of activeRequests) {
    const key = request.provider?.toLowerCase();
    if (!key) continue;
    if (!isTopologyEntryInSet(entry, new Set([key]))) continue;
    const model = request.model?.trim();
    if (model) set.add(model);
  }
  return Array.from(set);
}

function configName(providerId: string): string | undefined {
  return (AI_PROVIDERS as Record<string, ProviderConfig> | undefined)?.[providerId]?.name;
}

/**
 * Map the home-page topology inputs into a renderer-neutral snapshot.
 * Pure and deterministic for a given input + `capturedAt`.
 */
export function normalizeTopology(input: TopologyNormalizeInput): TopologySceneSnapshot {
  const capturedAt = input.capturedAt ?? Date.now();
  const providers = input.providers ?? [];
  const activeRequests = input.activeRequests ?? [];
  const lastProvider = (input.lastProvider ?? "").trim();
  const errorProvider = (input.errorProvider ?? "").trim();

  const activeSet = buildActiveSet(activeRequests);
  const lastSet = new Set<string>(lastProvider ? [lastProvider.toLowerCase()] : []);
  const errorSet = new Set<string>(errorProvider ? [errorProvider.toLowerCase()] : []);

  const nodes: TopologySceneNode[] = [];
  const links: TopologySceneLink[] = [];

  // Hub: the routing center. Traffic state reflects whether anything is in
  // flight right now; health is not applicable (unknown, never fabricated).
  const activeCount = activeSet.size;
  const hubNode: TopologySceneNode = {
    id: HUB_NODE_ID,
    kind: "hub",
    label: "OmniRoute",
    health: "unknown",
    traffic: activeCount > 0 ? "active" : "idle",
  };
  if (activeCount > 0) {
    hubNode.activeRequests = {
      value: activeCount,
      source: "live-event",
      sampledAt: capturedAt,
      basis: "in-flight provider set (WS live requests channel)",
    };
  }
  nodes.push(hubNode);

  for (const entry of providers) {
    if (!entry || !entry.provider) continue;
    const providerId = entry.provider;

    // Same state resolution the legacy view used (active > traffic-error >
    // last-used; connection health is the base state under that).
    const active = isTopologyEntryInSet(entry, activeSet);
    const trafficError = !active && isTopologyEntryInSet(entry, errorSet);
    const last = !active && !trafficError && isTopologyEntryInSet(entry, lastSet);

    // Connection health is the *base state* and is recorded independently of
    // traffic: a provider can be unhealthy while actively serving, and the 2D
    // view suppresses health signals visually while traffic is in flight.
    // A traffic error (a request just failed on an otherwise-configured
    // connection) is recorded as `unhealthy` too — the M1 schema has no
    // separate traffic-error dimension, and both failure modes rendered
    // identically in the legacy view (red border/edge, non-green dot).
    const health =
      entry.status === "error" || trafficError
        ? "unhealthy"
        : entry.status === "active"
          ? "healthy"
          : "unknown";

    const node: TopologySceneNode = {
      id: providerNodeId(providerId),
      kind: "provider",
      label: resolveTopologyNodeLabel(entry.name, configName(providerId), providerId),
      providerId,
      health,
      traffic: active ? "active" : last ? "recent" : "idle",
    };
    if (entry.routeId) node.routeId = entry.routeId;
    if (entry.aliases && entry.aliases.length > 0) node.aliases = entry.aliases;
    if (active) {
      const count = countActiveRequests(entry, activeRequests);
      node.activeRequests = {
        value: count > 0 ? count : 1,
        source: "live-event",
        sampledAt: capturedAt,
        basis: "in-flight request set (WS live requests channel)",
      };

      // Derive the job-lane observation from the in-flight model ids. Only
      // recorded when there is at least one model id worth classifying —
      // a provider serving only ordinary chat traffic gets no `lane` field
      // at all (the *absence* is the honest "no lane in flight" signal).
      const inFlightModels = collectInFlightModels(entry, activeRequests);
      // Record the observed model ids themselves: renderers color the atom by
      // *observed* model identity (not a provider-derived guess). Absent when
      // no in-flight request carried a model id — the honest "unknown" signal.
      if (inFlightModels.length > 0) {
        node.inFlightModels = {
          value: inFlightModels,
          source: "live-event",
          sampledAt: capturedAt,
          basis: "in-flight request model ids (WS live requests channel)",
        };
        const derived = deriveLaneForProvider(inFlightModels);
        if (derived) {
          node.lane = {
            value: derived.lane,
            source: "live-event",
            sampledAt: capturedAt,
            basis: derived.basis,
          };
        }
      }
    }
    nodes.push(node);

    links.push({
      id: providerRouteLinkId(providerId),
      source: HUB_NODE_ID,
      target: providerNodeId(providerId),
      kind: "route",
      health: node.health,
      traffic: node.traffic,
    });
  }

  // Bounded lifecycle stream (M4): reduced, deduped, order-normalized and
  // frozen. `null` → the field stays absent (we did not observe a feed).
  const lifecycle = normalizeLifecycleEvents(input.lifecycleEvents);

  const snapshot: TopologySceneSnapshot = { schemaVersion: 1, capturedAt, nodes, links };
  if (lifecycle) snapshot.lifecycle = lifecycle;
  // Fleet telemetry reconciliation (OR-ATOM-005 / Step 5): carried verbatim,
  // deep-frozen with the snapshot. Absent / null → the field stays absent.
  if (input.reconciliation) snapshot.fleetTelemetry = input.reconciliation;

  // Snapshot values are provenance-carrying and immutable: freeze the whole
  // snapshot so no renderer can mutate core-owned data (deep — every nested
  // value here is either a frozen scalar object, a frozen array of frozen
  // objects, or a string/number).
  return freezeDeep(snapshot);
}

/** Deep-freeze a value (objects, arrays, Maps, Sets) and return it. */
function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  if (value instanceof Map) {
    for (const entry of value.entries()) freezeDeep(entry);
  } else if (value instanceof Set) {
    for (const entry of value) freezeDeep(entry);
  } else if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
  } else {
    for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Re-export for hosts/tests that only want the flat active-request shape. */
export type { TopologyActiveRequest };
