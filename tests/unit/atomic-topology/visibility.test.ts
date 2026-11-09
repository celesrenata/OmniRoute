import test from "node:test";
import assert from "node:assert/strict";
import {
  FULL_STEPS_RADIUS_PX,
  MIN_STEPS_RADIUS_PX,
  extractFrustumPlanes,
  marchStepsFor,
  sphereVisible,
} from "../../../src/plugins/atomic-topology/scene/rt/visibility";

/** Column-major perspective projection (OpenGL clip space) looking down -Z from the origin. */
function perspective(fovDeg: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  return [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ];
}

const planes = extractFrustumPlanes(perspective(50, 1.6, 1, 6000));

test("sphereVisible: centred, in-front sphere is visible", () => {
  assert.equal(sphereVisible(planes, 0, 0, -1000, 50), true);
});
test("sphereVisible: far to the side / above / below / behind the camera is culled", () => {
  assert.equal(sphereVisible(planes, 5000, 0, -1000, 50), false, "right of the frustum");
  assert.equal(sphereVisible(planes, -5000, 0, -1000, 50), false, "left of the frustum");
  assert.equal(sphereVisible(planes, 0, 4000, -1000, 50), false, "above");
  assert.equal(sphereVisible(planes, 0, -4000, -1000, 50), false, "below");
  assert.equal(sphereVisible(planes, 0, 0, 1000, 50), false, "behind the camera");
  assert.equal(sphereVisible(planes, 0, 0, -9000, 50), false, "beyond far");
});
test("sphereVisible: a sphere straddling an edge stays visible (conservative)", () => {
  // Half-width of the frustum at z=-1000 for fov 50 / aspect 1.6 is ~746.
  assert.equal(sphereVisible(planes, 780, 0, -1000, 60), true);
  assert.equal(sphereVisible(planes, 900, 0, -1000, 60), false);
});
test("sphereVisible: bad data never culls", () => {
  assert.equal(sphereVisible(planes, Number.NaN, 0, 0, 10), true);
  assert.equal(sphereVisible(planes, 0, 0, -10, Number.POSITIVE_INFINITY), true);
});
test("marchStepsFor: full at/above the default-view size, smooth floor for tiny atoms", () => {
  assert.equal(marchStepsFor(48, FULL_STEPS_RADIUS_PX), 48);
  assert.equal(marchStepsFor(48, 400), 48);
  assert.equal(marchStepsFor(48, Number.NaN), 48);
  let prev = 48;
  for (let r = FULL_STEPS_RADIUS_PX; r >= 0; r -= 5) {
    const s = marchStepsFor(48, r);
    assert.ok(s <= prev, "monotonic non-increasing as the atom shrinks");
    assert.ok(s >= 16 && s <= 48);
    prev = s;
  }
  assert.equal(marchStepsFor(48, MIN_STEPS_RADIUS_PX), marchStepsFor(48, 1), "floor holds");
  assert.ok(marchStepsFor(48, 1) >= 28, "never starves tiny atoms");
});
