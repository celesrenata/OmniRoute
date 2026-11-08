/**
 * Atomic energy state (OR-ATOM raytraced renderer, Gate A).
 *
 * Pure, three-free. Maps *measured* activity to the atom's visual energy:
 * an idle atom sits in a LOWER ENERGY STATE (dimmer, calmer, tighter cloud,
 * slower, colour fading toward grey, but still rich and dimensional), while a
 * measured/excited atom is brighter, saturated and energetic.
 *
 * Honesty contract: decorative idle motion (a very slow noise-phase drift) is
 * never presented as measured workload — {@link EnergyState.measured} is only
 * true when real activity was supplied, and nucleus spin is not derived here
 * (it stays strictly bound to `measuredTps` in `nucleusMotion.ts`).
 */

/** Inputs: only measured telemetry plus the staleness/accessibility flags. */
export interface EnergyInput {
  /** Measured tokens/second, or null when unmeasured. */
  measuredTps: number | null;
  /** Measured in-flight requests (>= 0), or null when unmeasured. */
  activeRequests: number | null;
  /** Measured queued jobs (>= 0), or null when unmeasured. */
  queued: number | null;
  /** Telemetry is stale: treated as idle, never as zero-fabricated activity. */
  stale: boolean;
  /** `prefers-reduced-motion`: no animation at all (static frame). */
  reducedMotion: boolean;
}

/** Resolved visual energy (all values finite and bounded; see the constants). */
export interface EnergyState {
  /** 0..1 raw excitation (idle floor {@link IDLE_EXCITATION}). */
  excitation: number;
  /** Colour saturation multiplier, {@link SATURATION_MIN}..1. */
  saturation: number;
  /** Emissive/brightness multiplier, {@link BRIGHTNESS_MIN}..1. */
  brightness: number;
  /** Cloud radius multiplier, {@link CLOUD_RADIUS_MIN}..1 (tighter when idle). */
  cloudRadiusMul: number;
  /** Animation-rate multiplier, 0 (reduced motion) or {@link SPEED_MIN}..1. */
  speedMul: number;
  /** True only when real measured activity drives this state. */
  measured: boolean;
}

export const IDLE_EXCITATION = 0.12;
export const SATURATION_MIN = 0.35;
export const BRIGHTNESS_MIN = 0.35;
export const CLOUD_RADIUS_MIN = 0.8;
export const SPEED_MIN = 0.15;
/** Smoothing time constants (seconds). */
export const ENERGY_RISE_TAU = 0.4;
export const ENERGY_FALL_TAU = 3;
/** Tokens/second at which activity is ~63 % of full excitation. */
const TPS_SCALE = 40;
/** In-flight request count at which activity saturates. */
const ACTIVE_SATURATION = 4;
/** Queue contributes at most this much activity. */
const QUEUE_ACTIVITY_CAP = 0.3;
const QUEUE_SATURATION = 8;

function finiteNonNeg(v: number | null): number {
  return v != null && Number.isFinite(v) && v > 0 ? v : 0;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Map an activity level a∈[0,1] to the full visual state (monotonic). */
export function energyFromActivity(
  activity: number,
  measured: boolean,
  reducedMotion: boolean
): EnergyState {
  const a = clamp01(activity);
  return {
    excitation: lerp(IDLE_EXCITATION, 1, a),
    saturation: lerp(SATURATION_MIN, 1, a),
    brightness: lerp(BRIGHTNESS_MIN, 1, a),
    cloudRadiusMul: lerp(CLOUD_RADIUS_MIN, 1, a),
    speedMul: reducedMotion ? 0 : lerp(SPEED_MIN, 1, a),
    measured,
  };
}

/** Resolve the (unsmoothed) target energy for measured telemetry. */
export function resolveEnergyState(input: EnergyInput): EnergyState {
  if (input.stale) return energyFromActivity(0, false, input.reducedMotion);
  const tps = finiteNonNeg(input.measuredTps);
  const active = finiteNonNeg(input.activeRequests);
  const queued = finiteNonNeg(input.queued);
  const fromTps = 1 - Math.exp(-tps / TPS_SCALE);
  const fromActive = Math.min(1, active / ACTIVE_SATURATION);
  const fromQueue = Math.min(1, queued / QUEUE_SATURATION) * QUEUE_ACTIVITY_CAP;
  const activity = Math.max(fromTps, fromActive, fromQueue);
  const measured = tps > 0 || active > 0 || queued > 0;
  return energyFromActivity(activity, measured, input.reducedMotion);
}

/**
 * Frame-rate independent first-order smoother (rise fast, fall slow). Steps a
 * single activity scalar; callers map it through {@link energyFromActivity}.
 */
export function createEnergySmoother(initial = 0): {
  step: (target: number, dtSeconds: number) => number;
  value: () => number;
} {
  let v = clamp01(initial);
  return {
    step(target, dtSeconds) {
      const t = clamp01(target);
      const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? Math.min(dtSeconds, 0.25) : 0;
      const tau = t > v ? ENERGY_RISE_TAU : ENERGY_FALL_TAU;
      v += (t - v) * (1 - Math.exp(-dt / tau));
      return v;
    },
    value: () => v,
  };
}

/** Recover the activity scalar that produced a target state (inverse of lerp). */
export function activityOf(state: EnergyState): number {
  return clamp01((state.excitation - IDLE_EXCITATION) / (1 - IDLE_EXCITATION));
}

/**
 * Advance the decorative/measured animation phase. Reduced motion and a zero
 * speed multiplier hold the phase exactly (no drift, no accumulation).
 */
export function advanceAnimationPhase(
  phase: number,
  dtSeconds: number,
  speedMul: number,
  reducedMotion: boolean
): number {
  if (reducedMotion || !Number.isFinite(speedMul) || speedMul <= 0) return phase;
  const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? Math.min(dtSeconds, 0.25) : 0;
  return phase + dt * speedMul;
}
