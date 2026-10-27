/**
 * Atomic camera fit / focus — deterministic framing math (OR-ATOM-001 v2, M6).
 *
 * Pure, three-free behavior: the fit/focus framing, the sane near/far clamps,
 * the aspect-driven half-angle rule, the `isUsableCameraFit` guard, and the
 * focus slide (the camera translates along its existing axis — no rotation).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeCameraFit,
  computeCameraFocus,
  computeFitRadiusFromPositions,
  isUsableCameraFit,
  DEFAULT_FIT_RADIUS,
  MIN_FIT_RADIUS,
} from "@/plugins/atomic-topology/cameraFit";

/* ------------------------------------------------------------------ */
/* computeCameraFit                                                    */
/* ------------------------------------------------------------------ */

test("computeCameraFit: defaults frame the default radius at fov 50 / aspect 1", () => {
  assert.equal(DEFAULT_FIT_RADIUS, 1010);
  const fit = computeCameraFit();
  const vertical = (50 * Math.PI) / 180;
  // Square viewport: vertical half-angle governs.
  const expected = 1010 / Math.tan(vertical / 2);

  assert.deepEqual(fit.lookAt, [0, 0, 0]);
  assert.equal(fit.near, 1);
  assert.ok(Math.abs(fit.position[2] - expected) < 1e-9, "z distance " + fit.position[2]);
  assert.ok(Math.abs(fit.position[1] - expected * 0.25) < 1e-9, "y offset " + fit.position[1]);
  assert.equal(fit.position[0], 0);
  assert.equal(fit.far, Math.ceil(expected * 3));
  // The framing is usable and ordered.
  assert.ok(isUsableCameraFit(fit));
  assert.ok(fit.far > fit.position[2]);
});

test("computeCameraFit: deterministic — same inputs give identical output", () => {
  const a = computeCameraFit({ radius: 500, fovDeg: 60, aspect: 1.6 });
  const b = computeCameraFit({ radius: 500, fovDeg: 60, aspect: 1.6 });
  assert.deepEqual(a, b);
});

test("computeCameraFit: wider aspect widens the frame — the tighter axis governs", () => {
  const fit = (aspect: number) => computeCameraFit({ radius: 1000, fovDeg: 50, aspect });
  const portrait = fit(0.5);
  const square = fit(1);
  const landscape = fit(2);

  // A narrower viewport demands a farther camera; a wider one cannot get
  // any closer than the square — once the horizontal half-angle exceeds the
  // vertical FOV, the vertical axis governs the framing again.
  assert.ok(portrait.position[2] > square.position[2], "portrait farther than square");
  assert.ok(
    Math.abs(landscape.position[2] - square.position[2]) < 1e-9,
    "landscape frames at the same distance as square"
  );

  const vertical = (50 * Math.PI) / 180;
  // aspect < 1 → horizontal half-angle governs (it is tighter than the fov).
  const portraitHorizontal = 2 * Math.atan(Math.tan(vertical / 2) * 0.5);
  assert.ok(
    Math.abs(portrait.position[2] - 1000 / Math.tan(portraitHorizontal / 2)) < 1e-9,
    "portrait framed by the horizontal fov"
  );
  // aspect > 1 → the horizontal half-angle exceeds the vertical fov, so the
  // vertical axis governs (the same framing as the square).
  assert.ok(
    Math.abs(landscape.position[2] - 1000 / Math.tan(vertical / 2)) < 1e-9,
    "landscape framed by the vertical fov"
  );
});

test("computeCameraFit: distanceFactor scales the framing", () => {
  const base = computeCameraFit({ radius: 500 });
  const scaled = computeCameraFit({ radius: 500, distanceFactor: 2 });
  assert.ok(Math.abs(scaled.position[2] - base.position[2] * 2) < 1e-9);
  assert.equal(scaled.far, Math.ceil(base.position[2] * 2 * 3));
});

