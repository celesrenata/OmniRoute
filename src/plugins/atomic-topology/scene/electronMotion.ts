/**
 * Decorative electron orbit clock (operator directive 36). Pure, three-free.
 *
 * Electrons used to ride the shared animation phase (`energy.speedMul`, floor
 * 0.15) scaled by each wire's random speed (0.35..0.85) and 1.4, so the slowest
 * orbits of a low-energy atom crawled at ~0.07 rad/s (about 90 s per lap) and
 * read as "static". Electron motion now has its own clock with a floor that is
 * clearly visible at every tier. It follows the ENERGY tier only (never the
 * measured tok/s, which drives the nucleus spin alone) and holds still only for
 * pause (dt = 0) and reduced motion.
 */
/** Electron clock rate at the lowest tier (clock units per second). */
export const ELECTRON_RATE_MIN = 1.0;
/** Added rate at the top tier (speedMul 1). */
export const ELECTRON_RATE_GAIN = 1.6;
/** Smallest |wire speed| the generator emits (orbitalDensity.orbitWires). */
export const WIRE_SPEED_MIN = 0.35;
/** Clock rate for an energy `speedMul` (0..1, or 0 under reduced motion). */
export function electronClockRate(speedMul: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  const m = Number.isFinite(speedMul) ? Math.min(1, Math.max(0, speedMul)) : 0;
  return ELECTRON_RATE_MIN + ELECTRON_RATE_GAIN * m;
}
/** Advance the electron clock; paused (dt <= 0) and reduced motion hold it exactly. */
export function advanceElectronClock(
  clock: number,
  dt: number,
  speedMul: number,
  reducedMotion: boolean
): number {
  if (reducedMotion || !Number.isFinite(dt) || dt <= 0) return clock;
  return clock + Math.min(dt, 0.25) * electronClockRate(speedMul, false);
}
/** Electron angle (radians, wrapped to [0, 2pi)) on a wire at `clock`. */
export function electronAngle(
  wirePhase: number,
  wireSpeed: number,
  clock: number,
  offset: number
): number {
  const v = wirePhase + clock * wireSpeed + offset;
  const tau = Math.PI * 2;
  return ((v % tau) + tau) % tau;
}
