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

import { buildGoldenSnapshot } from "../../../src/app/dev/atomic-bench/goldenSnapshot";
import { resolveAtomDescriptors } from "../../../src/plugins/atomic-topology/AtomicTopologyRenderer";
import {
  computeCameraFit,
  computeCameraFocus,
  computeFitRadiusFromPositions,
} from "../../../src/plugins/atomic-topology/cameraFit";
import { environmentLayoutFor } from "../../../src/plugins/atomic-topology/scene/rt/topologyScene";

test("containment never fights the default pose or any focus pose (directive 25)", () => {
  for (const atomCount of [8, 16, 20, 32] as const) {
    for (const aspect of [1, 1.6, 2.2]) {
      const ds = resolveAtomDescriptors(buildGoldenSnapshot({ atomCount } as never));
      const radius = computeFitRadiusFromPositions(
        ds.filter((d) => d.kind !== "hub").map((d) => d.position),
        120
      );
      const fit = computeCameraFit({ fovDeg: 50, aspect, radius });
      const env = environmentLayoutFor(ds, { position: fit.position });
      const bounds = {
        min: [-env.wallX, env.floorY, env.farZ] as [number, number, number],
        max: [env.wallX, env.ceilY, env.nearZ] as [number, number, number],
      };
      assert.deepEqual(softClampToBounds(fit.position, bounds), fit.position, "default pose");
      for (const d of ds) {
        const f = computeCameraFocus(d.position, { fovDeg: 50, aspect, radius });
        assert.deepEqual(
          softClampToBounds(f.position, bounds),
          f.position,
          `focus pose of ${d.id} (${atomCount} atoms, aspect ${aspect}) is untouched`
        );
      }
    }
  }
});

test("container is snug: the far wall hugs the topology, not a warehouse", () => {
  const ds = resolveAtomDescriptors(buildGoldenSnapshot({ atomCount: 20 } as never));
  const maxR = Math.max(...ds.map((d) => Math.hypot(d.position.x, d.position.z)));
  const env = environmentLayoutFor(ds, { position: [0, 315, 1261] });
  assert.ok(-env.farZ <= maxR + 600, "far wall within 600 of the outermost atom");
  assert.ok(env.wallX <= maxR + 700, "side walls frame the layout");
});
