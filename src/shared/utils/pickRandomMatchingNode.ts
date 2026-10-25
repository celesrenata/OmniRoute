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
  const matches: T[] = [];
  for (const item of items) {
    if (predicate(item)) matches.push(item);
  }
  if (matches.length === 0) return null;
  return matches[Math.floor(Math.random() * matches.length)];
}
