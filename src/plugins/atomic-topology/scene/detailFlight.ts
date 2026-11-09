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
/** Hero camera distance from the atom (world units); just outside OrbitControls' minimum (200). */
export const DETAIL_HERO_DISTANCE = 214;
/** Kept for the legacy fit-relative helper: never closer than the orbit minimum plus a margin. */
export const DETAIL_MIN_DISTANCE = 205;
/** Near eye-level elevation (radians above the horizontal plane through the atom). */
export const DETAIL_ELEVATION_RAD = 0.1;
/** Telephoto field of view of the settled hero shot (the scene default is 50). */
export const DETAIL_FOV_DEG = 24;
/** Field of view at eased flight progress `e` (lerp from the scene fov to the hero fov). */
export function detailFov(baseFovDeg: number, e: number): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(e) ? e : 1));
  return baseFovDeg + (DETAIL_FOV_DEG - baseFovDeg) * p;
}
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
