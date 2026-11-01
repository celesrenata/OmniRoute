/**
 * Unit tests for the pure electron-cloud shell module (OR-ATOM-007):
 * deterministic non-coplanar shells (same seed → identical params across
 * 2 calls), bounded tilts/radii, and the fixed radius/count/speed multipliers
 * the design spec pins (1.0/1.22/1.45, 5/7/9, 1.0/0.82/0.63).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cloudShells,
  fnv1a,
  SHELL_COUNT,
  SHELL_RADIUS_MULTIPLIERS,
  SHELL_ELECTRON_COUNTS,
  SHELL_SPEED_MULTIPLIERS,
} from "@/plugins/atomic-topology/scene/cloudShells";

test("cloudShells: deterministic — same seed → identical shells across 2 calls", () => {
  const seed = fnv1a("provider:anthropic");
  const a = cloudShells(seed);
  const b = cloudShells(seed);
  assert.deepEqual(a, b, "same seed must yield byte-identical shell params");
});

test("cloudShells: three shells with the spec multipliers, counts and speeds", () => {
  const shells = cloudShells(fnv1a("provider:openai"));
  assert.equal(shells.length, SHELL_COUNT);
  assert.deepEqual(
    shells.map((s) => s.radiusMultiplier),
    [...SHELL_RADIUS_MULTIPLIERS],
    "radii nest 1.0 / 1.22 / 1.45"
  );
  assert.deepEqual(
    shells.map((s) => s.electronCount),
    [...SHELL_ELECTRON_COUNTS],
    "electron counts 5 / 7 / 9"
  );
  assert.deepEqual(
    shells.map((s) => s.speedMultiplier),
    [...SHELL_SPEED_MULTIPLIERS],
    "speed multipliers 1.0 / 0.82 / 0.63"
  );
});

test("cloudShells: different seeds diverge (shells are seed-driven, not order-driven)", () => {
  const a = cloudShells(fnv1a("provider:alpha"));
  const b = cloudShells(fnv1a("provider:beta"));
  const sameTilt = a.every((s, i) => s.tilt[0] === b[i].tilt[0] && s.tilt[1] === b[i].tilt[1]);
  assert.ok(!sameTilt, "distinct seeds should not produce identical orientations");
});

test("cloudShells: tilts and phase offsets are bounded radians; non-coplanar per atom", () => {
  const shells = cloudShells(fnv1a("provider:vertex"));
  for (const s of shells) {
    for (const t of s.tilt) {
      assert.ok(
        Number.isFinite(t) && t >= 0 && t < Math.PI * 2,
        `tilt ${t} must be a finite [0,2π)`
      );
    }
    assert.ok(s.phaseOffset >= 0 && s.phaseOffset < Math.PI * 2, "phase offset in [0,2π)");
    assert.ok(s.electronCount >= 1, "at least one electron per shell");
    assert.ok(s.speedMultiplier > 0 && s.speedMultiplier <= 1, "speed multiplier in (0,1]");
  }
  // Non-coplanar: the three shells must not all share one orientation plane.
  const tilts = shells.map((s) => s.tilt[0]);
  assert.ok(new Set(tilts).size > 1, "shells must have distinct tilts (non-coplanar)");
});

test("fnv1a: stable 32-bit hash (deterministic per id)", () => {
  assert.equal(fnv1a("hub"), fnv1a("hub"));
  assert.notEqual(fnv1a("hub"), fnv1a("provider:hub"));
  assert.ok(fnv1a("gpu:0") >= 0 && fnv1a("gpu:0") < 2 ** 32);
});
