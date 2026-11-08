import test from "node:test";
import assert from "node:assert/strict";

import {
  FLOOR_OFFSET,
  HUB_SCALE,
  LINK_ARC_FACTOR,
  atomEnergyInput,
  environmentLayoutFor,
  isNeutralAtom,
  linkBaseIntensity,
  linkCurve,
  type SceneAtomInput,
} from "../../../src/plugins/atomic-topology/scene/rt/topologyScene";
import { resolveEnergyState } from "../../../src/plugins/atomic-topology/scene/energyState";
import { CLOUD_BOUND_RADIUS } from "../../../src/plugins/atomic-topology/scene/shaderParams";

const atom = (over: Partial<SceneAtomInput> = {}): SceneAtomInput => ({
  id: "provider:a",
  kind: "provider",
  position: { x: 210, y: 0, z: 0 },
  laneHue: "#a855f7",
  measuredTps: null,
  activeRequests: null,
  visualState: { state: "idle" },
  ...over,
});

test("atomEnergyInput: only measured fields; nothing measured -> idle, not fabricated", () => {
  const idle = resolveEnergyState(atomEnergyInput(atom(), false));
  assert.equal(idle.measured, false);
  const busy = resolveEnergyState(
    atomEnergyInput(atom({ measuredTps: 120, activeRequests: 3 }), false)
  );
  assert.equal(busy.measured, true);
  assert.ok(busy.excitation > idle.excitation);
  // Device atoms: active/queued jobs come from proven device facts.
  const gpu = atomEnergyInput(
    atom({ kind: "gpu", deviceFacts: { activeJobs: 2, queuedJobs: 5 } }),
    false
  );
  assert.equal(gpu.activeRequests, 2);
  assert.equal(gpu.queued, 5);
  // NaN never becomes activity.
  const bad = atomEnergyInput(atom({ measuredTps: Number.NaN }), false);
  assert.equal(bad.measuredTps, null);
});

test("isNeutralAtom: unknown attribution is neutral; the hub never is", () => {
  assert.equal(isNeutralAtom(atom()), true);
  assert.equal(isNeutralAtom(atom({ observedModelIds: ["qwen3"] })), false);
  assert.equal(isNeutralAtom(atom({ kind: "hub", id: "hub" })), false);
});

test("environmentLayoutFor: floor below the lowest atom, one pedestal per atom, positions read-only", () => {
  const atoms = [
    atom({ id: "hub", kind: "hub", position: { x: 0, y: 0, z: 0 } }),
    atom({ position: { x: 210, y: 0, z: 18 } }),
    atom({ id: "provider:b", position: { x: -370, y: 24, z: 5 } }),
  ];
  const before = JSON.stringify(atoms);
  const env = environmentLayoutFor(atoms);
  assert.equal(JSON.stringify(atoms), before, "layout input is never mutated");
  assert.equal(env.floorY, 0 + FLOOR_OFFSET);
  assert.equal(env.pedestals.length, 3);
  assert.equal(env.pedestals[0].scale, HUB_SCALE);
  for (const [i, p] of env.pedestals.entries()) {
    assert.equal(p.x, atoms[i].position.x);
    assert.equal(p.z, atoms[i].position.z);
    assert.ok(p.y < atoms[i].position.y, "pedestal sits under its atom");
  }
  // The corridor never cuts through the topology.
  assert.ok(env.wallX > 370 + CLOUD_BOUND_RADIUS);
  assert.ok(env.farZ < -370);
});

test("environmentLayoutFor: empty / non-finite input is the bench room", () => {
  const env = environmentLayoutFor([atom({ position: { x: Number.NaN, y: 0, z: 0 } })]);
  assert.equal(env.floorY, FLOOR_OFFSET);
  assert.equal(env.pedestals.length, 0);
  assert.ok(Number.isFinite(env.wallX) && Number.isFinite(env.ceilY));
});

test("linkCurve: endpoints are exactly hub and atom (no endpoint motion)", () => {
  const c = linkCurve({ x: 300, y: 24, z: -40 });
  assert.deepEqual(c.a, [0, 0, 0]);
  assert.deepEqual(c.b, [300, 24, -40]);
  const len = Math.hypot(300, 24, -40);
  const mid = [150, 12, -20];
  const bow = Math.hypot(c.c[0] - mid[0], c.c[1] - mid[1], c.c[2] - mid[2]);
  assert.ok(Math.abs(bow - len * LINK_ARC_FACTOR) < 1e-9);
});

test("linkBaseIntensity: active > idle > 0, bounded, error stays visible", () => {
  const active = linkBaseIntensity("active", 1);
  const idle = linkBaseIntensity("idle", 0.3);
  assert.ok(active > idle && idle > 0);
  assert.ok(linkBaseIntensity("error", 0) > 0);
  assert.ok(Number.isFinite(linkBaseIntensity("idle", Number.NaN)));
});
