/**
 * Pure nucleus motion helpers for the OR-ATOM-009 telemetry bindings
 * (Phase 2 W2 — nucleus motion, model groups, queue vibration).
 *
 * No React, no `three`, no DOM, no `Math.random`, no wall clock. The scene
 * components consume these so the timing/easing behavior is deterministic
 * and unit-testable in Node (same discipline as `motion.ts` and
 * `nucleusCluster.ts`).
 *
 * No-fabrication contract (motion-audit §2/§9): every helper maps a MEASURED
 * fact (or `null`) to a bounded visual value. Null / stale / missing data
 * decays to the neutral "no data" form — never a fake speed, never a jump.
 * All frame-rate-independent: driven by `dtSeconds`, never a frame count.
 */

import { MAX_FRAME_DELTA } from "./motion";
import { fnv1a } from "./cloudShells";
import { MAX_MODEL_GROUPS } from "./nucleusCluster";

/* ------------------------------------------------------------------ */
/* Rotation smoothing (exponential moving average of measured TPS)     */
/* ------------------------------------------------------------------ */

/**
 * Default EMA time constant for nucleus spin smoothing, in seconds.
 *
 * Chosen at ~1.0 s against the telemetry cadence:
 * - the fleet poller samples on a 3.5 s interval by default
 *   (`fleetTelemetryPoller.ts` `DEFAULT_INTERVAL_MS = 3500`), and
 * - the per-sample stale rule is `age > 3 × windowMs`
 *   (`src/shared/topology/telemetry/types.ts` `windowMs` comment).
 *
 * With tau = 1 s:
 * - a fresh sample arriving one interval after the previous one carries
 *   ~97 % blend weight (`1 - exp(-3.5)`), so the smoothed speed tracks real
 *   throughput without multi-second lag;
 * - a stale gap of one full interval decays the smoothed value to ~3 %
 *   (`exp(-3.5)`), so the nucleus visibly spins down BEFORE a sample could
 *   even be flagged stale at the 3×windowMs rule — stale data never holds
 *   a fake speed, and the spin-down is smooth (same exponential kernel in
 *   both directions), never a jump.
 */
export const NUCLEUS_SMOOTH_TAU_SECONDS = 1.0;

/** Mutable EMA state — preallocated once by the creator (zero allocation in `step`). */
export interface RotationSmoothingState {
  /** Smoothed TPS (0 before the first non-null sample). */
  current: number;
  /** True after the first non-null sample has been adopted. */
  primed: boolean;
}

/** A created rotation smoother (closure over its preallocated state). */
export interface RotationSmoothing {
  /** The preallocated state (stable identity — the scene keeps the ref). */
  readonly state: RotationSmoothingState;
  /**
   * Advance the smoothing by `dtSeconds` toward the measured sample.
   *
   * - `measuredTps === null` (stale / missing): decays `current` toward 0
   *   with the SAME time constant — stale data spins down, never holds a
   *   fake speed, never jumps.
   * - first call with non-null: `current = v` exactly (no adoption jump).
   * - subsequent non-null: exponential approach, `dt`-based (frame-rate
   *   independent: `alpha = 1 - exp(-dt / tau)`), so two small steps and
   *   one large step with the same total dt agree.
   *
   * Returns the new smoothed TPS. Mutates only the preallocated state —
   * zero allocation per call.
   */
  step(measuredTps: number | null, dtSeconds: number): number;
}

/**
 * Create an exponential-moving-average smoother for a measured spin rate.
 * `tauSeconds` ≤ 0 / non-finite falls back to {@link NUCLEUS_SMOOTH_TAU_SECONDS}.
 */
export function createRotationSmoothing(
  tauSeconds: number = NUCLEUS_SMOOTH_TAU_SECONDS
): RotationSmoothing {
  const tau =
    Number.isFinite(tauSeconds) && tauSeconds > 0 ? tauSeconds : NUCLEUS_SMOOTH_TAU_SECONDS;
  const state: RotationSmoothingState = { current: 0, primed: false };
  return {
    state,
    step(measuredTps: number | null, dtSeconds: number): number {
      const dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
      if (measuredTps == null || !Number.isFinite(measuredTps)) {
        // Stale / missing → decay toward 0 with the same kernel.
        state.current *= Math.exp(-dt / tau);
        return state.current;
      }
      if (!state.primed) {
        // First real sample: adopt it exactly (no jump, no fade-in).
        state.current = Math.max(0, measuredTps);
        state.primed = true;
        return state.current;
      }
      const alpha = 1 - Math.exp(-dt / tau);
      state.current += (Math.max(0, measuredTps) - state.current) * alpha;
      return state.current;
    },
  };
}

/* ------------------------------------------------------------------ */
/* TPS → radians/second mapping                                        */
/* ------------------------------------------------------------------ */

