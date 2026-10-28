/**
 * Unit tests for the pure filament math module (OR-ATOM-008 S8.1):
 * arc-length table + fraction lookup, bounded pulse-packet scheduling
 * (pool cap, stagger, trailing gap, fade bands), the traveling completion
 * impulse, the seeded failure-branch geometry and the ribbon strip layout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_PACKET_POOL,
  PACKET_TAIL_DECAY,
  PACKET_TAIL_STEP,
  branchCount,
  branchGeometry,
  buildArcLengthTable,
  buildRibbonStripData,
  completionImpulseFraction,
  createPointAtFraction,
  packetHeadOpacity,
  packetHeadProgress,
  packetPoolSize,
  packetTailOpacity,
  packetTailScale,
  packetTailStep,
} from "@/plugins/atomic-topology/scene/filament";
import { boltPoints } from "@/plugins/atomic-topology/scene/discharge";

/** Straight-line fixture: 4 points, 1 unit apart on the x axis. */
const LINE: readonly number[] = [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0];

test("buildArcLengthTable: exact cumulative lengths on a straight line", () => {
  const table = buildArcLengthTable(LINE);
  assert.equal(table.totalLength, 3);
  assert.deepEqual(Array.from(table.cumulative), [0, 1, 2, 3]);
});

test("buildArcLengthTable: fewer than 2 points is the degenerate guard", () => {
  for (const pts of [[], [1, 2, 3]]) {
    const table = buildArcLengthTable(pts);
    assert.equal(table.totalLength, 0, `points(${pts.length}) must have zero total length`);
    assert.equal(table.cumulative.length, 0);
  }
});

test("createPointAtFraction: endpoint + arc-length midpoint lookups", () => {
  const table = buildArcLengthTable(LINE);
  const pointAt = createPointAtFraction(table, LINE);
  const out = { x: -1, y: -1, z: -1 };

  pointAt(0, out);
  assert.deepEqual([out.x, out.y, out.z], [0, 0, 0]);
  pointAt(1, out);
  assert.deepEqual([out.x, out.y, out.z], [3, 0, 0]);
  // 25% of the arc length lands on the first unit segment.
  pointAt(0.25, out);
  assert.ok(Math.abs(out.x - 0.75) < 1e-6, `x=0.75 (got ${out.x})`);
  // 50% lands exactly between points 2 and 3.
  pointAt(0.5, out);
  assert.ok(Math.abs(out.x - 1.5) < 1e-6, `x=1.5 (got ${out.x})`);
});

test("createPointAtFraction: out-of-range fractions clamp to the ends", () => {
  const table = buildArcLengthTable(LINE);
  const pointAt = createPointAtFraction(table, LINE);
  const out = { x: 0, y: 0, z: 0 };

  pointAt(-0.25, out);
  assert.deepEqual([out.x, out.y, out.z], [0, 0, 0]);
  pointAt(1.5, out);
  assert.deepEqual([out.x, out.y, out.z], [3, 0, 0]);
});

test("createPointAtFraction: degenerate table writes zeros", () => {
  const single = LINE.slice(0, 3);
  const table = buildArcLengthTable(single);
  const pointAt = createPointAtFraction(table, single);
  const out = { x: 9, y: 9, z: 9 };
  pointAt(0.5, out);
  assert.deepEqual([out.x, out.y, out.z], [0, 0, 0]);
});

test("packetPoolSize: caps at MAX_PACKET_POOL, scales down with evidence", () => {
  assert.equal(packetPoolSize(5, true, false), MAX_PACKET_POOL, "many slots -> capped pool");
  assert.equal(packetPoolSize(2, true, false), 2, "fewer slots -> fewer packets");
  assert.equal(packetPoolSize(1, true, false), 1);
  assert.equal(packetPoolSize(0, true, false), 0, "no active traffic -> static only");
  assert.equal(packetPoolSize(3, false, false), 0, "inactive link -> no packets");
  assert.equal(packetPoolSize(3, true, true), 0, "reduced motion -> no packets");
});

