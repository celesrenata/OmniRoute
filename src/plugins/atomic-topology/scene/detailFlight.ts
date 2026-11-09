/**
 * Camera fly-in for the opt-in detail view (OR-ATOM Step 11). Pure math.
 *
 * The default view's camera is frozen; only when the viewer explicitly opens
 * the detail view does the camera travel: it eases from wherever it is toward
 * the inspected atom along its current viewing direction while swinging a
 * little around the vertical axis (a short, idea5-style arc), then hands
 * control back to the unchanged orbit controls. This module only computes the
 * pose; `AtomicScene.tsx` applies it. It reuses the existing
 * `computeCameraFocus` framing for the target and never alters `cameraFit.ts`.
 */

/** Detail camera distance as a fraction of the base fit distance (focus view uses 0.38). */
export const DETAIL_DISTANCE_FACTOR = 0.2;
/** Never closer than the orbit controls' own minimum distance (200) plus a margin. */
export const DETAIL_MIN_DISTANCE = 240;
/** Fly-in duration (ms). */
export const DETAIL_FLIGHT_MS = 1700;
/** Total yaw swing (radians) accumulated over the flight. */
export const DETAIL_SWEEP_RAD = 0.55;

/** Goal camera distance from the inspected atom for a given base fit distance. */
export function detailGoalDistance(fitDistance: number): number {
  if (!Number.isFinite(fitDistance) || fitDistance <= 0) return DETAIL_MIN_DISTANCE;
  return Math.max(DETAIL_MIN_DISTANCE, fitDistance * DETAIL_DISTANCE_FACTOR);
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
 * The camera offset (camera - target) at eased progress `e`: the start offset
 * `o0` is shortened/lengthened toward `goalDistance` and yawed by
 * `sweep * e` about the world Y axis. Degenerate (zero-length / non-finite)
 * starts fall back to the default +Z viewing direction.
 */
export function flightOffset(
  o0: readonly [number, number, number],
  goalDistance: number,
  e: number,
  sweep: number = DETAIL_SWEEP_RAD
): [number, number, number] {
  const len = Math.hypot(o0[0], o0[1], o0[2]);
  const ok = Number.isFinite(len) && len > 1e-6;
  const dir: [number, number, number] = ok
    ? [o0[0] / len, o0[1] / len, o0[2] / len]
    : [0, 0.24 / Math.hypot(0.24, 0.97), 0.97 / Math.hypot(0.24, 0.97)];
  const d0 = ok ? len : goalDistance;
  const p = Math.min(1, Math.max(0, Number.isFinite(e) ? e : 1));
  const dist = d0 + (goalDistance - d0) * p;
  const yaw = sweep * p;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [(dir[0] * c + dir[2] * s) * dist, dir[1] * dist, (-dir[0] * s + dir[2] * c) * dist];
}
