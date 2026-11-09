/**
 * Camera fly-in for the opt-in detail view (OR-ATOM Step 11, directive 34). Pure math.
 *
 * The default view's camera is frozen; only when the viewer explicitly opens
 * the detail view does the camera travel. It eases from wherever it is to a
 * LOW, near eye-level pose close to the inspected atom (idea5's "being there"
 * hero shot): the atom fills most of the frame, the board recedes to a visible
 * horizon behind it. The pose is interpolated in spherical coordinates around
 * the atom (distance, elevation, azimuth with a short yaw sweep), then control
 * returns to the unchanged orbit controls; a slow cinematic drift (a bounded
 * yaw sway) keeps the shot alive until the viewer grabs the camera. This module
 * only computes poses; `AtomicScene.tsx` applies them. `cameraFit.ts` is never
 * altered.
 */
/** Hero camera distance from the atom (world units); outside OrbitControls' minimum (200); with the 38 deg fov the whole cloud, rim and orbit wires fit. */
export const DETAIL_HERO_DISTANCE = 300;
/** Kept for the legacy fit-relative helper: never closer than the orbit minimum plus a margin. */
export const DETAIL_MIN_DISTANCE = 205;
/** Near eye-level elevation (radians above the horizontal plane through the atom). */
export const DETAIL_ELEVATION_RAD = 0.2;
/** Telephoto field of view of the settled hero shot (the scene default is 50). */
export const DETAIL_FOV_DEG = 38;
/** Field of view at eased flight progress `e` (lerp from the scene fov to the goal fov). */
export function detailFov(
  baseFovDeg: number,
  e: number,
  goalFovDeg: number = DETAIL_FOV_DEG
): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(e) ? e : 1));
  return baseFovDeg + (goalFovDeg - baseFovDeg) * p;
}
/** Predicted bound-radius fraction of the frame height; the visible cyan rim is ~0.9x of it (measured 61-63% live), inside directive 34.1 55-70%. */
export const DETAIL_TARGET_FRACTION = 0.68;
/** The rim never spans more than this fraction of the frame WIDTH (narrow hosts). */
export const DETAIL_MAX_WIDTH_FRACTION = 0.7;
/** Narrowest telephoto allowed when the framing has to shrink the field of view. */
export const DETAIL_MIN_FOV_DEG = 22;
/** Widest hero fov. */
export const DETAIL_MAX_FOV_DEG = 44;
/**
 * Per-atom world cloud radius as the renderer draws it: the energy-dependent cloud
 * radius multiplier (bounded 0.5..1, as in `shaderParams`) times the atom scale.
 */
export function detailAtomRadius(
  boundRadius: number,
  cloudRadiusMul: number,
  scale: number
): number {
  const mul = Number.isFinite(cloudRadiusMul) ? Math.min(1, Math.max(0.5, cloudRadiusMul)) : 0.8;
  const sc = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return boundRadius * mul * sc;
}
/**
 * Aspect- and atom-aware hero framing: the camera distance and fov that make the
 * atom's rim (world radius `radius`) span {@link DETAIL_TARGET_FRACTION} of the
 * frame height (less on narrow hosts, so the rim stays inside the width). The
 * distance stays outside OrbitControls' frozen minimum; when a small cloud would
 * need a closer camera, the field of view narrows instead (bounded).
 */
export function detailFraming(
  radius: number,
  aspect: number
): { distance: number; fovDeg: number } {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 52;
  const a = Number.isFinite(aspect) && aspect > 0.2 ? aspect : 1.6;
  const frac = Math.min(DETAIL_TARGET_FRACTION, DETAIL_MAX_WIDTH_FRACTION * a);
  // rim fraction of frame height = r / (distance * tan(fov / 2))
  const tanOf = (deg: number) => Math.tan((deg * Math.PI) / 360);
  let distance = r / (frac * tanOf(DETAIL_FOV_DEG));
  let fovDeg = DETAIL_FOV_DEG;
  if (distance < DETAIL_MIN_DISTANCE) {
    distance = DETAIL_MIN_DISTANCE;
    fovDeg = Math.max(DETAIL_MIN_FOV_DEG, (2 * Math.atan(r / (frac * distance)) * 180) / Math.PI);
  } else if (distance > DETAIL_HERO_DISTANCE) {
    distance = Math.min(distance, DETAIL_HERO_DISTANCE * 1.4);
    fovDeg = Math.min(
      DETAIL_MAX_FOV_DEG,
      Math.max(DETAIL_FOV_DEG, (2 * Math.atan(r / (frac * distance)) * 180) / Math.PI)
    );
  }
  return { distance, fovDeg };
}
/**
 * Latest world cloud radius per atom id, written by the scene each frame (the
 * renderer owns the energy state) and read once when a detail flight starts.
 */