test("packetHeadProgress: staggered packets never share a path position", () => {
  const t = 0.02;
  const period = 2.5;
  const p0 = packetHeadProgress(t, period, 0, 3);
  const p1 = packetHeadProgress(t, period, 1, 3);
  const p2 = packetHeadProgress(t, period, 2, 3);
  assert.ok(p0 < p1 && p1 < p2, `staggered progression (got ${p0}, ${p1}, ${p2})`);
  for (const p of [p0, p1, p2]) assert.ok(p >= 0 && p <= 1, `progress in [0,1] (got ${p})`);
});

test("packetHeadProgress: trailing gap is dormant (no wrap-around pop)", () => {
  const period = 2.5;
  // t/period = 0.72 >= 0.68 (gap start) -> hidden.
  assert.equal(
    packetHeadProgress(1.8, period, 0, 1),
    0,
    "a packet past the visible window must be hidden"
  );
  // t/period = 0.64 < 0.68 -> visible, near the end of the path.
  const visible = packetHeadProgress(1.6, period, 0, 1);
  assert.ok(visible > 0 && visible <= 1, `just inside the gap is visible (got ${visible})`);
});

test("packetHeadProgress: negative scene-time wraps safely (pause-aware clock)", () => {
  const p0 = packetHeadProgress(-1, 2.5, 0, 3);
  const p1 = packetHeadProgress(-1, 2.5, 1, 3);
  const p2 = packetHeadProgress(-1, 2.5, 2, 3);
  for (const p of [p0, p1, p2]) {
    assert.ok(Number.isFinite(p), `finite progress (got ${p})`);
    assert.ok(p >= 0 && p <= 1, `progress in [0,1] (got ${p})`);
  }
  // m = -1 + 2.5 = 1.5 -> base fraction 0.6: packet 0 visible, packet 1
  // wraps into the trailing gap (0.6 + 1/3 >= 0.68), packet 2 wraps to 0.267.
  assert.ok(Math.abs(p0 - 0.6 / 0.68) < 1e-12, `packet 0 (got ${p0})`);
  assert.equal(p1, 0, `packet 1 in the gap (got ${p1})`);
  assert.ok(Math.abs(p2 - ((0.6 + 2 / 3) % 1) / 0.68) < 1e-12, `packet 2 (got ${p2})`);
});

test("packetHeadProgress: monotone non-decreasing within a single hop", () => {
  const period = 2.5;
  let prev = -1;
  for (let t = 0; t < 0.679 * period; t += 0.01) {
    const p = packetHeadProgress(t, period, 0, 3);
    assert.ok(p >= prev - 1e-12, `progress regressed at t=${t.toFixed(3)}: ${prev} -> ${p}`);
    prev = p;
  }
});

test("packetHeadProgress: guards (non-positive period / empty pool) -> 0", () => {
  assert.equal(packetHeadProgress(1, 0, 0, 1), 0);
  assert.equal(packetHeadProgress(1, -1, 0, 1), 0);
  assert.equal(packetHeadProgress(1, 2.5, 0, 0), 0);
});

test("packetHeadOpacity: fade-in/out bands with a full plateau", () => {
  assert.equal(packetHeadOpacity(0), 0, "birth frame is invisible");
  assert.equal(packetHeadOpacity(1), 0, "arrival frame is invisible");
  // Halfway through the fade-in band -> half strength.
  assert.ok(Math.abs(packetHeadOpacity(0.075) - 0.5) < 1e-12);
  // Past the fade-in and before the fade-out -> full plateau.
  assert.equal(packetHeadOpacity(0.15), 1);
  assert.equal(packetHeadOpacity(0.5), 1);
  assert.equal(packetHeadOpacity(0.85), 1);
  // Out-of-range progress clamps instead of extrapolating.
  assert.equal(packetHeadOpacity(-1), 0);
  assert.equal(packetHeadOpacity(2), 0);
});

test("packetTailStep: linear spacing behind the head", () => {
  assert.equal(packetTailStep(-1), 0, "negative index -> no tail");
  assert.equal(packetTailStep(0), PACKET_TAIL_STEP);
  assert.equal(packetTailStep(1), PACKET_TAIL_STEP * 2);
});

