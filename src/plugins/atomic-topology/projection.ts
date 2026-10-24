/**
 * Pure camera → screen projection for the Atomic topology DOM labels
 * (OR-ATOM-001 v2, UX correction).
 *
 * Why this module exists: the DOM label layer (`overlays/AtomicLabels.tsx`) is
 * pure React — it must NOT import `three` (that would pull the WebGL stack into
 * the jsdom test graph and break the plugin's static-import invariant). But
 * labels have to sit *next to* their rendered atoms, which requires projecting
 * each atom's world position into CSS-pixel screen space with the *live*
 * camera (position + orbit target, after the orbit controls moved them).
 *
 * So the projection math lives here as pure functions (no `three`, no DOM, no
 * clock). The scene (the only place that imports `three`) reads the live
 * `camera.position` + orbit `target` and projects each atom per frame; the DOM
 * overlay reads the results and positions labels imperatively (rAF, no React
 * re-render). The math below reproduces three's perspective + `lookAt`
 * conventions exactly (verified against `Vector3.project(camera)` in
 * `tests/unit/atomic-topology/projection.test.ts`), so projected labels line up
 * with what R3F renders.
 *
 * Deterministic: same inputs → same output. Unit-testable in node/jsdom.
 */

/** A perspective camera described in pure numbers (no `three` object). */
export interface ProjectionCamera {
  /** World-space camera position. */
  position: [number, number, number];
  /** The point the camera looks at (the orbit target). */
  target: [number, number, number];
  /** Vertical field of view in degrees (R3F `camera.fov`). */
  fovDeg: number;
  /** Viewport aspect ratio (width / height). */
  aspect: number;
}

/** The CSS-pixel viewport the projection maps onto (the scene canvas size). */
export interface ProjectionViewport {
  width: number;
  height: number;
}

/** A projected point in CSS pixels, plus whether it is behind the camera. */
export interface ProjectedPoint {
  /** CSS-pixel x within the viewport (0 = left edge). */
  x: number;
  /** CSS-pixel y within the viewport (0 = top edge). */
  y: number;
  /** True when the point is at/behind the camera (should be hidden). */
  behind: true | false;
}

type Vec3 = [number, number, number];

/**
 * Build a projector that maps world-space points to CSS-pixel screen space for
 * a fixed camera + viewport.
 *
 * The camera basis is computed **once** per projector (three orthogonal unit
 * vectors `x`/`y`/`z`), then each projected point is a handful of dot products —
 * cheap enough to call for every atom every frame. The basis is built the same
 * way three's `Object3D.lookAt` builds it:
 *
 *   - `z = normalize(eye - target)`  (points from the look-at point back to the
 *     camera; three's cameras look down -Z, so `z` is the "behind" axis);
 *   - `x = normalize(cross(up, z))`  with `up = (0,1,0)` (a non-collinear
 *     fallback when the camera looks straight up/down);
 *   - `y = cross(z, x)`.
 *
 * For a world point `p`, `v = p - eye`; the camera-space coordinates are
 * `camX = dot(v, x)`, `camY = dot(v, y)`, `camZ = dot(v, z)`. A point in front
 * of the camera has `camZ < 0`. The perspective divide (three's `Perspective-
 * Camera` convention, vertical FOV) is:
 *
 *   focal = 1 / tan(fov/2)
 *   ndcX  = (focal / -camZ) * camX / aspect
 *   ndcY  = (focal / -camZ) * camY
 *
 * then `screen = (ndc * 0.5 + 0.5) * viewport` with Y flipped (screen Y grows
 * downward, NDC Y grows upward).
 *
 * @param camera    the perspective camera (position, target, vertical FOV, aspect).
 * @param viewport  the CSS-pixel canvas size the projection maps onto.
 * @returns a function that projects a single world point.
 */
export function createProjector(
  camera: ProjectionCamera,
  viewport: ProjectionViewport
): (point: Vec3) => ProjectedPoint {
  const [ex, ey, ez] = camera.position;
  const [tx, ty, tz] = camera.target;

  // z = normalize(eye - target).
  let zx = ex - tx;
  let zy = ey - ty;
  let zz = ez - tz;
  let zlen = Math.hypot(zx, zy, zz);
  if (zlen === 0) {
    // Degenerate (eye === target): look down -Z (the three.js default when the
    // camera is not positioned). This keeps the projection well-defined.
    zx = 0;
    zy = 0;
    zz = 1;
    zlen = 1;
  } else {
    zx /= zlen;
    zy /= zlen;
    zz /= zlen;
  }

  // x = normalize(cross(up=(0,1,0), z)) = (zz, 0, -zx).
  let xx = zz;
  let xy = 0;
  let xz = -zx;
  let xlen = Math.hypot(xx, xy, xz);
  if (xlen === 0) {
    // `z` is (anti-)parallel to up (looking straight up/down): use up=(0,0,1)
    // so the cross is non-collinear — cross((0,0,1), z) = (-zy, zx, 0).
    xx = -zy;
    xy = zx;
    xz = 0;
    xlen = Math.hypot(xx, xy, xz);
    if (xlen === 0) {
      // Practically unreachable (z would have to be along x too); use the
      // default right axis so the projection stays well-defined.
      xx = 1;
      xy = 0;
      xz = 0;
      xlen = 1;
    }
  }
  xx /= xlen;
  xy /= xlen;
  xz /= xlen;

  // y = cross(z, x).
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  const fovRad = (camera.fovDeg * Math.PI) / 180;
  const focal = 1 / Math.tan(fovRad / 2);
  const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1;

  return (point: Vec3): ProjectedPoint => {
    const vx = point[0] - ex;
    const vy = point[1] - ey;
    const vz = point[2] - ez;
    const camX = vx * xx + vy * xy + vz * xz;
    const camY = vx * yx + vy * yy + vz * yz;
    const camZ = vx * zx + vy * zy + vz * zz;

    // A point in front of the camera has camZ < 0 (three looks down -Z).
    const inFront = -camZ;
    if (
      inFront <= 1e-6 ||
      !Number.isFinite(camX) ||
      !Number.isFinite(camY) ||
      !Number.isFinite(inFront)
    ) {
      return { x: 0, y: 0, behind: true };
    }

    const pDiv = focal / inFront;
    const ndcX = (pDiv * camX) / aspect;
    const ndcY = pDiv * camY;
    const sx = (ndcX * 0.5 + 0.5) * viewport.width;
    const sy = (-ndcY * 0.5 + 0.5) * viewport.height;

    return { x: sx, y: sy, behind: false };
  };
}

/**
 * Project a single world-space point into CSS-pixel screen space for the given
 * camera + viewport. Convenience wrapper over {@link createProjector} for the
 * one-shot case (the per-frame label path uses `createProjector` to amortize the
 * basis build across all atoms).
 */
export function projectPoint(
  camera: ProjectionCamera,
  viewport: ProjectionViewport,
  point: [number, number, number]
): ProjectedPoint {
  return createProjector(camera, viewport)(point);
}
