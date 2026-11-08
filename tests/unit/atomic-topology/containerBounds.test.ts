import test from "node:test";
import assert from "node:assert/strict";
import {
  SOFT_BAND,
  WALL_CLEARANCE,
  softClampAxis,
  softClampToBounds,
} from "../../../src/plugins/atomic-topology/scene/containerBounds";

const B = {
  min: [-1000, -100, -2000] as [number, number, number],
  max: [1000, 900, 3000] as [number, number, number],
};

test("softClampAxis: positions well inside are unchanged", () => {
  assert.equal(softClampAxis(0, -1000, 1000), 0);
  assert.equal(
    softClampAxis(1000 - WALL_CLEARANCE - SOFT_BAND, -1000, 1000),
    1000 - WALL_CLEARANCE - SOFT_BAND
  );
});
test("softClampAxis: never reaches the wall, monotonic, no hard snap", () => {
  let prev = softClampAxis(0, -1000, 1000);
  for (let v = 0; v <= 20000; v += 50) {
    const c = softClampAxis(v, -1000, 1000);
    assert.ok(c < 1000 - WALL_CLEARANCE + 1e-9, `inside limit at ${v}`);
    assert.ok(c >= prev, "monotonic");
    assert.ok(c - prev < 51, "continuous (no jump)");
    prev = c;
  }
  assert.ok(softClampAxis(-99999, -1000, 1000) > -1000 + WALL_CLEARANCE - 1e-9);
});
test("softClampToBounds: clamps all three axes, returns a new tuple", () => {
  const c = softClampToBounds([5000, 5000, 9000], B);
  assert.ok(c[0] < 1000 && c[1] < 900 && c[2] < 3000);
  const inside = softClampToBounds([0, 300, 500], B);
  assert.deepEqual(inside, [0, 300, 500]);
});
