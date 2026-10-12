/**
 * Stable canonical ID helpers for topology atoms (OR-ATOM-001 v2, T004 / M1).
 *
 * The identity of a topology node must survive reordering, snapshot-to-snapshot
 * transitions, and alias renames so a renderer can diff / persist / focus on a
 * stable key. M1 emits exactly two shapes:
 *
 *   hub       -> "hub"
 *   provider  -> "provider:<providerId>"
 *
 * (and, for links, `route:<providerId>` — the link is named after the provider
 * it terminates on, mirroring the `provider:<id>` node key so a renderer can
 * derive the link id without a lookup).
 *
 * `gpu:<deviceId>` is defined for forward compatibility but is NOT emitted by
 * M1 normalization — provider routes are never conflated with devices.
 */

/** Canonical id of the router hub node. */
export const HUB_NODE_ID = "hub";

/** Canonical node id for a provider atom. */
export function providerNodeId(providerId: string): string {
  return `provider:${providerId}`;
}

/** Canonical node id for a gpu atom (forward-compatible; not emitted in M1). */
export function gpuNodeId(deviceId: string): string {
  return `gpu:${deviceId}`;
}

/** Canonical link id for the route from the hub to a provider atom. */
export function providerRouteLinkId(providerId: string): string {
  return `route:${providerId}`;
}

/**
 * Parse a canonical atom id back into its parts. Returns `null` for anything
 * that is not a canonical M1 id (defensive — a renderer must never crash on a
 * foreign id, it should just skip it).
 */
export function parseAtomId(
  id: string
): { kind: "hub" | "provider" | "gpu"; value: string } | null {
  if (id === HUB_NODE_ID) return { kind: "hub", value: HUB_NODE_ID };
  if (id.startsWith("provider:")) return { kind: "provider", value: id.slice("provider:".length) };
  if (id.startsWith("gpu:")) return { kind: "gpu", value: id.slice("gpu:".length) };
  return null;
}
