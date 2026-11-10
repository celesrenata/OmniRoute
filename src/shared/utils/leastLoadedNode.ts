/**
 * Load-aware node selection for same-prefix provider nodes (one node per GPU
 * host, e.g. `arcforge` STT/TTS/embeddings/rerank across 4 boxes).
 *
 * `pickRandomMatchingNode()` spreads traffic *uniformly* — fine for cold traffic,
 * but blind to load: if host A's whisper is busy and host B is idle, a uniform
 * pick still sends half the requests to A, so A swamps and its latency climbs
 * until the caller times out and reports "the provider is down" even though B
 * was sitting idle the whole time. That is exactly the failure the arc audio
 * routes hit under a voice batch.
 *
 * This module tracks a small per-node load signal (in-flight request count plus
 * a latency EWMA) and picks the **least loaded** matching node, breaking ties
 * randomly so a cold/empty pool still spreads. The in-flight count is the
 * primary signal; the latency EWMA is a tiebreaker for hosts that are idle on
 * our counter but genuinely slow (e.g. a busy GPU we are not currently
 * dispatching to).
 *
 * Design notes:
 * - Keys are the node's `baseUrl` (the physical endpoint), not the provider
 *   prefix — several distinct hosts share one prefix.
 * - The tracker is an in-process module-level map. It is intentionally not
 *   persisted: it is a routing heuristic, and a cold start (empty map) must
 *   behave identically to uniform random, so process restarts are a non-event.
 * - `acquire`/`release` are ref-counted per node and idempotent enough for the
 *   route pattern (acquire once before dispatch, release in a `finally`), so a
 *   leaked release can never push a count negative.
 */

export interface NodeLoadSample {
  inFlight: number;
  /** EWMA of recent response latency in ms; 0 when the node is still cold. */
  latencyMs: number;
  /** Last time this node was observed serving, epoch ms (staleness gate). */
  lastActiveMs: number;
}

/**
 * A node as the picker needs to see it: a stable identity key plus the
 * predicate-friendly fields the caller already filters on.
 */
export interface LoadPickerNode {
  /** Stable per-host key used to key the load tracker (typically `baseUrl`). */
  key: string;
  /** The raw row, returned untouched so callers keep their existing shape. */
  raw: unknown;
}

interface LoadState {
  inFlight: number;
  latencyMs: number;
  lastActiveMs: number;
}

// Cold-start / staleness tuning.
/**
 * EWMA alpha for latency. Higher = react faster to a slow host, lower = smoother.
 * 0.3 reacts within a few samples, which is what we want for a swamping GPU.
 */
const LATENCY_ALPHA = 0.3;
/**
 * A latency sample older than this is no longer trusted — the host may have
 * been reset, swapped, or the sample is just ancient. Stamped on release; if the
 * sample is stale at pick time we weight latency down to zero.
 */
const LATENCY_TTL_MS = 60_000;
/**
 * Weight (0..1) of the latency term in the composite score. The in-flight count
 * is the dominant signal; latency is a tiebreaker so two otherwise-idle hosts
 * still prefer the faster one.
 */
const LATENCY_WEIGHT = 0.25;

const state = new Map<string, LoadState>();

/** Test / process-shutdown hook to drop the in-memory load map. */
export function resetNodeLoad(): void {
  state.clear();
}

function entry(key: string): LoadState {
  let s = state.get(key);
  if (!s) {
    s = { inFlight: 0, latencyMs: 0, lastActiveMs: 0 };
    state.set(key, s);
  }
  return s;
}

/**
 * Reserve a slot on the node for the duration of one in-flight request. Call
 * once before dispatching; pair with `releaseNodeLoad(key, durationMs)` in a
 * `finally`. Returns nothing — the effect is the incremented counter.
 */
export function acquireNodeLoad(key: string): void {
  const s = entry(key);
  s.inFlight += 1;
  s.lastActiveMs = Date.now();
}

