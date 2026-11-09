/**
 * Step 11 — detail-view camera fly-in math (pure).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DETAIL_ELEVATION_RAD,
  DETAIL_FOV_DEG,
  DETAIL_HERO_DISTANCE,
  DETAIL_DRIFT_AMPLITUDE_RAD,
  detailFov,
  detailFraming,
  detailAtomRadius,
  driftYawRate,
  DETAIL_FLIGHT_MS,
  DETAIL_MIN_DISTANCE,
  detailGoalDistance,
  easeInOutCubic,
  flightOffset,
  flightProgress,
} from "../../../src/plugins/atomic-topology/scene/detailFlight.ts";

const len = (v: readonly number[]): number => Math.hypot(v[0], v[1], v[2]);

test("goal distance is the close hero distance, never below the orbit minimum", () => {
  assert.equal(detailGoalDistance(5000), DETAIL_HERO_DISTANCE);
  assert.ok(DETAIL_HERO_DISTANCE > 200, "stays outside OrbitControls.minDistance");
  assert.ok(DETAIL_MIN_DISTANCE > 200);
  assert.equal(detailGoalDistance(100), DETAIL_MIN_DISTANCE);
  assert.equal(detailGoalDistance(NaN), DETAIL_MIN_DISTANCE);
  assert.equal(detailGoalDistance(-4), DETAIL_MIN_DISTANCE);
});
test("telephoto fov lerps from the scene fov to the hero fov", () => {
  assert.equal(detailFov(50, 0), 50);
  assert.equal(detailFov(50, 1), DETAIL_FOV_DEG);
  assert.ok(DETAIL_FOV_DEG < 50);
  assert.equal(detailFov(50, NaN), DETAIL_FOV_DEG);
});
test("drift is a bounded sway and off in reduced motion", () => {
  assert.equal(driftYawRate(1000, true), 0);
  assert.equal(driftYawRate(-5, false), 0);
  // integrate the rate over a full period: net yaw ~ 0 and the excursion stays within the amplitude
  let yaw = 0;
  let max = 0;
  for (let t = 0; t < 38_000; t += 10) {
    yaw += driftYawRate(t, false) * 0.01;
    max = Math.max(max, Math.abs(yaw));
  }
  assert.ok(Math.abs(yaw) < 1e-2);
  assert.ok(max <= DETAIL_DRIFT_AMPLITUDE_RAD + 1e-2);
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

test("flight starts at the current offset and ends low (eye level) at the goal distance", () => {
  const o0: [number, number, number] = [0, 600, 2400];
  const start = flightOffset(o0, 500, 0);
  for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(start[i] - o0[i]) < 1e-6);
  const end = flightOffset(o0, 500, 1);
  assert.ok(Math.abs(len(end) - 500) < 1e-6);
  assert.ok(Math.abs(Math.asin(end[1] / len(end)) - DETAIL_ELEVATION_RAD) < 1e-9);
  // Distance and elevation shrink monotonically on the way in.
  let prevD = Infinity;
  let prevY = Infinity;
  for (let i = 0; i <= 20; i += 1) {
    const o = flightOffset(o0, 500, i / 20);
    assert.ok(len(o) <= prevD + 1e-9);
    assert.ok(o[1] / len(o) <= prevY + 1e-9);
    prevD = len(o);
    prevY = o[1] / len(o);
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

test("hero framing keeps the rim at 55-70% of the frame height for every cloud size and aspect", () => {
  const bound = 52.1;
  for (const mul of [0.5, 0.6, 0.8, 1]) {
    for (const scale of [1, 1.12, 1.6]) {
      for (const aspect of [1.6, 1.67, 2.1]) {
        const r = detailAtomRadius(bound, mul, scale);
        const { distance, fovDeg } = detailFraming(r, aspect);
        assert.ok(distance >= DETAIL_MIN_DISTANCE - 1e-9, "outside OrbitControls minimum");
        const frac = r / (distance * Math.tan((fovDeg * Math.PI) / 360));
        assert.ok(
          frac >= 0.6 && frac <= 0.72,
          `mul ${mul} scale ${scale} aspect ${aspect}: ${frac}`
        );
      }
    }
  }
});
test("narrow hosts keep the rim inside the width", () => {
  const r = detailAtomRadius(52.1, 1, 1);
  const { distance, fovDeg } = detailFraming(r, 0.8);
  const heightFrac = r / (distance * Math.tan((fovDeg * Math.PI) / 360));
  assert.ok(heightFrac <= 0.8 * 0.7 + 1e-9);
});
test("framing falls back for degenerate input", () => {
  const f = detailFraming(NaN, NaN);
  assert.ok(Number.isFinite(f.distance) && Number.isFinite(f.fovDeg));
  assert.equal(detailAtomRadius(52, NaN, NaN), 52 * 0.8);
});
