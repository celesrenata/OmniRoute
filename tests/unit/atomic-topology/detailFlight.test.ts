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
  DETAIL_DRIFT_PERIOD_MS,
  detailFov,
  detailAtomGeometry,
  detailComposition,
  detailSafeArea,
  viewOffsetPx,
  clearDetailSweep,
  DETAIL_SWEEP_RAD,
  DETAIL_WIRE_REACH,
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
  for (let t = 0; t < DETAIL_DRIFT_PERIOD_MS; t += 10) {
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

/** Project a world point for a camera at `cam` looking at `tgt`, with an NDC lens shift. */
function projectNdc(
  cam: readonly number[],
  tgt: readonly number[],
  fovDeg: number,
  aspect: number,
  shift: readonly number[],
  p: readonly number[]
): [number, number] {
  const zx = cam[0] - tgt[0];
  const zy = cam[1] - tgt[1];
  const zz = cam[2] - tgt[2];
  const zl = Math.hypot(zx, zy, zz);
  const z = [zx / zl, zy / zl, zz / zl];
  const xl = Math.hypot(z[2], 0, -z[0]);
  const x = [z[2] / xl, 0, -z[0] / xl];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const v = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
  const cx = v[0] * x[0] + v[1] * x[1] + v[2] * x[2];
  const cy = v[0] * y[0] + v[1] * y[1] + v[2] * y[2];
  const cz = -(v[0] * z[0] + v[1] * z[1] + v[2] * z[2]);
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  return [(f * cx) / cz / aspect + shift[0], (f * cy) / cz + shift[1]];
}
const CARD = { width: 780, height: 470 };
// Real /home card overlays (CSS px): view toggle, controls, live badge, compact panel, legend.
const CARD_OVERLAYS = [
  { x: 6, y: 6, w: 96, h: 24 },
  { x: 270, y: 8, w: 240, h: 30 },
  { x: 700, y: 8, w: 70, h: 22 },
  { x: 530, y: 40, w: 240, h: 116 },
  { x: 8, y: 386, w: 330, h: 76 },
];
test("safe area removes every overlay and keeps the largest free rectangle", () => {
  const safe = detailSafeArea(CARD.width, CARD.height, CARD_OVERLAYS);
  for (const o of CARD_OVERLAYS) {
    const ix = Math.min(safe.x + safe.w, o.x + o.w) - Math.max(safe.x, o.x);
    const iy = Math.min(safe.y + safe.h, o.y + o.h) - Math.max(safe.y, o.y);
    assert.ok(ix <= 0 || iy <= 0, `overlaps ${JSON.stringify(o)}`);
  }
  assert.ok(safe.w >= CARD.width * 0.3 && safe.h >= CARD.height * 0.3);
  const full = detailSafeArea(800, 500, []);
  assert.deepEqual(full, { x: 0, y: 0, w: 800, h: 500 });
});
test("the composed hero shot keeps the atom, its pad and the horizon inside the safe area", () => {
  const cases = [
    { canvas: CARD, overlays: CARD_OVERLAYS },
    { canvas: { width: 1600, height: 1000 }, overlays: [{ x: 1180, y: 60, w: 400, h: 520 }] },
    { canvas: { width: 1728, height: 1117 }, overlays: [{ x: 8, y: 1020, w: 400, h: 90 }] },
  ];
  for (const { canvas, overlays } of cases) {
    const safe = detailSafeArea(canvas.width, canvas.height, overlays);
    for (const [mul, scale, padR] of [
      [0.6, 1.18, 62],
      [1, 1.18, 62],
      [0.7, 1.6 * 1.18, 99],
    ]) {
      const pos: [number, number, number] = [120, 0, -300];
      const drop = (1 - mul) * 40;
      const geo = detailAtomGeometry(pos, 52.1, mul, scale, drop, -66, padR);
      const comp = detailComposition(geo, pos, canvas, safe);
      assert.ok(comp.distance >= DETAIL_MIN_DISTANCE - 1e-9);
      const aspect = canvas.width / canvas.height;
      const el = DETAIL_ELEVATION_RAD;
      for (const yaw of [0, 1.1, -2.4]) {
        const cam = [
          pos[0] + Math.sin(yaw) * Math.cos(el) * comp.distance,
          pos[1] + Math.sin(el) * comp.distance,
          pos[2] + Math.cos(yaw) * Math.cos(el) * comp.distance,
        ];
        const toPx = (n: [number, number]) => [
          ((n[0] + 1) / 2) * canvas.width,
          ((1 - n[1]) / 2) * canvas.height,
        ];
        const E = geo.envelope;
        const pts = [
          [geo.center[0], geo.center[1] + E, geo.center[2]],
          [geo.center[0], geo.center[1] - E, geo.center[2]],
          [pos[0] + Math.sin(yaw) * padR, geo.padY, pos[2] + Math.cos(yaw) * padR],
          [pos[0] - Math.sin(yaw) * padR, geo.padY, pos[2] - Math.cos(yaw) * padR],
        ];
        for (const p of pts) {
          const [px, py] = toPx(projectNdc(cam, pos, comp.fovDeg, aspect, comp.shift, p));
          assert.ok(
            py >= safe.y - 1 && py <= safe.y + safe.h + 1,
            `y ${py.toFixed(1)} outside safe ${safe.y}..${safe.y + safe.h}`
          );
          assert.ok(px >= safe.x - 1 && px <= safe.x + safe.w + 1);
        }
        // Left/right of the envelope at the atom centre stay inside the safe width.
        const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
        for (const sgn of [1, -1]) {
          const p = [
            geo.center[0] + right[0] * E * sgn,
            geo.center[1],
            geo.center[2] + right[2] * E * sgn,
          ];
          const [px] = toPx(projectNdc(cam, pos, comp.fovDeg, aspect, comp.shift, p));
          assert.ok(px >= safe.x - 2 && px <= safe.x + safe.w + 2, `x ${px} outside safe`);
        }
        // The board horizon (zero-elevation direction) is inside the frame.
        const far = [cam[0] - Math.sin(yaw) * 1e6, cam[1], cam[2] - Math.cos(yaw) * 1e6];
        const [, hy] = toPx(projectNdc(cam, pos, comp.fovDeg, aspect, comp.shift, far));
        assert.ok(hy >= 0 && hy <= canvas.height, `horizon at ${hy}`);
      }
      // The atom is centred in the safe area horizontally.
      const cx = ((comp.shift[0] + 1) / 2) * canvas.width;
      assert.ok(Math.abs(cx - (safe.x + safe.w / 2)) < 1);
    }
  }
});
test("composition falls back for degenerate input and the lens shift maps to pixels", () => {
  const geo = detailAtomGeometry([0, 0, 0], 52, NaN, NaN, NaN, -66, NaN);
  assert.equal(geo.envelope, 52 * 0.8 * DETAIL_WIRE_REACH);
  const c = detailComposition(
    geo,
    [0, 0, 0],
    { width: NaN, height: 0 },
    { x: 0, y: 0, w: 0, h: 0 }
  );
  assert.ok(Number.isFinite(c.distance) && Number.isFinite(c.fovDeg));
  assert.ok(c.shift.every(Number.isFinite));
  assert.deepEqual(viewOffsetPx([0.5, -0.25], 800, 400), { x: -200, y: -50 });
});

test("the hero camera never ends behind or inside a neighbouring atom", () => {
  const target: [number, number, number] = [0, 0, 0];
  const D = 320;
  const el = DETAIL_ELEVATION_RAD;
  const az0 = 0.3;
  // Clear field: keep the default sweep.
  assert.equal(clearDetailSweep(target, target, az0, D, []), DETAIL_SWEEP_RAD);
  // A neighbour exactly on the default end ray (half way to the camera).
  const a = az0 + DETAIL_SWEEP_RAD;
  const blocker = {
    center: [
      Math.sin(a) * Math.cos(el) * 160,
      Math.sin(el) * 160,
      Math.cos(a) * Math.cos(el) * 160,
    ] as const,
    radius: 60,
  };
  const sweep = clearDetailSweep(target, target, az0, D, [blocker]);
  assert.notEqual(sweep, DETAIL_SWEEP_RAD);
  // Over the whole drift sway the segment camera->atom clears the blocker.
  for (const sway of [-DETAIL_DRIFT_AMPLITUDE_RAD, 0, DETAIL_DRIFT_AMPLITUDE_RAD]) {
    const b = az0 + sweep + sway;
    const cam = [Math.sin(b) * Math.cos(el) * D, Math.sin(el) * D, Math.cos(b) * Math.cos(el) * D];
    let min = Infinity;
    for (let i = 0; i <= 100; i += 1) {
      const t = i / 100;
      const p = [cam[0] * (1 - t), cam[1] * (1 - t), cam[2] * (1 - t)];
      min = Math.min(
        min,
        Math.hypot(p[0] - blocker.center[0], p[1] - blocker.center[1], p[2] - blocker.center[2])
      );
    }
    assert.ok(min >= blocker.radius, `sway ${sway}: passes ${min.toFixed(1)} from the blocker`);
  }
});
