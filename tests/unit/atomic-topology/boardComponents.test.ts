import test from "node:test";
import assert from "node:assert/strict";
import {
  HV_KINDS,
  MAX_PER_KIND,
  PART_FOOTPRINT,
  PART_KINDS,
  buildHazeField,
  groupByKind,
  placeBoardParts,
  type BoardExtent,
} from "../../../src/plugins/atomic-topology/scene/boardComponents";

const EXT: BoardExtent = { wallX: 1000, ceilY: 780, nearZ: 2200, farZ: -1100, floorY: -66 };
const AVOID = [
  { x: 0, z: 0, r: 100 },
  { x: 300, z: -200, r: 62 },
];

test("placeBoardParts: deterministic; a different seed lays out differently", () => {
  const a = placeBoardParts(EXT, AVOID);
  const b = placeBoardParts(EXT, AVOID);
  assert.deepEqual(a, b);
  const c = placeBoardParts(EXT, AVOID, { seed: 7 });
  assert.notDeepEqual(a.slice(0, 20), c.slice(0, 20));
});

test("placeBoardParts: floor is densest, walls/ceiling sparser, every kind present", () => {
  const parts = placeBoardParts(EXT, AVOID);
  const floor = parts.filter((p) => p.surface === "floor").length;
  const rest = parts.length - floor;
  assert.ok(floor > rest, "floor carries most parts");
  assert.ok(rest > 0, "walls/ceiling carry some");
  const by = groupByKind(parts);
  for (const k of PART_KINDS) {
    assert.ok(by[k].length > 0, k + " is placed");
    assert.ok(by[k].length <= MAX_PER_KIND);
  }
});

test("placeBoardParts: nothing under an atom pad, everything inside the container", () => {
  const parts = placeBoardParts(EXT, AVOID);
  for (const p of parts) {
    if (p.surface === "floor") {
      for (const a of AVOID) {
        assert.ok(Math.hypot(p.x - a.x, p.z - a.z) >= a.r + PART_FOOTPRINT[p.kind] - 1e-6);
      }
      assert.equal(p.y, EXT.floorY);
    }
    assert.ok(Math.abs(p.x) <= EXT.wallX + 1e-6);
    assert.ok(p.z >= EXT.farZ - 1e-6 && p.z <= EXT.nearZ + 1e-6);
    assert.ok(p.y >= EXT.floorY - 1e-6 && p.y <= EXT.ceilY + 1e-6);
    assert.ok(Number.isFinite(p.spin) && p.variant >= 0 && p.variant < 1);
  }
});

test("placeBoardParts: large floor parts do not overlap their neighbours", () => {
  const floor = placeBoardParts(EXT, [], { floorDensity: 1 }).filter((p) => p.surface === "floor");
  const big = floor.filter((p) => PART_FOOTPRINT[p.kind] >= 17);
  assert.ok(big.length > 0);
  for (const p of big) {
    for (const q of floor) {
      if (p === q) continue;
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      assert.ok(
        d >= (PART_FOOTPRINT[p.kind] + PART_FOOTPRINT[q.kind]) * 0.45,
        p.kind + "/" + q.kind
      );
    }
  }
});

test("buildHazeField: only magnetic / high-voltage floor parts cast haze, bounded 0..1", () => {
  const parts = placeBoardParts(EXT, AVOID);
  assert.ok(parts.some((p) => p.surface === "floor" && HV_KINDS.has(p.kind)));
  const field = buildHazeField(parts, EXT, 64);
  assert.equal(field.length, 64 * 64);
  assert.ok(field.every((v) => v >= 0 && v <= 1));
  assert.ok(
    field.some((v) => v > 0.5),
    "haze is strongest at the parts"
  );
  const none = buildHazeField(
    parts.filter((p) => !HV_KINDS.has(p.kind)),
    EXT,
    64
  );
  assert.ok(
    none.every((v) => v === 0),
    "no HV parts -> no haze"
  );
});
