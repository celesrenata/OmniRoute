/**
 * Directive 37: routed copper nets (pure router).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { placeBoardParts } from "../../../src/plugins/atomic-topology/scene/boardComponents.ts";
import {
  octilinearRoute,
  offsetPolyline,
  routeTraces,
} from "../../../src/plugins/atomic-topology/scene/traceRouter.ts";

const EXT = { wallX: 1100, ceilY: 700, nearZ: 1000, farZ: -1200, floorY: -66 };
const PADS = [
  { x: 0, z: 0, r: 99 },
  { x: 380, z: -120, r: 62 },
  { x: -420, z: 160, r: 62 },
  { x: 120, z: -520, r: 62 },
];
const layout = () => routeTraces(EXT, PADS, placeBoardParts(EXT, PADS));

test("router is deterministic", () => {
  assert.deepEqual(layout(), layout());
});
test("every leg is 0/45/90 degrees and stays on the board", () => {
  const { segments } = layout();
  assert.ok(segments.length > 300, `only ${segments.length} segments`);
  for (const s of segments) {
    const a = (Math.atan2(s.bz - s.az, s.bx - s.ax) * 180) / Math.PI;
    const m = ((a % 45) + 45) % 45;
    assert.ok(m < 1e-3 || 45 - m < 1e-3, `angle ${a}`);
    for (const [x, z] of [
      [s.ax, s.az],
      [s.bx, s.bz],
    ])
      assert.ok(Math.abs(x) <= EXT.wallX && z >= EXT.farZ && z <= EXT.nearZ);
  }
});
test("nets are long and connected: arc length is continuous along every trace", () => {
  const { segments, joints } = layout();
  // Continuity: each joint sits where one segment ends and the next begins, at one s.
  const key = (x: number, z: number, s: number) =>
    `${x.toFixed(3)},${z.toFixed(3)},${s.toFixed(3)}`;
  const ends = new Set(segments.map((s) => key(s.bx, s.bz, s.s0 + s.len)));
  const starts = new Set(segments.map((s) => key(s.ax, s.az, s.s0)));
  for (const j of joints) {
    assert.ok(ends.has(key(j.x, j.z, j.s)) && starts.has(key(j.x, j.z, j.s)));
  }
  const longest = Math.max(...segments.map((s) => s.s0 + s.len));
  assert.ok(longest > 600, `longest net ${longest}`);
  // Length-weighted: a large share of the copper lies more than 250 units down its net.
  const total = segments.reduce((a, s) => a + s.len, 0);
  const far = segments.filter((s) => s.s0 + s.len > 250).reduce((a, s) => a + s.len, 0);
  assert.ok(far / total > 0.35, `${(far / total).toFixed(2)} of the copper is far down a net`);
});
test("traces end at pads / pins / vias, and the atom pads are fed", () => {
  const { terminals } = layout();
  for (const pad of PADS) {
    const fed = terminals.filter(
      (t) => Math.abs(Math.hypot(t.x - pad.x, t.z - pad.z) - pad.r * 1.04) < pad.r * 0.2
    );
    assert.ok(fed.length >= 3, `pad ${pad.x},${pad.z}: ${fed.length} traces`);
  }
  assert.ok(terminals.some((t) => t.via));
  assert.ok(
    terminals.some((t) => t.kind !== 0),
    "neon channels exist"
  );
});
test("branches start at a parent junction with the parent's pulse train", () => {
  const { segments, joints } = layout();
  const jk = new Map(joints.map((j) => [`${j.x.toFixed(3)},${j.z.toFixed(3)}`, j]));
  const branches = segments.filter((s) => {
    const j = jk.get(`${s.ax.toFixed(3)},${s.az.toFixed(3)}`);
    return j && s.s0 > 0 && Math.abs(j.s - s.s0) < 1e-6 && j.speed === s.speed;
  });
  assert.ok(branches.length > 0);
});
test("routes and offsets are octilinear building blocks", () => {
  const r = octilinearRoute([0, 0], [100, 40], [1, 0], [-1, 0], 10, 0.5);
  assert.deepEqual(r[0], [0, 0]);
  assert.deepEqual(r[r.length - 1], [100, 40]);
  const o = offsetPolyline(r, 4);
  assert.equal(o.length, r.length);
  assert.ok(Math.abs(o[0][1] - 4) < 1e-9);
});
