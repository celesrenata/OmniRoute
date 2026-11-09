import test from "node:test";
import assert from "node:assert/strict";
import {
  SMALL_LOD_NEAR,
  SMALL_LOD_SPAN,
  smallAtomLod,
} from "../../../src/plugins/atomic-topology/scene/rt/visibility.ts";

test("smallAtomLod: fully on for small clouds, fully off for large ones", () => {
  assert.equal(smallAtomLod(0), 1);
  assert.equal(smallAtomLod(SMALL_LOD_NEAR), 1);
  assert.equal(smallAtomLod(SMALL_LOD_NEAR + SMALL_LOD_SPAN), 0);
  assert.equal(smallAtomLod(5000), 0);
});

test("smallAtomLod: monotonic smooth cross-fade (no step)", () => {
  let prev = 1;
  for (let d = SMALL_LOD_NEAR; d <= SMALL_LOD_NEAR + SMALL_LOD_SPAN; d += 10) {
    const v = smallAtomLod(d);
    assert.ok(v <= prev + 1e-12, `non-increasing at ${d}`);
    assert.ok(prev - v < 0.15, `no step at ${d}`);
    prev = v;
  }
  assert.ok(Math.abs(smallAtomLod(SMALL_LOD_NEAR + SMALL_LOD_SPAN / 2) - 0.5) < 1e-9);
});