test("computeCameraFit: degenerate inputs fall back to sane, finite values", () => {
  // aspect <= 0 / non-finite → treated as 1 (square).
  const square = computeCameraFit({ radius: 500 });
  for (const bad of [0, -1, NaN, Infinity, undefined]) {
    assert.deepEqual(computeCameraFit({ radius: 500, aspect: bad }), square);
  }
  // distanceFactor <= 0 / non-finite → treated as 1.
  for (const bad of [0, -1, NaN, Infinity, undefined]) {
    assert.deepEqual(computeCameraFit({ radius: 500, distanceFactor: bad }), square);
  }
  // Tiny radius clamps up to the minimum distance (100).
  const tiny = computeCameraFit({ radius: 1 });
  assert.equal(tiny.position[2], 100);
  assert.equal(tiny.far, 300);
  // Enormous radius clamps down to the maximum distance (20000).
  const huge = computeCameraFit({ radius: 1e9, fovDeg: 50, aspect: 1 });
  assert.equal(huge.position[2], 20_000);
  assert.equal(huge.far, 60_000);
  assert.ok(isUsableCameraFit(huge));
  assert.ok(isUsableCameraFit(tiny));
});

/* ------------------------------------------------------------------ */
/* computeCameraFocus                                                  */
/* ------------------------------------------------------------------ */

test("computeCameraFocus: slides the view to the target along the existing axis", () => {
  const target = { x: 100, y: -200, z: 300 };
  const focus = computeCameraFocus(target, { radius: 500, fovDeg: 50, aspect: 1 });
  const base = computeCameraFit({ radius: 500, fovDeg: 50, aspect: 1 });

  assert.deepEqual(focus.lookAt, [100, -200, 300]);
  // No rotation — the camera keeps its +Z facing: it simply translates.
  assert.ok(Math.abs(focus.position[0] - (base.position[0] + 100)) < 1e-9);
  assert.ok(Math.abs(focus.position[1] - (base.position[1] - 200)) < 1e-9);
  assert.ok(Math.abs(focus.position[2] - (base.position[2] + 300)) < 1e-9);
  // Same framing planes as the base fit.
  assert.equal(focus.near, base.near);
  assert.equal(focus.far, base.far);
});

test("computeCameraFocus: focusing the origin reproduces the plain fit", () => {
  assert.deepEqual(computeCameraFocus({ x: 0, y: 0, z: 0 }), computeCameraFit());
});

/* ------------------------------------------------------------------ */
/* isUsableCameraFit                                                   */
/* ------------------------------------------------------------------ */

test("isUsableCameraFit: rejects non-finite or unordered frams", () => {
  assert.ok(isUsableCameraFit({ position: [0, 1, 2], lookAt: [0, 0, 0], near: 1, far: 100 }));
  assert.ok(!isUsableCameraFit({ position: [0, 1, NaN], lookAt: [0, 0, 0], near: 1, far: 100 }));
  assert.ok(
    !isUsableCameraFit({ position: [0, 1, 2], lookAt: [Infinity, 0, 0], near: 1, far: 100 })
  );
  assert.ok(!isUsableCameraFit({ position: [0, 1, 2], lookAt: [0, 0, 0], near: 5, far: 5 }));
  assert.ok(!isUsableCameraFit({ position: [0, 1, 2], lookAt: [0, 0, 0], near: 10, far: 5 }));
});

/* ------------------------------------------------------------------ */
/* computeFitRadiusFromPositions                                       */
/* ------------------------------------------------------------------ */

test("computeFitRadiusFromPositions: frames the farthest ring atom + atom margin", () => {
  // The hub is the origin, so only the ring placements matter. The farthest
  // point here is at norm 210 (ring 0) → 210 + the default 22 margin.
  const positions = [
    { x: 210, y: 0, z: 0 },
    { x: -100, y: 50, z: 0 },
    { x: 0, y: 0, z: 30 },
  ];
  assert.equal(computeFitRadiusFromPositions(positions), 210 + 22);
  // A custom atom radius (atom + electron cloud) widens the framing.
  assert.equal(computeFitRadiusFromPositions(positions, 38), 210 + 38);
});

test("computeFitRadiusFromPositions: uses the 3D norm, not just the x extent", () => {
  // An atom at (120, 90, 0) has norm 150 — larger than its x extent alone.
  assert.equal(computeFitRadiusFromPositions([{ x: 120, y: 90, z: 0 }]), 150 + 22);
});

