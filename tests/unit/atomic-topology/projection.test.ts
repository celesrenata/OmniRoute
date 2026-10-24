/**
 * Atomic projection math — pure camera → screen projection (OR-ATOM-001 v2,
 * UX correction: projected labels).
 *
 * The label overlay is pure React and must stay three-free, so the projection
 * math lives in `src/plugins/atomic-topology/projection.ts` as pure functions.
 * This test verifies that pure math against three's own
 * `PerspectiveCamera` + `Vector3.project(camera)` numerically — the same
 * lookAt basis and perspective convention — so projected DOM labels line up
 * with what R3F actually renders.
 *
 * `three` is imported ONLY here (a test), never in the plugin's static graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PerspectiveCamera, Vector3 } from "three";

import {
  createProjector,
  projectPoint,
  type ProjectionCamera,
} from "@/plugins/atomic-topology/projection";

/** Build a live three perspective camera matching the pure {@link ProjectionCamera}. */
function buildThreeCamera(camera: ProjectionCamera): PerspectiveCamera {
  // The three aspect MUST mirror the pure camera's aspect — the perspective
  // matrix's x-shear divides by it, so a mismatch (e.g. hardcoding 1) would
  // silently shift every horizontal projection.
  const cam = new PerspectiveCamera(camera.fovDeg, camera.aspect, 0.1, 10000);
  cam.position.set(camera.position[0], camera.position[1], camera.position[2]);
  cam.up.set(0, 1, 0);
  cam.lookAt(new Vector3(camera.target[0], camera.target[1], camera.target[2]));
  cam.updateMatrixWorld();
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  cam.updateProjectionMatrix();
  return cam;
}

/** Map three's NDC (x/y in [-1,1], +y up) to the same CSS pixels as the projector. */
function ndcToCssPx(
  ndc: { x: number; y: number },
  width: number,
  height: number
): { x: number; y: number } {
  return {
    x: (ndc.x * 0.5 + 0.5) * width,
    y: (-ndc.y * 0.5 + 0.5) * height,
  };
}

/** Assert the pure projector matches three's projection for a set of points. */
function assertMatchesThree(
  camera: ProjectionCamera,
  width: number,
  height: number,
  points: [number, number, number][]
): void {
  const cam = buildThreeCamera(camera);
  const project = createProjector(camera, { width, height });
  for (const p of points) {
    const three = ndcToCssPx(new Vector3(p[0], p[1], p[2]).project(cam), width, height);
    const ours = project(p);
    assert.ok(
      Math.abs(ours.x - three.x) < 1e-4,
      `x mismatch for ${JSON.stringify(p)}: ours=${ours.x} three=${three.x}`
    );
    assert.ok(
      Math.abs(ours.y - three.y) < 1e-4,
      `y mismatch for ${JSON.stringify(p)}: ours=${ours.y} three=${three.y}`
    );
  }
}

/* ------------------------------------------------------------------ */
/* createProjector — exact axis-aligned math                            */
/* ------------------------------------------------------------------ */

test("createProjector: a point directly ahead projects to the exact center", () => {
  const camera: ProjectionCamera = {
    position: [0, 0, 1000],
    target: [0, 0, 0],
    fovDeg: 50,
    aspect: 1,
  };
  const project = createProjector(camera, { width: 1000, height: 1000 });

  // The look-at target is straight down the camera axis → NDC (0,0).
  const center = project([0, 0, 0]);
  assert.equal(center.behind, false);
  assert.ok(Math.abs(center.x - 500) < 1e-9, `x ${center.x}`);
  assert.ok(Math.abs(center.y - 500) < 1e-9, `y ${center.y}`);
});

test("createProjector: world +X maps to screen right, +Y maps to screen up", () => {
  const camera: ProjectionCamera = {
    position: [0, 0, 1000],
    target: [0, 0, 0],
    fovDeg: 50,
    aspect: 1,
  };
  const project = createProjector(camera, { width: 1000, height: 1000 });
  const focal = 1 / Math.tan((50 * Math.PI) / 180 / 2);

  // +X world point → NDC x = focal * 100 / 1000 → right of center.
  const right = project([100, 0, 0]);
  const expectedRightX = (focal * (100 / 1000) * 0.5 + 0.5) * 1000;
  assert.ok(Math.abs(right.x - expectedRightX) < 1e-9, `x ${right.x}`);
  assert.ok(Math.abs(right.y - 500) < 1e-9, `y ${right.y}`);

  // +Y world point → NDC y = focal * 100 / 1000 → ABOVE center → smaller CSS y.
  const up = project([0, 100, 0]);
  const expectedUpY = (-focal * (100 / 1000) * 0.5 + 0.5) * 1000;
  assert.ok(Math.abs(up.x - 500) < 1e-9, `x ${up.x}`);
  assert.ok(Math.abs(up.y - expectedUpY) < 1e-9, `y ${up.y}`);
  assert.ok(up.y < 500, "+Y must project above the center line");
});

