/**
 * Pure motion math for the Atomic scene (OR-ATOM-007).
 *
 * No `three`, no DOM, no `Math.random`, no clock. The scene components consume
 * these pure functions so the timing/easing behavior is deterministic and
 * unit-testable in Node. Everything is driven by a *pause-aware accumulated
 * clock* (see {@link advanceSceneTime}) so `paused` freezes animation exactly
 * and resumes without a jump (interaction-design: bounded, continuous motion).
 */

/** A mutable pause-aware clock shared by the scene. `now` is accumulated seconds. */
export interface SceneClock {
  now: number;
}

/**
 * Clamp on a single frame's delta so a background-tab spike (e.g. a 5 s gap
 * while the tab was hidden) cannot fling the scene forward (web-quality-
 * performance: bounded, allocation-free per-frame work).
 */
export const MAX_FRAME_DELTA = 0.1;

/**
 * Advance a pause-aware clock by one frame.
 *
 * - `paused` → returns the clock's time **unchanged** (accumulates exactly 0,
 *   so a frozen scene holds a static frame and resumes contiguously).
 * - otherwise adds `min(delta, MAX_FRAME_DELTA)`.
 *
 * Mutates and returns the clock's new time. Pure with respect to inputs
 * (same clock + same delta + same paused → same result).
 */
export function advanceSceneTime(clock: SceneClock, deltaSeconds: number, paused: boolean): number {
  if (paused) return clock.now;
  clock.now += Math.min(deltaSeconds, MAX_FRAME_DELTA);
  return clock.now;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Symmetric ease-in-out (smoothstep). Maps 0→0, 0.5→0.5, 1→1; slow at the
 * ends, fast through the middle. Used for the active energy pulse so a comet
 * accelerates out of the nucleus, then eases into the atom (interaction-
 * design: ease-in-out for a continuous one-shot cycle).
 */
export function easeInOut(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * Sharp ease-out (cubic). Maps 0→0, 1→1; fast at the start, decelerating.
 * Used for the one-shot completion flash so the impulse lands hard and then
 * decays quickly (interaction-design: ease-out for a one-shot impulse,
 * ~300 ms band).
 */
export function easeOutSharp(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

/**
 * A subtle scale pulsation for "breathing" cores.
 *
 * Returns a scale multiplier in `[1 - amplitude, 1 + amplitude]` when
 * `active`; exactly `1` (static) when `active` is false or the period is not
 * positive. The period ties the breathing to the atom's spin mode (a measured
 * rate breathes at a human-readable cadence) and `paused`/reduced-motion
 * deactivate it so the frame is static (accessibility: prefers-reduced-motion
 * → static render).
 */
export function breathingScale(
  timeSeconds: number,
  periodSeconds: number,
  amplitude: number,
  active: boolean
): number {
  if (!active || periodSeconds <= 0) return 1;
  return 1 + amplitude * Math.sin((Math.PI * 2 * timeSeconds) / periodSeconds);
}

/**
 * A looping 0..1 phase for continuous motion (the active energy pulse).
 * Wraps continuously so a paused/resumed clock does not cause a jump.
 * Returns 0 for a non-positive period (no motion).
 */
export function pulsePhase(timeSeconds: number, periodSeconds: number): number {
  if (periodSeconds <= 0) return 0;
  const m = timeSeconds % periodSeconds;
  return (m < 0 ? m + periodSeconds : m) / periodSeconds;
}

/** Inputs to {@link motionParams} (the reduced-motion gate). */
export interface MotionParamsInput {
  /** `matchMedia("(prefers-reduced-motion: reduce)")` — SSR-safe: false when absent. */
  reducedMotion: boolean;
  /** The atom's resolved spin speed (rad/s). */
  spinValue: number;
  /** The atom's spin provenance mode. */
  spinMode: "measured" | "measured-zero" | "unavailable";
}

/** Static motion parameters for one atom (drives spin/breath/pulse gating). */
export interface MotionParams {
  /** Whether cloud shells advance (continuous orbital motion). */
  spinActive: boolean;
  /** Whether the core breathes (scale pulsation). */
  breathActive: boolean;
  /** The breathing period in seconds (slow, human-readable). */
  breathPeriod: number;
}

/**
 * Resolve the static motion parameters for an atom.
 *
 * **accessibility (prefers-reduced-motion)**: when `reducedMotion` is true,
 * every continuous motion is OFF — the scene renders a static frame with the
 * state colors still visible. Otherwise motion is gated by the *data*:
 * spin/breathing run only when a rate was actually observed
 * (`spinMode === "measured"` with `spinValue > 0`) — a measured-zero or
 * unavailable spin does not fabricate motion (no fabricated animation).
 *
 * The breathing period is fixed at 3 s (a slow, subtle cadence — the
 * interaction-design "ambient" band, not a choreographed animation).
 */
export function motionParams(input: MotionParamsInput): MotionParams {
  const active = !input.reducedMotion && input.spinMode === "measured" && input.spinValue > 0;
  return {
    spinActive: active,
    breathActive: active,
    breathPeriod: 3,
  };
}