test("packetTailOpacity / packetTailScale: bounded, monotone comet decay", () => {
  // Tail opacity is the head opacity times a strict decay factor.
  for (let tail = 0; tail < 3; tail += 1) {
    const expected = packetHeadOpacity(0.5) * Math.pow(PACKET_TAIL_DECAY, tail + 1);
    assert.ok(Math.abs(packetTailOpacity(0.5, tail) - expected) < 1e-12);
  }
  assert.ok(packetTailOpacity(0.5, 1) < packetTailOpacity(0.5, 0), "outer tails are fainter");
  assert.equal(packetTailOpacity(1, 0), 0, "opacity follows the head fade-out");
  // Scale multipliers are bounded <= 1 and strictly decreasing.
  assert.ok(packetTailScale(0) <= 1);
  assert.ok(packetTailScale(1) < packetTailScale(0));
});

test("completionImpulseFraction: starts behind the atom, lands exactly on it", () => {
  assert.ok(Math.abs(completionImpulseFraction(0, 0) - 0.85) < 1e-12, "starts at 1 - travel");
  assert.equal(completionImpulseFraction(1, 1), 1, "arrives at the atom end");
  assert.ok(Math.abs(completionImpulseFraction(0.5, 0.5) - 0.8875) < 1e-9);
  // Monotone non-decreasing through the flight.
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const f = completionImpulseFraction(Math.min(1, t), Math.min(1, t));
    assert.ok(f >= prev - 1e-12, `impulse regressed at t=${t}: ${prev} -> ${f}`);
    prev = f;
  }
  // Out-of-range inputs clamp instead of extrapolating.
  assert.equal(completionImpulseFraction(2, 2), 1);
  assert.ok(Math.abs(completionImpulseFraction(-1, -1) - 0.85) < 1e-12);
});

test("branchCount: deterministic and bounded to 1-2", () => {
  const a = branchCount("route:provider:link-1");
  const b = branchCount("route:provider:link-1");
  assert.equal(a, b, "same seed -> same branch count");
  const seen = new Set<number>();
  for (let i = 0; i < 20; i += 1) seen.add(branchCount(`route:${i}`));
  for (const v of seen) assert.ok(v === 1 || v === 2, `branch count in {1,2} (got ${v})`);
  assert.ok(seen.size >= 2, `both counts occur across seeds (got ${[...seen].join(",")})`);
});

test("branchGeometry: deterministic, roots anchored ON the bolt, bounded kinks", () => {
  const seed = "route:provider:link-2";
  const amplitude = 0.12;
  const bolt = boltPoints(10, seed);
  const flat: number[] = [];
  for (const p of bolt) flat.push(p.x, p.y, p.z);

  const first = branchGeometry(seed, flat, amplitude);
  const second = branchGeometry(seed, flat, amplitude);
  assert.deepEqual(first, second, "same seed -> identical branches");
  assert.equal(first.length, branchCount(seed), "branch count matches branchCount");
  for (const branch of first) {
    // The root must sit within one sampled segment of the bolt polyline
    // (it interpolates between two consecutive sampled points).
    let minDist = Infinity;
    for (const p of bolt) {
      const d = Math.hypot(p.x - branch.x0, p.y - branch.y0, p.z - branch.z0);
      if (d < minDist) minDist = d;
    }
    const maxSeg = Math.max(
      ...bolt.slice(1).map((p, i) => Math.hypot(p.x - bolt[i].x, p.y - bolt[i].y, p.z - bolt[i].z))
    );
    assert.ok(minDist <= maxSeg + 1e-9, `root within one segment of the bolt (dist=${minDist})`);
    // Tangent (x) reach is bounded by the branch contract: kink1 <= 35% of
    // the branch length (len < 0.14 chord), kink2 <= 80%.
    assert.ok(
      Math.abs(branch.x1 - branch.x0) <= 0.05 + 1e-9,
      `kink1 x-reach (got ${branch.x1 - branch.x0})`
    );
    assert.ok(
      Math.abs(branch.x2 - branch.x0) <= 0.12 + 1e-9,
      `kink2 x-reach (got ${branch.x2 - branch.x0})`
    );
    // Perpendicular reach is bounded: |tangent| * len + (perp + twist) * amp,
    // where |perp| + |twist| <= 1.4.
    const amp = 0.9 * amplitude;
    const checks: Array<[number, number]> = [
      [branch.y1 - branch.y0, 0.05 + 1.4 * amp],
      [branch.z1 - branch.z0, 0.05 + 1.4 * amp],
      [branch.y2 - branch.y0, 0.12 + 1.9 * 1.4 * amp],
      [branch.z2 - branch.z0, 0.12 + 1.9 * 1.4 * amp],
    ];
    for (const [delta, bound] of checks) {
      assert.ok(Math.abs(delta) <= bound + 1e-9, `perpendicular bound violated (got ${delta})`);
    }
    // Kink 2 (dying spark) is strictly further out than kink 1.
    const d1 = Math.hypot(branch.x1 - branch.x0, branch.y1 - branch.y0, branch.z1 - branch.z0);
    const d2 = Math.hypot(branch.x2 - branch.x0, branch.y2 - branch.y0, branch.z2 - branch.z0);
    assert.ok(d2 > d1 + 1e-12, `kink2 must extend past kink1 (d1=${d1}, d2=${d2})`);
  }
});

