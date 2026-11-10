/**
 * Timeline of a between-atom discharge (OR-ATOM-010 directive 22). Pure and
 * three-free; the link shaders import the same constants so CPU gating and GPU
 * animation can never disagree.
 *
 *   leader (0..leaderS)      the stepped leader advances; the channel is dim
 *   return stroke (leaderS)  the whole channel lights white-hot
 *   re-strikes               decaying repeat strokes along (a slightly mutated) channel
 *   continuing current       a dim steady glow between strokes
 *   afterglow                residual ionisation that decays over seconds
 *
 * Failure = violent, red, many re-strikes. Completion = crisp cyan/green, one
 * stroke and one soft re-flash. A strike is booked ONLY from an event (a state
 * transition edge); when it ends nothing loops.
 */
export type StrikeKind = "failure" | "completion";

export interface StrikeProfile {
  /** Leader advance time (s). */
  leaderS: number;
  /** Stroke start offsets after the leader completes (s). */
  strokeOffsets: readonly number[];
  /** Stroke peak amplitudes. */
  strokeAmps: readonly number[];
  /** Exponential decay rate of one stroke (1/s). */
  strokeDecay: number;
  /** Whole strike lifetime incl. afterglow (s). */
  lifeS: number;
  /** Afterglow e-folding time (s). */
  glowTauS: number;
}

export const STRIKE_PROFILES: Record<StrikeKind, StrikeProfile> = {
  failure: {
    leaderS: 0.2,
    strokeOffsets: [0, 0.13, 0.27, 0.5],
    strokeAmps: [1, 0.75, 0.9, 0.5],
    strokeDecay: 15,
    lifeS: 2.6,
    glowTauS: 0.9,
  },
  completion: {
    leaderS: 0.09,
    strokeOffsets: [0, 0.11],
    strokeAmps: [1, 0.45],
    strokeDecay: 21,
    lifeS: 1.2,
    glowTauS: 0.45,
  },
};

/** Shader-facing kind codes (STRIKE field y; negative = soft, no bolt/FX). */
export const STRIKE_CODE: Record<StrikeKind, number> = { failure: 1, completion: 2 };

export function strikeLife(kind: StrikeKind): number {
  return STRIKE_PROFILES[kind].lifeS;
}

/** Sum of decaying strokes at `age` seconds after the strike started (0 before the leader ends). */
export function strokeEnvelope(kind: StrikeKind, age: number): number {
  const p = STRIKE_PROFILES[kind];
  if (!(age >= p.leaderS)) return 0;
  let e = 0;
  for (let i = 0; i < p.strokeOffsets.length; i += 1) {
    const t = age - p.leaderS - p.strokeOffsets[i];
    if (t >= 0) e += p.strokeAmps[i] * Math.exp(-t * p.strokeDecay);
  }
  return e;
}

/** Residual ionisation afterglow (smooth, never strobes). */
export function afterglow(kind: StrikeKind, age: number): number {
  const p = STRIKE_PROFILES[kind];
  if (!(age >= 0)) return 0;
  const k = Math.min(1, age / Math.max(1e-6, p.leaderS));
  return k * Math.exp(-Math.max(0, age - p.leaderS) / p.glowTauS);
}

/** Index of the last stroke already fired at `age` (-1 before the first): drives channel mutation. */
export function restrikeIndex(kind: StrikeKind, age: number): number {
  const p = STRIKE_PROFILES[kind];
  let idx = -1;
  for (let i = 0; i < p.strokeOffsets.length; i += 1) {
    if (age >= p.leaderS + p.strokeOffsets[i]) idx = i;
  }
  return idx;
}
