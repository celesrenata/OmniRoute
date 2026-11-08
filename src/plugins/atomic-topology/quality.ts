/**
 * Atomic scene render profile (OR-ATOM raytraced renderer, Gate B C4).
 *
 * There are NO quality tiers. The weakest supported machine is an Apple M5
 * Max, so the scene always renders at full fidelity: the device's full retina
 * pixel ratio (uncapped), hardware antialiasing, HDR bloom. Performance is
 * met by optimisation (batched draws, projected-size work scaling), never by
 * a "low" profile.
 *
 * The only fallbacks are capability/accessibility based and live elsewhere:
 *   - `prefers-reduced-motion` -> a static frame per update (`sceneState`);
 *   - WebGPU unavailable -> the WebGPURenderer's WebGL2 backend;
 *   - device / context loss -> rebuild, then the 2D renderer after two failed
 *     restores (`scene/AtomicScene.tsx`);
 *   - no GPU rendering at all -> the host's existing 2D renderer
 *     (`capabilities.ts` gate).
 *
 * Pure, SSR-safe, three-free.
 */

/** The render pixel ratio: the device pixel ratio itself (no cap); garbage -> 1. */
export function resolveRenderDpr(devicePixelRatio: number | undefined | null): number {
  return devicePixelRatio != null && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
}

/** The single full-fidelity render profile (documented constants, not a ladder). */
export const RENDER_PROFILE = {
  /** Hardware MSAA on the scene pass. */
  antialias: true,
  /** HDR bloom on emissives in the post pipeline. */
  bloom: true,
} as const;

/**
 * Bloom budget of the LEGACY (pre-Gate-B) EffectComposer path, reachable only
 * through the dev `?atomic-fx=legacy` A/B flag until Gate B is approved.
 */
export interface BloomBudget {
  enabled: boolean;
  strength: number;
  radius: number;
  threshold: number;
}

/** Legacy path default: bloom off (its crisp-material baseline). */
export const LEGACY_BLOOM: BloomBudget = {
  enabled: false,
  strength: 0.35,
  radius: 0.3,
  threshold: 3.0,
};
