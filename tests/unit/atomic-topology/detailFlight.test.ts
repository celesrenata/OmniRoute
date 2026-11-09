/**
 * Step 11 — detail-view camera fly-in math (pure).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DETAIL_DISTANCE_FACTOR,
  DETAIL_FLIGHT_MS,
  DETAIL_MIN_DISTANCE,
  detailGoalDistance,
  easeInOutCubic,
  flightOffset,
  flightProgress,
} from "../../../src/plugins/atomic-topology/scene/detailFlight.ts";

const len = (v: readonly number[]): number => Math.hypot(v[0], v[1], v[2]);

test("goal distance is closer than the focus view (0.38) and never below the orbit minimum", () => {
  assert.ok(DETAIL_DISTANCE_FACTOR < 0.38);
  assert.equal(detailGoalDistance(5000), 5000 * DETAIL_DISTANCE_FACTOR);
  assert.equal(detailGoalDistance(100), DETAIL_MIN_DISTANCE);
  assert.ok(DETAIL_MIN_DISTANCE > 200, "stays outside OrbitControls.minDistance");
  assert.equal(detailGoalDistance(NaN), DETAIL_MIN_DISTANCE);
  assert.equal(detailGoalDistance(-4), DETAIL_MIN_DISTANCE);
});

test("easing is monotonic, clamped and exact at the ends", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(-3), 0);
  assert.equal(easeInOutCubic(9), 1);
  let prev = -1;
  for (let i = 0; i <= 50; i += 1) {
    const v = easeInOutCubic(i / 50);
    assert.ok(v >= prev);
    prev = v;
  }
});

test("reduced motion jumps straight to the end pose (no animation)", () => {
  assert.equal(flightProgress(0, true), 1);
  assert.equal(flightProgress(0, false), 0);
  assert.equal(flightProgress(DETAIL_FLIGHT_MS, false), 1);
  assert.equal(flightProgress(DETAIL_FLIGHT_MS * 3, false), 1);
});

test("flight starts at the current offset and ends at the goal distance", () => {
  const o0: [number, number, number] = [0, 600, 2400];
  const start = flightOffset(o0, 500, 0);
  assert.ok(Math.abs(start[0] - o0[0]) < 1e-9 && Math.abs(start[1] - o0[1]) < 1e-9);
  assert.ok(Math.abs(start[2] - o0[2]) < 1e-9);
  const end = flightOffset(o0, 500, 1);
  assert.ok(Math.abs(len(end) - 500) < 1e-6);
  // Distance shrinks monotonically on the way in; height ratio (pitch) is preserved.
  let prev = Infinity;
  for (let i = 0; i <= 20; i += 1) {
    const o = flightOffset(o0, 500, i / 20);
    assert.ok(len(o) <= prev + 1e-9);
    prev = len(o);
    assert.ok(Math.abs(o[1] / len(o) - o0[1] / len(o0)) < 1e-9, "pitch preserved");
  }
});

test("degenerate starts fall back to a finite pose at the goal distance", () => {
  for (const bad of [
    [0, 0, 0],
    [NaN, 1, 2],
  ] as const) {
    const o = flightOffset(bad, 400, 1);
    assert.ok(o.every(Number.isFinite));
    assert.ok(Math.abs(len(o) - 400) < 1e-6);
  }
});