test("createProjector: aspect widens the horizontal field (points spread wider)", () => {
  const camera: ProjectionCamera = {
    position: [0, 0, 1000],
    target: [0, 0, 0],
    fovDeg: 50,
    aspect: 2, // 2:1 — the horizontal FOV is wider than the vertical.
  };
  const narrow = createProjector({ ...camera, aspect: 1 }, { width: 1000, height: 1000 });
  const wide = createProjector(camera, { width: 1000, height: 1000 });

  // Same world +X point: the wide viewport's NDC x is halved by the aspect,
  // so it sits closer to center.
  const at: [number, number, number] = [200, 0, 0];
  assert.ok(
    wide(at).x < narrow(at).x,
    "a wider aspect must pull the same world point toward center"
  );
});

/* ------------------------------------------------------------------ */
/* createProjector — off-axis cameras (lookAt basis correctness)       */
/* ------------------------------------------------------------------ */

test("createProjector: off-axis camera matches three.js numerically (x-basis)", () => {
  // A camera that is NOT on the +Z axis: the lookAt x/y basis must be built
  // from the actual eye→target vector. This is the case the old
  // `x = (zy, 0, -zx)` cross-product typo failed on — only a pure +Z camera
  // masked it (where zx = 0, both reduce to (1,0,0)).
  const camera: ProjectionCamera = {
    position: [400, 300, 600],
    target: [0, 0, 0],
    fovDeg: 50,
    aspect: 16 / 9,
  };
  const points: [number, number, number][] = [
    [0, 0, 0], // the look-at target
    [200, 100, -50],
    [-300, 150, 200],
    [100, -200, 0],
    [530, 120, -80], // a ring atom far out
  ];
  assertMatchesThree(camera, 1280, 720, points);
});

test("createProjector: pan (target off the origin) matches three.js", () => {
  const camera: ProjectionCamera = {
    position: [0, 250, 1000],
    target: [0, 0, 0],
    fovDeg: 50,
    aspect: 1,
  };
  // Panning the orbit target moves the whole image; the target itself must
  // still sit at the viewport center.
  assertMatchesThree(camera, 800, 600, [
    [0, 0, 0],
    [150, 0, 0],
    [0, 200, 0],
  ]);

  const project = createProjector(camera, { width: 800, height: 600 });
  const atTarget = project([0, 0, 0]);
  assert.ok(Math.abs(atTarget.x - 400) < 1e-6, "target → center x");
  assert.ok(Math.abs(atTarget.y - 300) < 1e-6, "target → center y");
});

/* ------------------------------------------------------------------ */
/* behind-the-camera handling                                          */
/* ------------------------------------------------------------------ */

test("createProjector: points at/behind the camera are flagged behind", () => {
  const camera: ProjectionCamera = {
    position: [0, 0, 1000],
    target: [0, 0, 0],
    fovDeg: 50,
    aspect: 1,
  };
  const project = createProjector(camera, { width: 1000, height: 1000 });

  // Exactly at the eye → degenerate (camZ = 0) → behind.
  assert.equal(project([0, 0, 1000]).behind, true);
  // Beyond the camera along +Z (further back) → behind.
  assert.equal(project([0, 0, 2000]).behind, true);
  // In front (toward/ past the target) → not behind.
  assert.equal(project([0, 0, 0]).behind, false);
  assert.equal(project([0, 0, -500]).behind, false);
});

/* ------------------------------------------------------------------ */
/* projectPoint convenience + degenerate inputs                         */
/* ------------------------------------------------------------------ */

test("projectPoint: matches createProjector for a single point", () => {
  const camera: ProjectionCamera = {
    position: [400, 300, 600],
    target: [0, 0, 0],
    fovDeg: 50,
    aspect: 1.6,
  };
  const a = projectPoint(camera, { width: 1200, height: 750 }, [100, -40, 60]);
  const b = createProjector(camera, { width: 1200, height: 750 })([100, -40, 60]);
  assert.deepEqual(a, b);
});

test("projectPoint: an invalid aspect falls back to square (aspect 1)", () => {
  const base: ProjectionCamera = {
    position: [0, 0, 1000],
    target: [0, 0, 0],
    fovDeg: 50,
    aspect: 1,
  };
  const viewport = { width: 1000, height: 1000 };
  const ref = projectPoint(base, viewport, [100, 0, 0]);
  for (const bad of [NaN, Infinity, -5, 0]) {
    const out = projectPoint({ ...base, aspect: bad }, viewport, [100, 0, 0]);
    assert.deepEqual(out, ref, `aspect ${bad} must fall back to 1`);
  }
});

test("createProjector: eye === target degrades to a well-defined -Z look", () => {
  // Degenerate: the camera sits on the target. The basis must stay
  // orthogonal and finite (no NaN) — look down -Z by default.
  const camera: ProjectionCamera = {
    position: [100, 50, 900],
    target: [100, 50, 900],
    fovDeg: 50,
    aspect: 1,
  };
  const project = createProjector(camera, { width: 1000, height: 1000 });
  const ahead = project([100, 50, 800]); // in front along -Z
  assert.equal(ahead.behind, false);
  assert.ok(Number.isFinite(ahead.x) && Number.isFinite(ahead.y));
  const behind = project([100, 50, 1000]); // +Z is behind the -Z look
  assert.equal(behind.behind, true);
});
