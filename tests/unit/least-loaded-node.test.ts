// Unit tests for the load-aware same-prefix node picker
// (`src/shared/utils/leastLoadedNode.ts`).
//
// The ArcForge audio fleet registers one provider_node per GPU host, all sharing
// the same `arcforge` prefix. The old routes used `.find()`/uniform-random, which
// swamped the first host while the rest idled under a voice batch. This module
// picks the least-loaded matching node: in-flight count is the dominant signal,
// a latency EWMA is the tiebreaker, and ties (incl. a cold pool) are broken
// randomly so cold traffic still spreads.

import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireNodeLoad,
  releaseNodeLoad,
  getNodeLoad,
  pickLeastLoadedNode,
  resetNodeLoad,
  withLeastLoadedNode,
} from "@/shared/utils/leastLoadedNode";

const nodes = [
  { key: "host-a", raw: "a" },
  { key: "host-b", raw: "b" },
  { key: "host-c", raw: "c" },
];
const keyOf = (n: (typeof nodes)[number]) => n.key;

test.afterEach(() => resetNodeLoad());

function pickKeys(n: number, pred?: (n: (typeof nodes)[number]) => boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = pickLeastLoadedNode(nodes, keyOf, pred);
    assert.ok(r, "pick should return a node");
    out.push(r.key);
  }
  return out;
}

test("cold pool: every matching node is reachable (no first-node pinning)", () => {
  const seen = new Set(pickKeys(300));
  assert.deepEqual(
    [...seen].sort(),
    ["host-a", "host-b", "host-c"],
    "cold pool must spread across all nodes"
  );
});

test("cold pool is not pinned to the first node over many picks", () => {
  const counts = { "host-a": 0, "host-b": 0, "host-c": 0 };
  for (const k of pickKeys(600)) counts[k] += 1;
  // Uniform random over 3 → each should get a substantial share; assert none is
  // starved and none is pinned. (loose bounds to avoid flake on the random walk)
  assert.ok(counts["host-a"] > 0, "a must be picked");
  assert.ok(counts["host-b"] > 0, "b must be picked");
  assert.ok(counts["host-c"] > 0, "c must be picked");
  for (const v of Object.values(counts))
    assert.ok(v < 600, "no single node may swallow a cold pool");
});

test("in-flight count is the dominant signal: busy node is deprioritized", () => {
  acquireNodeLoad("host-a");
  acquireNodeLoad("host-a");
  acquireNodeLoad("host-a"); // a = 3 in-flight
  const seen = new Set(pickKeys(300));
  assert.equal(
    seen.has("host-a"),
    false,
    "a host with 3 in-flight must never be picked while others are idle"
  );
  assert.ok(seen.has("host-b") && seen.has("host-c"), "idle hosts b and c should carry the load");
});

test("latency EWMA tiebreak: slow host is deprioritized among idle hosts", () => {
  // Give b a recorded slow latency (must acquire first so a state entry exists).
  acquireNodeLoad("host-b");
  releaseNodeLoad("host-b", 8000); // b in-flight back to 0, latency 8000ms
  assert.equal(getNodeLoad("host-b").inFlight, 0, "release must decrement in-flight");
  assert.ok(getNodeLoad("host-b").latencyMs > 0, "latency sample recorded");

  // a and c are cold (score 0); b carries a large latency term. Over many picks
  // the slow host should be rarely chosen vs the two cold hosts.
  const counts = { "host-a": 0, "host-b": 0, "host-c": 0 };
  for (const k of pickKeys(1000)) counts[k] += 1;
  assert.ok(
    counts["host-b"] < counts["host-a"],
    `slow b (${counts["host-b"]}) should be picked less than cold a (${counts["host-a"]})`
  );
  assert.ok(
    counts["host-b"] < counts["host-c"],
    `slow b (${counts["host-b"]}) should be picked less than cold c (${counts["host-c"]})`
  );
});

test("predicate filters the candidate set; untracked keys are ignored", () => {
  // Only host-b is eligible → only host-b can be returned.
  const seen = new Set(pickKeys(50, (n) => n.key === "host-b"));
  assert.deepEqual([...seen], ["host-b"], "predicate must restrict to matching nodes");
});