export const detailAtomRadii: Map<string, number> = new Map();
/** Fly-in duration (ms). */
export const DETAIL_FLIGHT_MS = 1700;
/** Total yaw swing (radians) accumulated over the flight. */
export const DETAIL_SWEEP_RAD = 0.55;
/** Peak yaw sway of the settled cinematic drift (radians, each side). */
export const DETAIL_DRIFT_AMPLITUDE_RAD = 0.2;
/** Drift period (ms): slow, one full sway every ~38 s. */
export const DETAIL_DRIFT_PERIOD_MS = 38_000;
/** Goal camera distance from the inspected atom for a given base fit distance. */
export function detailGoalDistance(fitDistance: number): number {
  if (!Number.isFinite(fitDistance) || fitDistance <= 0) return DETAIL_MIN_DISTANCE;
  return Math.max(DETAIL_MIN_DISTANCE, Math.min(DETAIL_HERO_DISTANCE, fitDistance * 0.5));
}
/** Smooth ease in/out, clamped to [0, 1]. */
export function easeInOutCubic(t: number): number {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1;
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Eased flight progress for `elapsedMs`; reduced motion jumps straight to the end. */
export function flightProgress(elapsedMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  return easeInOutCubic(elapsedMs / DETAIL_FLIGHT_MS);
}

/**
 * The camera offset (camera - target) at eased progress `e`: distance, elevation
 * and azimuth are interpolated from the start offset `o0` to (`goalDistance`,
 * `goalElevation`, azimuth + `sweep`). Degenerate (zero-length / non-finite)
 * starts fall back to the default +Z viewing direction.
 */
export function flightOffset(
  o0: readonly [number, number, number],
  goalDistance: number,
  e: number,
  sweep: number = DETAIL_SWEEP_RAD,
  goalElevation: number = DETAIL_ELEVATION_RAD
): [number, number, number] {
  const len = Math.hypot(o0[0], o0[1], o0[2]);
  const ok = Number.isFinite(len) && len > 1e-6;
  const d0 = ok ? len : goalDistance;
  const el0 = ok ? Math.asin(Math.max(-1, Math.min(1, o0[1] / len))) : 0.24;
  const az0 = ok && Math.hypot(o0[0], o0[2]) > 1e-9 ? Math.atan2(o0[0], o0[2]) : 0;
  const p = Math.min(1, Math.max(0, Number.isFinite(e) ? e : 1));
  const dist = d0 + (goalDistance - d0) * p;
  const el = el0 + (goalElevation - el0) * p;
  const az = az0 + sweep * p;
  const ce = Math.cos(el);
  return [Math.sin(az) * ce * dist, Math.sin(el) * dist, Math.cos(az) * ce * dist];
}
/**
 * Yaw angular velocity (rad/s) of the settled cinematic drift at `tMs` since the
 * flight ended: the derivative of `A * sin(2*pi*t/T)`, so the sway is bounded
 * (never leaves the framing) and smooth. Zero in reduced motion.
 */
export function driftYawRate(tMs: number, reducedMotion: boolean): number {
  if (reducedMotion || !Number.isFinite(tMs) || tMs < 0) return 0;
  const w = (2 * Math.PI) / (DETAIL_DRIFT_PERIOD_MS / 1000);
  return DETAIL_DRIFT_AMPLITUDE_RAD * w * Math.cos((w * tMs) / 1000);
}
