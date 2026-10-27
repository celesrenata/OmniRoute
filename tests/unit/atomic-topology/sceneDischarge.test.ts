/**
 * Unit tests for the pure discharge module (OR-ATOM-007): seeded PRNG
 * determinism, jagged bolt geometry (bounded endpoints + perpendicular
 * jitter), amplitude-decay monotonicity, and the one-shot decay envelope.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mulberry32,
  boltPoints,
  boltAmplitudeAt,
  boltSegmentCount,
  decayEnvelope,
} from "@/plugins/atomic-topology/scene/discharge";
import { fnv1a } from "@/plugins/atomic-topology/scene/cloudShells";

test("mulberry32 is deterministic (same seed → identical sequence)", () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const sa = [a(), a(), a(), a()];
  const sb = [b(), b(), b(), b()];
  assert.deepEqual(sa, sb, "two streams from the same seed must match exactly");
  // Different seed → different sequence (almost surely).
  const c = mulberry32(12346);
  const sc = [c(), c(), c(), c()];
  assert.notDeepEqual(sa, sc, "different seeds should diverge");
});

test("mulberry32 values are bounded to [0, 1)", () => {
  const r = mulberry32(42);
  for (let i = 0; i < 1000; i += 1) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `value ${v} out of [0,1)`);
  }
});

test("boltPoints: deterministic (same seed → identical bolt across 2 calls)", () => {
  const seed = "route:provider:x";
  const a = boltPoints(10, seed);
  const b = boltPoints(10, seed);
  assert.deepEqual(a, b, "same seed → byte-identical bolt");
});

test("boltPoints: endpoints pinned (bolt always connects hub→atom)", () => {
  for (let s = 0; s < 5; s += 1) {
    const pts = boltPoints(9 + s, `route:provider:${s}`);
    const first = pts[0];
    const last = pts[pts.length - 1];
    assert.equal(first.x, 0);
    assert.equal(first.y, 0);
    assert.equal(first.z, 0);
    assert.equal(last.x, 1);
    assert.equal(last.y, 0);
    assert.equal(last.z, 0);
  }
});

test("boltPoints: interior perpendicular jitter is bounded and decays outward", () => {
  const amp = 0.12;
  const pts = boltPoints(14, "route:provider:bounded");
  // Interior points stay within the decayed amplitude (≤ base amplitude).
  for (const p of pts.slice(1, -1)) {
    assert.ok(Math.abs(p.y) <= amp + 1e-12, `y ${p.y} exceeds amplitude`);
    assert.ok(Math.abs(p.z) <= amp + 1e-12, `z ${p.z} exceeds amplitude`);
  }
  // Outward decay: near the hub (t≈0.1) the envelope is higher than near the
  // atom (t≈0.9) — the jitter "settles" into the target.
  assert.ok(boltAmplitudeAt(0.1) > boltAmplitudeAt(0.9), "amplitude decays outward");
});

test("boltAmplitudeAt: peaks mid-bolt, monotone non-increasing outward, bounded [0,1]", () => {
  // Bounded + endpoints zero (the bolt must connect at both ends).
  for (let i = 0; i <= 20; i += 1) {
    const v = boltAmplitudeAt(i / 20);
    assert.ok(v >= 0 && v <= 1, `envelope ${v} out of [0,1] at ${i / 20}`);
  }
  assert.equal(boltAmplitudeAt(0), 0);
  assert.equal(boltAmplitudeAt(1), 0);
  // The peak sits at the middle of the bolt.
  assert.equal(
    boltAmplitudeAt(0.5),
    Math.max(...Array.from({ length: 21 }, (_, i) => boltAmplitudeAt(i / 20))),
    "peak at t=0.5"
  );
  // Monotone non-increasing on the outward half [0.5, 1] (decay toward the atom).
  let prev = Infinity;
  for (let i = 10; i <= 20; i += 1) {
    const v = boltAmplitudeAt(i / 20);
    assert.ok(v <= prev + 1e-12, `envelope must decay outward at ${i / 20}`);
    prev = v;
  }
});

test("boltSegmentCount is deterministic and bounded 9..14", () => {
  const seen = new Set<number>();
  for (let s = 0; s < 200; s += 1) {
    const n = boltSegmentCount(`route:provider:${s}`);
    assert.ok(n >= 9 && n <= 14, `segment count ${n} out of [9,14]`);
    seen.add(n);
    // Determinism: same input → same count.
    assert.equal(n, boltSegmentCount(`route:provider:${s}`));
  }
  assert.ok(seen.size >= 3, "segment counts should vary across seeds");
});

test("decayEnvelope: starts at 1, decays monotonically, hits 0 at duration", () => {
  const dur = 1.2;
  assert.equal(decayEnvelope(0, dur), 1, "burst starts at full intensity");
  assert.equal(decayEnvelope(-0.5, dur), 1, "before the start → full");
  assert.equal(decayEnvelope(dur, dur), 0, "at the duration → done");
  assert.equal(decayEnvelope(dur + 1, dur), 0, "after the duration → done");
  assert.equal(decayEnvelope(5, 0), 0, "non-positive duration → no burst");
  // Monotone non-increasing within the window.
  let prev = 1;
  for (let i = 1; i < 100; i += 1) {
    const t = (i / 100) * dur;
    const v = decayEnvelope(t, dur);
    assert.ok(v <= prev + 1e-12, `envelope must decay at ${t}`);
    assert.ok(v >= 0 && v <= 1, `envelope ${v} out of [0,1]`);
    prev = v;
  }
});

test("fnv1a matches the visualEncoding 32-bit FNV-1a pattern", () => {
  // Re-implement the reference (from visualEncoding.ts) and compare.
  const ref = (s: string): number => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      hash ^= s.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash >>> 0;
  };
  assert.equal(fnv1a("provider:openai"), ref("provider:openai"));
  assert.equal(fnv1a(""), 0x811c9dc5);
});
