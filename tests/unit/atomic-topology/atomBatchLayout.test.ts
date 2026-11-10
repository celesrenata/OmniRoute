import test from "node:test";
import assert from "node:assert/strict";

import {
  BOLT_BASE,
  BOLT_SLOTS_PER_ATOM,
  BOLT_TEXELS,
  DYN_COLS,
  FIELD,
  FIELD_COUNT,
  STRAND_BUCKETS,
  STRAND_LOD_MIN,
  layoutFits,
  rankOrder,
  strandBucket,
  strandLod,
} from "../../../src/plugins/atomic-topology/scene/rt/atomLayout";

test("batched atom layout: fields fit and do not overlap", () => {
  assert.equal(layoutFits(), true);
  const idx = Object.values(FIELD);
  assert.equal(new Set(idx).size, idx.length, "field indices are unique");
  assert.ok(Math.max(...idx) < FIELD_COUNT);
  assert.equal(DYN_COLS, BOLT_BASE + BOLT_SLOTS_PER_ATOM * BOLT_TEXELS);
});

test("strandLod: unchanged at the approved default/close views, bounded when tiny", () => {
  assert.equal(strandLod(1), 1);
  assert.equal(strandLod(0.6), 1, "pair-size framing keeps every strand");
  assert.equal(strandLod(0.5), 1);
  assert.ok(Math.abs(strandLod(0.2) - 0.4) < 1e-9);
  assert.equal(strandLod(0.01), STRAND_LOD_MIN);
  assert.equal(strandLod(Number.NaN), 1, "garbage never lowers detail");
  // Monotonic in projected size.
  let prev = 0;
  for (let c = 0; c <= 1; c += 0.05) {
    const l = strandLod(c);
    assert.ok(l >= prev);
    prev = l;
  }
});

test("strandBucket: smallest bucket holding every lit strand, with hysteresis", () => {
  assert.equal(STRAND_BUCKETS[strandBucket(1)], 1);
  assert.equal(STRAND_BUCKETS[strandBucket(0.3)], 0.5);
  assert.equal(STRAND_BUCKETS[strandBucket(0.1)], 0.125);
  for (let q = 0; q <= 1; q += 0.01) assert.ok(STRAND_BUCKETS[strandBucket(q)] >= q - 1e-9);
  // Just under a boundary: stays in the larger previous bucket (no flapping).
  assert.equal(strandBucket(0.24, 2), 2);
  // Well under: drops.
  assert.equal(strandBucket(0.1, 2), 0);
  assert.equal(STRAND_BUCKETS[strandBucket(Number.NaN)], 1);
});

test("rankOrder: ascending, stable, a permutation", () => {
  const ranks = [0.5, 0.1, 0.5, 0.9, 0];
  assert.deepEqual(rankOrder(ranks), [4, 1, 0, 2, 3]);
});
