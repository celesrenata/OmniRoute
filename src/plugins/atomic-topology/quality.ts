/**
 * Atomic scene quality fallback (OR-ATOM-001 v2, M6).
 *
 * Pure, SSR-safe, three-free: decides — from a coarse, bounded environment
 * probe — which rendering quality the scene should run at, *before* the 2D
 * fallback is considered. The scene (the only module that imports `three`)
 * consumes the result to scale down geometry/segment budgets; the 2D fallback
 * decision itself is unchanged (it is the host's job, gated on the WebGL2
 * capability).
 *
 * Quality ladder (highest → lowest):
 *   `high`     — full segment counts / DPR up to 2.
 *   `medium`   — halved tube/cloud segment budgets, DPR capped at 1.5.
 *   `low`      — minimal budgets, DPR capped at 1, no antialias.
 *   `none`     — do not attempt the 3D scene; the host renders the 2D renderer
 *     (this is the *quality* signal only — capability is a separate gate).
 *
 * The probe inputs are deliberately coarse (device pixel ratio, hardware
 * concurrency, `navigator.deviceMemory`) so a single bad value can never take
 * the scene further down the ladder than necessary; every branch is bounded
 * and pure (same inputs → same quality).
 */

/** The quality ladder the Atomic scene can run at. */
export type AtomicSceneQuality = "high" | "medium" | "low" | "none";

/** Coarse environment signals the quality ladder keys off (all optional). */
export interface QualityProbe {
  /** `window.devicePixelRatio` (e.g. 2 on a retina display). */
  devicePixelRatio?: number;
  /** `navigator.hardwareConcurrency` (core count), when exposed. */
  hardwareConcurrency?: number;
  /** `navigator.deviceMemory` (GiB), when exposed. */
  deviceMemoryGiB?: number;
  /**
   * Whether a real WebGL2 context could be created. When `false` the scene
   * cannot render at any quality — the answer is `none` regardless of the
   * other signals. (The host still owns the authoritative capability gate;
   * this keeps the quality function total and testable.)
   */
  webgl2?: boolean;
}

/**
 * A signal only counts when it is a real, *positive* observation. `NaN`,
 * `Infinity`, `0` and negative values are garbage, not "weak", so they are
 * treated as absent — an unparseable signal never lowers the quality.
 */