/**
 * Release a slot and fold this request's latency into the node's EWMA.
 * `durationMs < 0` (an error/timeout path) records no latency sample so a single
 * failure cannot poison the EWMA, but still decrements the in-flight counter.
 */
export function releaseNodeLoad(key: string, durationMs: number): void {
  const s = state.get(key);
  if (!s) return;
  if (s.inFlight > 0) s.inFlight -= 1;
  if (durationMs >= 0 && Number.isFinite(durationMs)) {
    const fresh = s.latencyMs === 0;
    s.latencyMs = fresh
      ? durationMs
      : LATENCY_ALPHA * durationMs + (1 - LATENCY_ALPHA) * s.latencyMs;
    s.lastActiveMs = Date.now();
  }
}

/** Composite load score for a node. Lower is better. */
function score(key: string, now: number): number {
  const s = state.get(key);
  if (!s) return 0;
  // The in-flight count dominates. Latency is a small constant tiebreaker so
  // two hosts with the same (idle) in-flight count still prefer the faster one,
  // and a stale sample (host restarted / swapped) is discounted to zero.
  let latencyTerm = s.latencyMs;
  if (now - s.lastActiveMs > LATENCY_TTL_MS) latencyTerm = 0;
  const latencyAsLoad = (latencyTerm * LATENCY_WEIGHT) / 250;
  return s.inFlight + latencyAsLoad;
}

/**
 * Pick the least-loaded node among those matching `predicate`. Ties (including
 * the all-cold case) are broken randomly, so a cold pool still spreads across
 * every matching node. Returns the chosen node's raw row, or `null` when
 * nothing matches.
 *
 * The caller is responsible for `acquireNodeLoad(chosen.key)` on the returned
 * node before dispatch and `releaseNodeLoad` after — this function only reads.
 */
export function pickLeastLoadedNode<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  predicate?: (item: T) => boolean
): { raw: T; key: string } | null {
  const now = Date.now();
  const candidates: { raw: T; key: string; score: number }[] = [];
  let minScore = Infinity;
  for (const item of items) {
    if (predicate && !predicate(item)) continue;
    const key = keyOf(item);
    const s = score(key, now);
    candidates.push({ raw: item, key, score: s });
    if (s < minScore) minScore = s;
  }
  if (candidates.length === 0) return null;
  // Among the minimum-scoring candidates, pick one at random so we do not
  // deterministically pin to the first-cold host. A cold pool (everyone at
  // score 0) therefore still spreads uniformly — identical to the old
  // random-order walk when no load has been observed yet.
  const minCandidates = candidates.filter((c) => Math.abs(c.score - minScore) < 1e-9);
  const chosen = minCandidates[Math.floor(Math.random() * minCandidates.length)];
  return { raw: chosen.raw, key: chosen.key };
}

/**
 * Convenience: pick the least-loaded node and immediately acquire it, returning
 * a `release()` to call in a `finally`. Use this when the pick+dispatch happens
 * inline (the common route pattern) instead of calling acquire/release by hand.
 */
export function withLeastLoadedNode<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  predicate?: (item: T) => boolean
): { raw: T; key: string; release: (durationMs?: number) => void } | null {
  const picked = pickLeastLoadedNode(items, keyOf, predicate);
  if (!picked) return null;
  acquireNodeLoad(picked.key);
  let released = false;
  const release = (durationMs?: number): void => {
    if (released) return;
    released = true;
    releaseNodeLoad(picked.key, durationMs ?? -1);
  };
  return { raw: picked.raw, key: picked.key, release };
}

/**
 * The node-load signal as of now, for dashboards/tests. A fresh snapshot — the
 * map is not mutated.
 */
export function getNodeLoad(key: string): NodeLoadSample {
  const s = state.get(key);
  if (!s) return { inFlight: 0, latencyMs: 0, lastActiveMs: 0 };
  return { inFlight: s.inFlight, latencyMs: s.latencyMs, lastActiveMs: s.lastActiveMs };
}