test("no matching node returns null", () => {
  assert.equal(
    pickLeastLoadedNode(nodes, keyOf, (n) => n.key === "zzz"),
    null
  );
});

test("empty item list returns null", () => {
  assert.equal(pickLeastLoadedNode([], keyOf), null);
});

test("acquire/release ref-counts in-flight and never goes negative", () => {
  acquireNodeLoad("host-a");
  acquireNodeLoad("host-a");
  assert.equal(getNodeLoad("host-a").inFlight, 2);
  releaseNodeLoad("host-a", 10);
  assert.equal(getNodeLoad("host-a").inFlight, 1);
  releaseNodeLoad("host-a", 10);
  assert.equal(getNodeLoad("host-a").inFlight, 0);
  // Extra release (leaked) must not push negative.
  releaseNodeLoad("host-a", 10);
  assert.equal(getNodeLoad("host-a").inFlight, 0, "leaked release must not go negative");
});

test("release on a key that was never acquired is a no-op (no state created)", () => {
  releaseNodeLoad("ghost", 5000);
  assert.deepEqual(getNodeLoad("ghost"), { inFlight: 0, latencyMs: 0, lastActiveMs: 0 });
});

test("negative durationMs decrements in-flight but records no latency sample", () => {
  acquireNodeLoad("host-c");
  releaseNodeLoad("host-c", -1); // error/timeout path
  assert.equal(getNodeLoad("host-c").inFlight, 0);
  assert.equal(getNodeLoad("host-c").latencyMs, 0, "a failure must not poison the latency EWMA");
});

test("release folds latency into the EWMA across repeated samples", () => {
  acquireNodeLoad("host-b");
  releaseNodeLoad("host-b", 1000); // first sample is fresh → exactly 1000
  assert.ok(
    Math.abs(getNodeLoad("host-b").latencyMs - 1000) < 1e-6,
    "first sample is the raw value"
  );
  acquireNodeLoad("host-b");
  releaseNodeLoad("host-b", 0); // second sample pulls the EWMA down
  assert.ok(
    getNodeLoad("host-b").latencyMs < 1000,
    "EWMA must move toward the newest (lower) latency sample"
  );
});

test("withLeastLoadedNode returns the node, its key, and a working release", () => {
  acquireNodeLoad("host-a");
  acquireNodeLoad("host-a"); // make a busy
  const picked = withLeastLoadedNode(nodes, keyOf, (n) => n.key !== "host-b");
  assert.equal(
    picked.key,
    "host-c",
    "with b excluded and a busy, the idle c must be picked (never the busy a)"
  );
  assert.equal(getNodeLoad(picked.key).inFlight, 1, "wrapper must acquire on pick");
  picked.release(250);
  assert.equal(getNodeLoad(picked.key).inFlight, 0, "wrapper release must decrement");
});

test("stale latency samples (older than the TTL) are discounted to zero", () => {
  const realNow = Date.now;
  try {
    acquireNodeLoad("host-b");
    releaseNodeLoad("host-b", 9000);
    assert.ok(getNodeLoad("host-b").latencyMs > 0, "sample recorded while fresh");
    // Jump 70 s forward: the sample is now stale and must no longer influence picks.
    Date.now = () => realNow() + 70_000;
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const r = pickLeastLoadedNode(nodes, keyOf, (n) => n.key !== "host-c");
      assert.ok(r);
      seen.add(r.key);
    }
    // With b's latency discounted, b and a are tied (both score 0) → both must appear.
    assert.ok(
      seen.has("host-a") && seen.has("host-b"),
      "stale latency must not keep b deprioritized"
    );
  } finally {
    Date.now = realNow;
  }
});

test("resetNodeLoad clears all tracked state", () => {
  acquireNodeLoad("host-a");
  releaseNodeLoad("host-b", 5000);
  resetNodeLoad();
  assert.deepEqual(getNodeLoad("host-a"), { inFlight: 0, latencyMs: 0, lastActiveMs: 0 });
  assert.deepEqual(getNodeLoad("host-b"), { inFlight: 0, latencyMs: 0, lastActiveMs: 0 });
});
