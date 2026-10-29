/**
 * Pure orbital-haze math for the Atomic scene (OR-ATOM-008 S8.2).
 *
 * No `three`, no DOM, no `Math.random`, no clock. Adds a volumetric luminous
 * haze *around* the existing electron shells: 1–3 large, very soft,
 * translucent additive billboards per atom, each counter-rotating slowly and
 * "breathing" (±3–5 % scale) with the pause-aware scene clock. All per-sprite
 * parameters are deterministic from the atom seed (FNV-1a bit-slice pattern —
 * same construction as `cloudShells.ts`), so the scene must not depend on
 * array order or wall-clock time.
 *
 * Quality tiers (web-quality-performance: bounded sprite budget): worst case
 * is 38 ring atoms × 3 haze sprites (high tier) = 114 haze sprites, keeping
 * the whole scene under the ~700 total-sprite budget. The tier is resolved
 * ONCE at module scope (stable for the lifetime of the module — it never
 * flickers mid-session) from `navigator.hardwareConcurrency`.
 */

import { fnv1a } from "./cloudShells";

/** The three haze quality tiers. */
export type HazeQualityTier = "high" | "medium" | "low";

/** Per-tier haze parameters (module-scope constants — the only place tier numbers live). */
export interface HazeTierParams {
  /** Haze billboards per atom (high 3 / medium 2 / low 1). */
  spriteCount: number;
  /**
   * Base per-sprite additive opacity (0.03–0.08 — very low so the cloud reads
   * as volume without blowing out white; worst-case stack is
   * 3 × 0.06 × 1.15 opacity jitter = 0.207 < 0.25 at the nucleus).
   */
  spriteOpacity: number;
  /**
   * Base billboard radius as a multiple of the cloud's base radius. Each
   * sprite jitters up to +0.4× from this base, staying inside [2.6, 3.4] ×.
   */
  radiusMultiplier: number;
  /** Base counter-rotation speed, rad/s (one revolution ≈ 1.3–3 min). */
  spinRadPerSecond: number;
  /** Scale-breathing amplitude (±0.03–0.05). */
  breathAmplitude: number;
  /** Scale-breathing period, seconds (very slow). */
  breathPeriodSeconds: number;
}

/** Quality-tier table (high/medium/low). */
export const HAZE_TIER_TABLE: Record<HazeQualityTier, HazeTierParams> = {
  high: {
    spriteCount: 3,
    spriteOpacity: 0.06,
    radiusMultiplier: 3.0,
    spinRadPerSecond: 0.08,
    breathAmplitude: 0.05,
    breathPeriodSeconds: 9,
  },
  medium: {
    spriteCount: 2,
    spriteOpacity: 0.05,
    radiusMultiplier: 2.9,
    spinRadPerSecond: 0.07,
    breathAmplitude: 0.04,
    breathPeriodSeconds: 10,
  },
  low: {
    spriteCount: 1,
    spriteOpacity: 0.04,
    radiusMultiplier: 2.7,
    spinRadPerSecond: 0.06,
    breathAmplitude: 0.03,
    breathPeriodSeconds: 11,
  },
};

/**
 * Haze render order — strictly below the electron sprites (renderOrder 0) so
 * the crisp moving points composite on top of the soft luminous volume.
 */
export const HAZE_RENDER_ORDER = -1;

/**
 * Resolve the haze quality tier from a CPU-core count (stable heuristic, no
 * flicker). 1–7 cores → low, 8–11 → medium, ≥12 → high. An absent/falsy core
 * count (SSR, headless) falls back to the 8-core default (medium).
 */
export function resolveHazeQualityTier(hardwareConcurrency?: number): HazeQualityTier {
  const cores = hardwareConcurrency || 8;
  const steps = Math.min(3, Math.max(1, Math.floor(cores / 4)));
  return steps >= 3 ? "high" : steps === 2 ? "medium" : "low";
}

/**
 * The scene's haze tier, resolved ONCE at module scope — stable for the
 * lifetime of the module (never re-evaluated per frame, per atom, or per
 * render; the browser's `navigator.hardwareConcurrency` is read at most once
 * here, guarded for SSR — Node ≥22 exposes a global `navigator`, so the SSR
 * signal is `window`, not `navigator`).
 */
export const HAZE_TIER: HazeQualityTier = resolveHazeQualityTier(
  typeof window === "undefined" ? undefined : navigator.hardwareConcurrency
);

/** One haze billboard around an atom (deterministic per seed + slot index). */
export interface HazeSpriteParams {
  /** Billboard radius multiplier vs the cloud's base radius, inside [2.6, 3.4]. */
  scaleMultiplier: number;
  /**
   * Counter-rotation speed in rad/s — always NEGATIVE (the electron shells
   * spin positive), magnitude 0.4×–1.0× the tier base.
   */
  spinRadPerSecond: number;
  /** Initial in-plane rotation (radians, [0, 2π)). */
  spinPhase: number;
  /** Initial phase of the scale-breathing sine (radians, [0, 2π)). */
  breathPhase: number;
  /** Per-sprite opacity multiplier (0.85–1.15) — desynchronizes the stack. */
  opacityScale: number;
}

const TWO_PI = Math.PI * 2;

/**
 * Deterministic per-sprite haze parameters from a seed.
 *
 * Same FNV bit-slice construction as `cloudShells()`: hash `"<seed>:<i>"` and
 * read 16-bit slices at different bit offsets so the 1–3 billboards of one
 * atom get distinct scale/spin/breath without a visible pattern.
 */
export function hazeSprites(seed: number, tier: HazeQualityTier): HazeSpriteParams[] {
  const params = HAZE_TIER_TABLE[tier];
  const out: HazeSpriteParams[] = [];
  for (let i = 0; i < params.spriteCount; i += 1) {
    const s = fnv1a(`${seed}:${i}`);
    const frac = (shift: number): number => ((s >>> shift) & 0xffff) / 0x10000;
    out.push({
      scaleMultiplier: params.radiusMultiplier + 0.4 * frac(0),
      spinRadPerSecond: -params.spinRadPerSecond * (0.4 + 0.6 * frac(12)),
      spinPhase: frac(24) * TWO_PI,
      breathPhase: frac(36) * TWO_PI,
      opacityScale: 0.85 + 0.3 * frac(48),
    });
  }
  return out;
}

/**
 * The haze sprite's in-plane rotation at clock time `t` (absolute, not
 * accumulated — a frozen clock holds the angle exactly and resume is
 * contiguous; same pattern as the shell spin in `ElectronCloud.tsx`).
 */
export function hazeSpinRadians(p: HazeSpriteParams, t: number): number {
  const angle = (p.spinPhase + p.spinRadPerSecond * t) % TWO_PI;
  return angle < 0 ? angle + TWO_PI : angle;
}

/** The scale-breathing factor at clock time `t` (1 ± tier amplitude). */
export function hazeBreathScale(p: HazeSpriteParams, t: number, tier: HazeTierParams): number {
  const phase = (TWO_PI * t) / tier.breathPeriodSeconds + p.breathPhase;
  return 1 + tier.breathAmplitude * Math.sin(phase);
}
