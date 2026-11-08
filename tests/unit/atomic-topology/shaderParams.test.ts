/**
 * Shader parameter bounds + nucleon packing + orbital layout + bolt geometry
 * + disposal registry for the ray-traced atom (Gate A). All pure / three-free.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ATOM_WORLD_RADIUS,
  CLOUD_BASE_RADIUS,
  CLOUD_BOUND_RADIUS,
  CLOUD_OUTER_SHELL_FACTOR,
  clampShaderParams,
  MAX_BOLT_VERTICES,
  MAX_MARCH_STEPS,
  MAX_NUCLEONS,
  MIN_MARCH_STEPS,
} from "../../../src/plugins/atomic-topology/scene/shaderParams";
import {
  packNucleus,
  RT_HUB_OUTER_COUNT,
  RT_RING_OUTER_COUNT,
} from "../../../src/plugins/atomic-topology/scene/nucleonPack";
import {
  orbitalLayout,
  orbitWires,
} from "../../../src/plugins/atomic-topology/scene/orbitalDensity";
import { buildBolt } from "../../../src/plugins/atomic-topology/scene/boltGeometry";
import { createRtRegistry } from "../../../src/plugins/atomic-topology/scene/rt/rtRegistry";

const raw = {
  marchSteps: 96,
  exposure: 1,
  excitation: 0.5,
  saturation: 0.5,
  brightness: 0.5,
  cloudRadiusMul: 0.9,
  nucleonCount: 30,
  orbitalWeights: [0.5, 0.3, 0.2],
  phase: 3,
};

test("clampShaderParams bounds every value, even for NaN / Infinity / out-of-range", () => {
  for (const bad of [NaN, Infinity, -Infinity, -1e9, 1e9]) {
    const p = clampShaderParams({
      marchSteps: bad,
      exposure: bad,
      excitation: bad,
      saturation: bad,
      brightness: bad,
      cloudRadiusMul: bad,
      nucleonCount: bad,
      orbitalWeights: [bad, bad, bad],
      phase: bad,
    });
    assert.ok(p.marchSteps >= MIN_MARCH_STEPS && p.marchSteps <= MAX_MARCH_STEPS);
    assert.ok(p.exposure >= 0.1 && p.exposure <= 4);
    for (const v of [p.excitation, p.saturation, p.brightness]) assert.ok(v >= 0 && v <= 1);
    assert.ok(p.cloudRadius >= 0.5 * CLOUD_BOUND_RADIUS && p.cloudRadius <= CLOUD_BOUND_RADIUS);
    assert.ok(p.nucleonCount >= 1 && p.nucleonCount <= MAX_NUCLEONS);
    assert.ok(Number.isFinite(p.phase));
    const sum = p.orbitalWeights.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, "orbital weights are normalized");
  }
  const ok = clampShaderParams(raw);
  assert.equal(ok.marchSteps, 96);
  assert.ok(ok.cloudRadius <= CLOUD_BOUND_RADIUS);
});

test("cloud bounding radius never exceeds the production electron envelope", () => {
  assert.ok(CLOUD_BOUND_RADIUS <= CLOUD_BASE_RADIUS * CLOUD_OUTER_SHELL_FACTOR);
  assert.equal(CLOUD_BASE_RADIUS, ATOM_WORLD_RADIUS + 16);
});

test("packNucleus is deterministic, bounded, non-overlapping and uses production counts", () => {
  const a = packNucleus({ seed: 12345, hub: false, observedModelIds: ["a", "b", "c"] });
  const b = packNucleus({ seed: 12345, hub: false, observedModelIds: ["c", "b", "a"] });
  assert.deepEqual(Array.from(a.centers), Array.from(b.centers), "input-order independent");
  assert.ok(a.count <= MAX_NUCLEONS && a.count >= RT_RING_OUTER_COUNT);
  assert.ok(packNucleus({ seed: 1, hub: true }).count >= RT_HUB_OUTER_COUNT);
  assert.ok(a.modelGroups.length <= 3);
  for (let i = 0; i < a.count; i += 1) {
    for (let j = i + 1; j < a.count; j += 1) {
      const d = Math.hypot(
        a.centers[i * 4] - a.centers[j * 4],
        a.centers[i * 4 + 1] - a.centers[j * 4 + 1],
        a.centers[i * 4 + 2] - a.centers[j * 4 + 2]
      );
      assert.ok(
        d >= (a.centers[i * 4 + 3] + a.centers[j * 4 + 3]) * 0.9,
        "nucleons do not interpenetrate"
      );
    }
  }
  assert.ok(a.extent <= ATOM_WORLD_RADIUS * 1.2, "nucleus stays inside the atom footprint");
});

test("unknown attribution yields the neutral tint set (no model groups)", () => {
  const u = packNucleus({ seed: 9, hub: false });
  assert.equal(u.modelGroups.length, 0);
});

test("orbital layout and wires are deterministic and bounded", () => {
  assert.deepEqual(orbitalLayout(7), orbitalLayout(7));
  for (const o of orbitalLayout(7)) {
    assert.ok(Math.abs(Math.hypot(...o.axis) - 1) < 1e-9);
    assert.ok(o.weight > 0 && o.weight <= 1 && o.radialPeak > 0 && o.radialPeak < 1);
  }
  const wires = orbitWires(7, 99);
  assert.ok(wires.length <= 8);
  for (const w of wires) assert.ok(w.a <= CLOUD_BOUND_RADIUS && w.b <= w.a);
});

test("bolt geometry: deterministic by seed, bounded, endpoints exactly pinned", () => {
  const A: [number, number, number] = [1, 2, 3];
  const B: [number, number, number] = [10, -4, 7];
  const x = buildBolt(A, B, { seed: 42 });
  const y = buildBolt(A, B, { seed: 42 });
  assert.deepEqual(x, y);
  assert.notDeepEqual(x, buildBolt(A, B, { seed: 43 }));
  assert.ok(x.segments.length <= MAX_BOLT_VERTICES);
  assert.deepEqual(x.segments[0].a, A);
  const main = x.segments.filter((s) => s.generation === 0);
  assert.deepEqual(main[main.length - 1].b, B);
  const huge = buildBolt(A, B, { seed: 1, levels: 99, branchDepth: 99 });
  assert.ok(huge.segments.length <= MAX_BOLT_VERTICES);
});

test("disposal registry releases everything once and is idempotent (remount-safe)", () => {
  const reg = createRtRegistry();
  let disposed = 0;
  for (let i = 0; i < 5; i += 1) reg.add({ dispose: () => (disposed += 1) });
  reg.add({
    dispose: () => {
      throw new Error("already lost");
    },
  });
  assert.equal(reg.size(), 6);
  assert.equal(reg.disposeAll(), 6);
  assert.equal(disposed, 5);
  assert.equal(reg.size(), 0);
  assert.equal(reg.disposeAll(), 0, "second dispose is a no-op");
  for (let m = 0; m < 50; m += 1) {
    reg.add({ dispose: () => undefined });
    reg.disposeAll();
  }
  assert.equal(reg.size(), 0, "50 remounts leave no live entries");
});