/**
 * Spin (rad/s) for any measured TPS > 0 — the smallest visible rate
 * (the nucleus never freezes when a model is decoding, however slowly).
 */
export const NUCLEUS_SPIN_MIN_RAD_PER_SECOND = 0.15;
/**
 * Saturation spin (rad/s) at and above {@link NUCLEUS_SPIN_SATURATION_TPS}
 * — a fast model reads as "very fast", not as a blur.
 */
export const NUCLEUS_SPIN_MAX_RAD_PER_SECOND = 1.4;
/**
 * TPS mapped to the saturation spin. Kept high enough that a realistic
 * 1000 TPS lands at ~91 % of the cap (visibly below it) — 20 vs 80 TPS
 * stay clearly distinguishable while 1000 TPS does not blur.
 */
export const NUCLEUS_SPIN_SATURATION_TPS = 2000;

/**
 * Deterministic TPS → spin-rate mapping.
 *
 * Shape: **log-scaled with linear saturation** —
 * `r = clamp01(log1p(tps) / log1p(SATURATION_TPS))`,
 * `omega = MIN + (MAX - MIN) * r`.
 *
 * - `tps ≤ 0` / non-finite → `0` (no measured decode → no fabricated spin;
 *   the "alive" ambient rate is a separate constant owned by the scene).
 * - `tps > 0` → always `> MIN` (visible, never frozen).
 * - Log scaling matches the existing `spinRadiansPerSecond` family in
 *   `visualEncoding.ts` (same `log1p` ratio shape), so a nucleus spin reads
 *   on the same perceptual scale as the provider-atom spin.
 * - Concrete anchors: 20 TPS → ~0.65 rad/s, 80 TPS → ~0.87 rad/s
 *   (≈ 34 % apart — visibly different), 1000 TPS → ~1.29 rad/s
 *   (≈ 91 % of cap — no blur), ≥ 2000 TPS → saturates at 1.4 rad/s.
 *
 * Constants are module-level (never per-call allocations).
 */
export function tpsToRadiansPerSecond(tps: number): number {
  if (!Number.isFinite(tps) || tps <= 0) return 0;
  const logSaturation = Math.log1p(NUCLEUS_SPIN_SATURATION_TPS);
  const ratio = Math.min(1, Math.log1p(tps) / logSaturation);
  return (
    NUCLEUS_SPIN_MIN_RAD_PER_SECOND +
    (NUCLEUS_SPIN_MAX_RAD_PER_SECOND - NUCLEUS_SPIN_MIN_RAD_PER_SECOND) * ratio
  );
}

/* ------------------------------------------------------------------ */
/* Queue vibration (bounded tremor from attributable scheduler data)   */
/* ------------------------------------------------------------------ */

/** Hard cap on nucleus queue-vibration amplitude (world units). */
export const QUEUE_VIBRATION_MAX_AMPLITUDE = 0.03;
/** Amplitude scale applied to `log1p(queued)`. */
export const QUEUE_VIBRATION_AMPLITUDE_SCALE = 0.009;
/** Frequency (Hz) at a queue of 1 — a slow tremor, not a flicker. */
export const QUEUE_VIBRATION_MIN_FREQUENCY_HZ = 1.2;
/** Frequency gain per `log1p(queued)` unit. */
export const QUEUE_VIBRATION_FREQUENCY_GAIN = 0.35;
/** Hard cap on vibration frequency (Hz) — bounded oscillation. */
export const QUEUE_VIBRATION_MAX_FREQUENCY_HZ = 6;
/**
 * Amplitude multiplier while jobs are actively scheduled (`active > 0`):
 * a draining queue trembles less; a stalled queue (`active === 0`,
 * `queued > 0`) keeps the full amplitude (urgent). Both inputs are real
 * attributable scheduler data — `active === null` (unknown) applies no
 * multiplier (we never assert what we did not observe).
 */
export const QUEUE_VIBRATION_DRAIN_DAMP = 0.65;

/**
 * Caller-owned vibration phase (zero allocation: the scene preallocates
 * one of these and passes it in every frame — same contract as the
 * `filament.ts` pools).
 */
export interface QueueVibrationPhase {
  /** Accumulated oscillation phase (radians, wrapped to [0, 2π)). */
  p: number;
}

/** A created queue vibrator (stateless except for the caller's phase). */
export interface QueueVibration {
  /**
   * Advance the vibration by `dtSeconds` and return the current
   * oscillation displacement (signed, bounded by the queue's amplitude).
   *
   * - `queued === null` or `queued ≤ 0` → returns `0` (real attributable
   *   scheduler data ONLY — no queue observed, no fabricated tremor).
   * - `queued > 0` → amplitude `min(MAX, SCALE * log1p(queued))`
   *   (damped by {@link QUEUE_VIBRATION_DRAIN_DAMP} while `active > 0`),
   *   frequency `min(MAX_HZ, MIN_HZ + GAIN * log1p(queued))`.
   * - The phase advances with `dt` (NOT frame count) at the queue's
   *   frequency, so the oscillation is frame-rate independent; `dt` is
   *   clamped to `MAX_FRAME_DELTA` so a background-tab spike cannot fling
   *   the phase (same guard as `advanceSceneTime`).
   *
   * Zero allocation: mutates only the caller-supplied `phaseState`.
   */
  step(
    queued: number | null,
    active: number | null,
    dtSeconds: number,
    phaseState: QueueVibrationPhase
  ): number;
}

