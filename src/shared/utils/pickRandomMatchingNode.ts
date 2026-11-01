/**
 * Pick one element at random from those matching `predicate`, or null when
 * none match.
 *
 * Used to spread traffic across multiple `provider_nodes` that share a single
 * model prefix (one node per GPU host, e.g. `arcforge` on 4 boxes). A plain
 * `.find()` pins every request to the first registered node, leaving the rest
 * idle while the pinned node saturates — under a batch the latency climbs until
 * the client times out and reports "the provider is down", even though every
 * service is alive. See `pickRandomMatchingNode` call sites in the embeddings
 * service and the `/v1/rerank` route (#arcforge-embeddings).
 */
export function pickRandomMatchingNode<T>(
  items: readonly T[],
  predicate: (item: T) => boolean
): T | null {
  const [first] = matchingNodesInRandomOrder(items, predicate);
  return first ?? null;
}

/**
 * Every matching element in random order (Fisher-Yates), so a caller can walk the
 * candidates until one is actually usable.
 *
 * A shared prefix is not a capability: the same `arcforge` prefix can cover both
 * `ArcForge Embeddings NN` (port 8100) and `ArcForge Rerank NN` (port 8101), and only
 * the nodes registered in `provider_connections` can serve a credentialed route. Picking
 * one at random and failing the request on the first credential-less node turns a
 * half-registered prefix into a ~50% error rate — walk the shuffled candidates instead
 * and keep the pick random across the ones that resolve.
 */
export function matchingNodesInRandomOrder<T>(
  items: readonly T[],
  predicate: (item: T) => boolean
): T[] {
  const matches: T[] = [];
  for (const item of items) {
    if (predicate(item)) matches.push(item);
  }
  for (let i = matches.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [matches[i], matches[j]] = [matches[j], matches[i]];
  }
  return matches;
}