test("computeFitRadiusFromPositions: hub-only (no ring atoms) frames the minimum", () => {
  assert.equal(computeFitRadiusFromPositions([]), MIN_FIT_RADIUS);
  // A lone atom closer than the minimum does not over-zoom.
  assert.equal(computeFitRadiusFromPositions([{ x: 40, y: 0, z: 0 }]), MIN_FIT_RADIUS);
});

test("computeFitRadiusFromPositions: clamps to [MIN_FIT_RADIUS, DEFAULT_FIT_RADIUS * 1.35]", () => {
  assert.equal(MIN_FIT_RADIUS, 120);
  // Small positions clamp up to the minimum.
  assert.equal(computeFitRadiusFromPositions([{ x: 0, y: 0, z: 50 }]), MIN_FIT_RADIUS);
  // Positions beyond the largest ring clamp down to the headroom cap.
  const cap = DEFAULT_FIT_RADIUS * 1.35;
  assert.equal(computeFitRadiusFromPositions([{ x: 2000, y: 0, z: 0 }]), cap);
});

test("computeFitRadiusFromPositions: maxRadius raises the cap for the outer device band (OR-ATOM-005 T5.4)", () => {
  const positions = [{ x: 1200, y: 0, z: 0 }];
  // Without a cap override the default headroom cap (1363.5) clamps 1222 → OK
  // here, but the real device band (e.g. a ring at 1010+160=1170 + margin)
  // can exceed it: the farthest device atom must NOT be clipped.
  const defaultCap = DEFAULT_FIT_RADIUS * 1.35;
  assert.equal(computeFitRadiusFromPositions(positions), 1200 + 22);
  // A device band whose farthest atom is at 1400 + margin: without maxRadius
  // the radius is clamped to 1363.5 (atom clipped); with maxRadius=1438 it is
  // framed in full (1400 + 38 margin, the band's own cap).
  const farDevice = [{ x: 1400, y: 0, z: 0 }];
  assert.equal(
    computeFitRadiusFromPositions(farDevice, 38),
    defaultCap,
    "no maxRadius → default cap clips"
  );
  assert.equal(
    computeFitRadiusFromPositions(farDevice, 38, 1438),
    1400 + 38,
    "maxRadius → outer band framed"
  );
  // maxRadius below the measured radius is ignored (the default cap wins) —
  // a stale band cap never shrinks the framing.
  assert.equal(computeFitRadiusFromPositions(farDevice, 38, 1000), defaultCap);
});

test("computeFitRadiusFromPositions: ignores non-finite positions, deterministic", () => {
  const positions = [
    { x: NaN, y: 0, z: 0 },
    { x: 300, y: 0, z: 0 },
    { x: 0, y: 0, z: Infinity },
  ];
  assert.equal(computeFitRadiusFromPositions(positions), 300 + 22);
  assert.equal(computeFitRadiusFromPositions(positions), computeFitRadiusFromPositions(positions));
});

test("computeFitRadiusFromPositions: real layout bounds sit far below the default", () => {
  // Regression guard for the UX correction: a small fleet (ring 0/1 only) must
  // NOT frame the constant `DEFAULT_FIT_RADIUS` (1010). A few atoms on the first
  // two rings frame close enough that the topology fills the viewport.
  const smallFleet = [
    { x: 210, y: 24, z: 0 }, // ring 0
    { x: -210, y: 24, z: 0 },
    { x: 370, y: 48, z: 0 }, // ring 1
    { x: -370, y: 48, z: 0 },
  ];
  const radius = computeFitRadiusFromPositions(smallFleet, 38);
  assert.ok(radius < DEFAULT_FIT_RADIUS, `radius ${radius} must be < ${DEFAULT_FIT_RADIUS}`);
  // Full fleet (outermost ring) frames the default radius (within headroom).
  const fullFleet = [
    { x: 1010, y: 144, z: 0 },
    { x: 1010, y: 144, z: 18 },
    { x: -1010, y: 144, z: 0 },
  ];
  const fullRadius = computeFitRadiusFromPositions(fullFleet, 38);
  assert.ok(fullRadius > 0 && Number.isFinite(fullRadius));
  assert.ok(fullRadius <= DEFAULT_FIT_RADIUS * 1.35);
});
