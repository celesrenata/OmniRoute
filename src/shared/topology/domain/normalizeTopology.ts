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
import { resolveTopologyNodeLabel } from "@/app/(dashboard)/home/topologyLabel";

import { HUB_NODE_ID, providerNodeId, providerRouteLinkId } from "./layoutIdentity";
import { deriveLaneForProvider } from "./lane";
import type { TopologySceneLink, TopologySceneNode, TopologySceneSnapshot } from "./types";

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
      if (inFlightModels.length > 0) {
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

  return { schemaVersion: 1, capturedAt, nodes, links };
}

/** Re-export for hosts/tests that only want the flat active-request shape. */
export type { TopologyActiveRequest };