function finitePositive(value?: number): number | undefined {
  return value != null && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Resolve the scene quality for a probe. Pure and bounded:
 *
 * - `webgl2 === false` → `none` (no 3D at any quality).
 * - very small screens or very low memory/concurrency → `low`.
 * - modest signals → `medium`.
 * - anything else → `high`.
 *
 * A missing (or garbage) signal is treated optimistically (it does not
 * *lower* quality); only an *observed* weak signal lowers it.
 */
export function resolveSceneQuality(probe: QualityProbe = {}): AtomicSceneQuality {
  if (probe.webgl2 === false) return "none";

  const dpr = finitePositive(probe.devicePixelRatio);
  const cores = finitePositive(probe.hardwareConcurrency);
  const mem = finitePositive(probe.deviceMemoryGiB);

  // A genuinely weak device (few cores + little memory, or an extremely high
  // DPR that multiplies fragment cost) runs at the lowest 3D quality.
  const weakMemory = mem != null && mem < 4;
  const weakCores = cores != null && cores <= 4;
  const heavyDpr = dpr != null && dpr > 3;
  if (weakMemory && weakCores) return "low";
  if (weakMemory || weakCores || heavyDpr) return "medium";

  return "high";
}

/**
 * Per-tier GPU bloom (postprocessing) budget — OR-ATOM-010 T10.5e.
 *
 * `enabled` gates the `EffectComposer` chain (`RenderPass →
 * UnrealBloomPass → OutputPass`) inside the scene. Disabled tiers keep the
 * no-postFX path: the renderer applies the ACES tone map directly to the
 * canvas (the cheapest path — verified against r186 `WebGLPrograms.js`,
 * which tone-maps only when `currentRenderTarget === null`, i.e. only on the
 * direct canvas render, never on render-target passes).
 *
 * `threshold` is in LINEAR radiance (the composer's HalfFloat buffer), not
 * sRGB: the emissive atom cores (radiance ≫ 1 after the exposure lift)
 * clear the threshold, the dark topology background (≈ 0) never does.
 */
export interface BloomBudget {
  /** False → no postFX chain at all (the tier keeps the direct render path). */
  enabled: boolean;
  /**
   * UnrealBloomPass strength (0–~3; > 1 starts to wash out thin links).
   * With ACES tone-mapping the scene stays dim, so the high tier uses a
   * deliberately low strength — the halo is carried by the threshold
   * instead of the intensity.
   */
  strength: number;
  /** UnrealBloomPass radius (bloom spread, in screen fraction). */
  radius: number;
  /**
   * UnrealBloomPass threshold (linear-radiance floor that blooms).
   * Must sit ABOVE the ACES output band of ordinary (non-emissive) pixels,
   * otherwise the whole scene blooms and the frame washes out (iteration-e:
   * threshold 0.75 raised the scene mean luminance 4.8× and erased the
   * neon palette). True emissives sit well above 1.0 in the HDR buffer, so
   * a high threshold localizes the halo to the neon cores and keeps their
   * chroma.
   */
  threshold: number;
}

/**
 * Per-quality render budgets the scene consumes. Pure constants — the scene
 * reads these instead of hard-coding segment counts, so a quality downgrade
 * is a single value change, not a refactor.
 */
export const QUALITY_BUDGETS: Record<
  AtomicSceneQuality,
  {
    dprMax: number;
    antialias: boolean;
    tubeSegments: number;
    cloudParticles: number;
    bloom: BloomBudget;
  }
> = {
  high: {
    dprMax: 2,
    antialias: true,
    tubeSegments: 24,
    cloudParticles: 12,
    // OR-ATOM-010 iteration-e regression fix: bloom OFF by default. The GPU
    // bloom pass (26a67bbf7) regressed the material — even the iteration-e
    // retune (0.35 / 0.30 / 3.00) still washes thin links at default auto-fit
    // framing on real pixels (filament clarity criterion dropped 3 → 2 in the
    // independent audit; "broad, faint smears" across all links). probe_bloom_off
    // (the direct render path) is visually identical to the good iteration-d
    // reference and keeps the 6 px hot core + packets legible. Bloom is an
    // OPTIONAL post-FX enhancement, not required by the acceptance criteria —
    // keep the pass wired and reachable via the dev `bloom=` bench override for
    // A/B, but the default ships on the crisp material baseline.
    bloom: { enabled: false, strength: 0.35, radius: 0.3, threshold: 3.0 },
  },
  medium: {
    dprMax: 1.5,
    antialias: true,
    tubeSegments: 14,
    cloudParticles: 8,
    // iteration-e retune: same washout failure as the high tier; weaker
    // strength and a slightly lower threshold (fewer emissive cores render at
    // lower detail, so the source band narrows naturally).
    // OR-ATOM-010 iteration-e regression fix: default OFF, same rationale as
    // the high tier — the pass washes thin links on real pixels; the dev
    // `bloom=` bench override still reaches it for A/B.
    bloom: { enabled: false, strength: 0.28, radius: 0.3, threshold: 2.5 },
  },
  low: {
    dprMax: 1,
    antialias: false,
    tubeSegments: 8,
    cloudParticles: 5,
    bloom: { enabled: false, strength: 0, radius: 0, threshold: 1 },
  },
  none: {
    dprMax: 1,
    antialias: false,
    tubeSegments: 0,
    cloudParticles: 0,
    bloom: { enabled: false, strength: 0, radius: 0, threshold: 1 },
  },
};