test("branchGeometry: degenerate bolt (fewer than 2 points) -> no branches", () => {
  assert.deepEqual(branchGeometry("route:x", [0, 0, 0], 0.12), []);
  assert.deepEqual(branchGeometry("route:x", [], 0.12), []);
});

test("buildRibbonStripData: straight-line layout, uv sweep and index count", () => {
  const table = buildArcLengthTable(LINE);
  const strip = buildRibbonStripData(table, LINE, 2, 0.3, 1, 0);
  assert.equal(strip.positions.length, 18, "3 samples x 2 vertices x 3 components");
  assert.equal(strip.uvs.length, 12, "3 samples x 2 vertices x 2 uv components");
  assert.equal(strip.indices.length, 12, "2 quads x 6 indices");
  // Each vertex pair sits +-halfWidth in y around the arc-length sample.
  assert.deepEqual(strip.positions.slice(0, 6), [0, -0.3, 0, 0, 0.3, 0], "sample 0 (f=0)");
  assert.deepEqual(strip.positions.slice(6, 12), [1.5, -0.3, 0, 1.5, 0.3, 0], "sample 1 (f=0.5)");
  assert.deepEqual(strip.positions.slice(12, 18), [3, -0.3, 0, 3, 0.3, 0], "sample 2 (f=1)");
  // UV u sweeps 0 -> 1; v is 0 (-side) / 1 (+side).
  assert.deepEqual(strip.uvs, [0, 0, 0, 1, 0.5, 0, 0.5, 1, 1, 0, 1, 1], "uv sweep");
  assert.deepEqual(strip.indices, [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5], "quad winding");
});

test("buildRibbonStripData: perpendicular basis follows the requested axis", () => {
  const table = buildArcLengthTable(LINE);
  const strip = buildRibbonStripData(table, LINE, 2, 0.3, 0, 1);
  assert.deepEqual(
    strip.positions.slice(0, 6),
    [0, 0, -0.3, 0, 0, 0.3],
    "strip spans z when basisZ=1"
  );
});

test("buildRibbonStripData: degenerate table still produces a bounded strip", () => {
  const single = [0, 0, 0];
  const table = buildArcLengthTable(single);
  const strip = buildRibbonStripData(table, single, 2, 0.3, 1, 0);
  assert.equal(strip.positions.length, 18);
  for (let i = 0; i < strip.positions.length; i += 1) {
    assert.ok(Number.isFinite(strip.positions[i]), `position ${i} finite`);
  }
  assert.deepEqual(strip.uvs, [0, 0, 0, 1, 0.5, 0, 0.5, 1, 1, 0, 1, 1]);
  assert.equal(strip.indices.length, 12);
});
