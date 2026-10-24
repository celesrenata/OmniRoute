/**
 * Deterministic camera fit / focus helpers for the Atomic 3D scene
 * (OR-ATOM-001 v2, M6).
 *
 * Pure math — no `three`, no R3F, no DOM — so it is importable and testable
 * from the server, node and jsdom contexts. The scene (the *only* place that
 * imports `three`) consumes these results to position the camera and the orbit
 * target.
 *
 * The scene is centered at the origin: the hub nucleus sits at `(0,0,0)` and
 * the ring atoms are placed on deterministic concentric ellipses whose radii
 * are known to this module (see {@link computeFitRadius}). Fitting therefore
 * reduces to "how far back on the camera axis must the camera sit so that the
 * largest ring is fully inside the frustum" — a function of the ring radii,
 * the vertical FOV, and the viewport aspect ratio. Deterministic: same inputs
 * → same output, no clock, no randomness.
 */

/** The largest ring radius the layout can place atoms on (see `layout.ts`). */
export const DEFAULT_FIT_RADIUS = 1010;

/**
 * The smallest radius the camera fit will ever frame. Below this the scene is
 * framed at the default radius so a one-atom fleet does not zoom into a
 * single atom until it fills the frame. This keeps the nucleus + the first
 * ring legible at any fleet size.
 */
export const MIN_FIT_RADIUS = 120;

/**
 * Compute the framing radius from the *actual* layout bounds instead of the
 * constant {@link DEFAULT_FIT_RADIUS}.
 *
 * The layout places the hub at the origin and ring atoms at deterministic
 * world positions (see `layout.ts`). The largest ring in the layout is always
 * `DEFAULT_FIT_RADIUS`, but a small fleet (a few providers on ring 0/1) occupies
 * only a fraction of that radius. Fitting the constant radius frames a small
 * fleet in a huge empty viewport — the camera sits far back and the topology
 * renders tiny. This helper measures the *actual* farthest atom (the hub is
 * the origin, so only the ring placements matter) and adds headroom for the
 * atom radius + electron cloud, then clamps to a sane `[MIN_FIT_RADIUS,
 * DEFAULT_FIT_RADIUS * 1.35]` band:
 *
 * - the lower bound keeps a one-atom fleet from over-zooming;
 * - the upper bound is `DEFAULT_FIT_RADIUS` (the layout cannot exceed it) — the
 *   headroom factor only guards against a future layout growing past the
 *   nominal ring radii.
 *
 * Pure: same positions → same radius; no clock, no DOM, no `three`.
 *
 * @param positions    world-space positions of every ring atom (hub excluded —
 *   it is the origin and never the farthest point). May be empty (hub-only).
 * @param atomRadius   world-unit radius of a single atom + its electron cloud
 *   (the margin to add beyond the centerline of the farthest ring).
 * @returns the framing radius (world units).
 */
export function computeFitRadiusFromPositions(
  positions: ReadonlyArray<{ x: number; y: number; z: number }>,
  atomRadius = 22
): number {
  let maxNorm = 0;
  for (const p of positions) {
    const norm = Math.hypot(p.x, p.y, p.z);
    if (Number.isFinite(norm) && norm > maxNorm) maxNorm = norm;
  }
  // No ring atoms (a hub-only fleet): frame the minimum so the nucleus is the
  // subject of the view instead of the camera zooming into a single point.
  const radius = maxNorm === 0 ? MIN_FIT_RADIUS : maxNorm + atomRadius;
  return Math.min(Math.max(radius, MIN_FIT_RADIUS), DEFAULT_FIT_RADIUS * 1.35);
}

/**
 * A deterministic camera framing: where the camera sits, where it looks, and
 * the far plane that safely contains the scene.
 */
export interface CameraFit {
  /** Camera position in world space (on the +Z axis by default). */
  position: [number, number, number];
  /** The point the camera looks at (the orbit target). */
  lookAt: [number, number, number];
  /** A near plane that keeps the focused target in front of the camera. */
  near: number;
  /** A far plane that contains the scene with headroom. */
  far: number;
}

export interface CameraFitInput {
  /** The radius (world units) to frame — defaults to {@link DEFAULT_FIT_RADIUS}. */
  radius?: number;
  /** Vertical field of view in degrees (R3F `camera.fov`). */
  fovDeg?: number;
  /** Viewport aspect ratio (width / height); `1` for square. */
  aspect?: number;
  /** Optional distance multiplier (default 1.0). */
  distanceFactor?: number;
}

/**
 * Compute a deterministic camera fit that frames `radius` of the scene.
 *
 * The camera sits on the +Z axis at `distance` from the origin, looking at the
 * origin. `distance` is the smallest value that puts the farthest ring point
 * inside the frustum for the given FOV + aspect, clamped to sane min/max so a
 * degenerate viewport (extreme aspect, tiny fov) cannot produce a
 * near/infinite camera.
 *
 * @returns a {@link CameraFit} with finite, ordered near < position distance < far.
 */
export function computeCameraFit(input: CameraFitInput = {}): CameraFit {
  const radius = input.radius ?? DEFAULT_FIT_RADIUS;
  const fovDeg = input.fovDeg ?? 50;
  const aspect =
    input.aspect && Number.isFinite(input.aspect) && input.aspect > 0 ? input.aspect : 1;
  const distanceFactor =
    input.distanceFactor && Number.isFinite(input.distanceFactor) && input.distanceFactor > 0
      ? input.distanceFactor
      : 1;

  const vertical = (fovDeg * Math.PI) / 180;
  // Horizontal FOV from the vertical FOV + aspect: the scene must fit both
  // axes, so the *tighter* (smaller) half-angle governs the required distance.
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
  const halfAngle = Math.min(vertical, horizontal);

  // Distance so a ring point at `radius` (worst case on the screen axis) sits
  // at the frustum edge, then headroom for the arc + atom radius.
  const distance = (radius / Math.tan(halfAngle / 2)) * distanceFactor;

  const clampedDistance = Math.min(Math.max(distance, 100), 20_000);

  return {
    position: [0, clampedDistance * 0.25, clampedDistance],
    lookAt: [0, 0, 0],
    near: 1,
    far: Math.ceil(clampedDistance * 3),
  };
}

/**
 * Compute a deterministic focus framing that centers `target` while still
 * framing `radius` of the scene around it.
 *
 * The camera moves to `target` along the same +Z direction it already faces
 * (no rotation — orbit controls own rotation), so focusing an atom slides the
 * view to that atom rather than swinging the whole scene. Deterministic.
 *
 * @param target the world position to center.
 * @param input  fit options (radius / fov / aspect).
 * @returns a {@link CameraFit} whose `lookAt` is `target`.
 */
export function computeCameraFocus(
  target: { x: number; y: number; z: number },
  input: CameraFitInput = {}
): CameraFit {
  const base = computeCameraFit(input);
  const dx = target.x - base.lookAt[0];
  const dy = target.y - base.lookAt[1];
  const dz = target.z - base.lookAt[2];
  return {
    position: [base.position[0] + dx, base.position[1] + dy, base.position[2] + dz],
    lookAt: [target.x, target.y, target.z],
    near: base.near,
    far: base.far,
  };
}

/**
 * Bounded, finite check used before committing a fit to the camera — a fit
 * that would push the camera to a non-finite or unordered position is rejected
 * (the scene keeps its previous framing rather than corrupting the view).
 */
export function isUsableCameraFit(fit: CameraFit): boolean {
  const all = [...fit.position, ...fit.lookAt];
  for (const v of all) {
    if (!Number.isFinite(v)) return false;
  }
  return fit.far > fit.near;
}