/**
 * Create a queue vibrator. The vibrator itself is stateless; ALL state is
 * the caller-supplied {@link QueueVibrationPhase}, so one instance can
 * serve many scene components allocation-free.
 */
export function createQueueVibration(): QueueVibration {
  return {
    step(queued, active, dtSeconds, phaseState): number {
      const dt = Number.isFinite(dtSeconds) ? Math.min(Math.max(0, dtSeconds), MAX_FRAME_DELTA) : 0;
      const q = queued == null || !Number.isFinite(queued) ? null : Math.max(0, queued);
      if (q == null || q <= 0) {
        // No attributable queue → zero; the phase holds (output is 0
        // regardless, so no jump when real data resumes).
        return 0;
      }
      const logQueue = Math.log1p(q);
      const draining = active != null && active > 0;
      const amplitude =
        Math.min(QUEUE_VIBRATION_MAX_AMPLITUDE, QUEUE_VIBRATION_AMPLITUDE_SCALE * logQueue) *
        (draining ? QUEUE_VIBRATION_DRAIN_DAMP : 1);
      const frequencyHz = Math.min(
        QUEUE_VIBRATION_MAX_FREQUENCY_HZ,
        QUEUE_VIBRATION_MIN_FREQUENCY_HZ + QUEUE_VIBRATION_FREQUENCY_GAIN * logQueue
      );
      phaseState.p = (phaseState.p + dt * frequencyHz * Math.PI * 2) % (Math.PI * 2);
      return amplitude * Math.sin(phaseState.p);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Model-group slots (up to three visible model-colored groups)        */
/* ------------------------------------------------------------------ */

/**
 * One visible model-colored particle-group slot inside a nucleus — the
 * "up to three visible model-colored particle groups" rule.
 */
export interface ModelGroupSlot {
  /** Canonical (trimmed, lowercased) model id. */
  modelId: string;
  /**
   * Stable hue seed: FNV-1a of the canonical model id, mod 360 — the SAME
   * hash→hue family as `modelColor` in `visualEncoding.ts`, so a model
   * keeps the same hue across polls (deterministic; NEVER `Math.random`,
   * and never derived from the array index).
   */
  hueSeed: number;
  /** Stable slot order — 0 is the smallest hash, never the array position. */
  index: number;
}

/** Result of {@link buildModelGroupSlots}. */
export interface ModelGroupSlots {
  /** Up to 3 slots in stable hash order; empty when no model ids observed. */
  slots: ModelGroupSlot[];
  /** True when more than 3 distinct models were observed (only the first 3 by stable order are visible). */
  truncated: boolean;
}

/**
 * Build the deterministic model-group slots for one nucleus.
 *
 * Determinism contract (same discipline as `nucleusCluster.ts`
 * `resolveModelGroups`):
 * - ids are canonicalized (trim + lowercase), blanks and duplicates are
 *   dropped — order-independent;
 * - stable order is by FNV-1a hash (group k is ALWAYS the k-th smallest
 *   hash, never the k-th array slot); `seed` only tie-breaks hash
 *   collisions, so the visible slot set does not change with the seed;
 * - `hueSeed` derives from the model id alone — stable across polls and
 *   across seeds;
 * - more than {@link MAX_MODEL_GROUPS} (3) distinct models → the first 3 by
 *   stable order, `truncated: true`;
 * - no `Math.random`, no wall clock — the same input always yields the
 *   same slots.
 */
export function buildModelGroupSlots(modelIds: string[], seed: number): ModelGroupSlots {
  if (modelIds.length === 0) return { slots: [], truncated: false };
  const seen = new Set<string>();
  const canonical = modelIds
    .map((id) => id.trim().toLowerCase())
    .filter((id) => {
      if (id.length === 0 || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const stableOrder = canonical.sort((x, y) => {
    const h = fnv1a(x) - fnv1a(y);
    if (h !== 0) return h;
    const hs = fnv1a(`${x}|${seed >>> 0}`) - fnv1a(`${y}|${seed >>> 0}`);
    if (hs !== 0) return hs;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const visible = stableOrder.slice(0, MAX_MODEL_GROUPS);
  return {
    slots: visible.map((modelId, index) => ({
      modelId,
      hueSeed: fnv1a(modelId) % 360,
      index,
    })),
    truncated: canonical.length > MAX_MODEL_GROUPS,
  };
}
