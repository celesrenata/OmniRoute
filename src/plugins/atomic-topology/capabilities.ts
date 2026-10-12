/**
 * SSR-safe feature detection for the Atomic topology renderer
 * (OR-ATOM-001 v2, T006a / M3 Phase A).
 *
 * Pure TS — no `three`, no module-scope DOM access. Every probe is guarded by
 * `typeof window` / `typeof navigator` / `typeof document`, so the module can be
 * imported from the server and from jsdom-backed tests without side effects.
 * In any environment without a real browser (node, jsdom, SSR) the result is
 * `{ webgl2: false, webgpu: false, reducedMotion: false }` — the host then
 * falls back to the default 2D renderer.
 *
 * The probes are intentionally permissive: a probe that *throws* is treated as
 * "not available", never as a crash, because `supported()` runs in the host's
 * critical path and must degrade silently.
 */

/** Environment capabilities the Atomic renderer cares about. */
export interface TopologyCapabilities {
  /** The page context can create a WebGL2 context (required capability). */
  webgl2: boolean;
  /** The page context exposes the WebGPU device API (optional, future use). */
  webgpu: boolean;
  /** The user has opted into reduced motion (animation budget is dropped). */
  reducedMotion: boolean;
}

/**
 * Detect the topology rendering capabilities of the current environment.
 *
 * SSR-safe: returns `{ webgl2: false, webgpu: false, reducedMotion: false }`
 * when `window` / `document` / `navigator` are absent (node, jsdom, SSR).
 *
 * @returns the capability report for the Atomic renderer's `supported()` gate.
 */
export function detectTopologyCapabilities(): TopologyCapabilities {
  const webgl2 = detectWebgl2();
  const webgpu = detectWebgpu();
  const reducedMotion = detectReducedMotion();
  return { webgl2, webgpu, reducedMotion };
}

/**
 * Probe for a WebGL2 context on a detached canvas. A `null` context result (or
 * a probe that throws) means "unavailable". The canvas is never attached to the
 * document, so there is nothing to dispose.
 */
function detectWebgl2(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2");
    return context != null;
  } catch {
    return false;
  }
}

/**
 * Probe for the WebGPU API (`navigator.gpu`). Treated as an *optional*
 * capability: the Atomic renderer requires only WebGL2.
 */
function detectWebgpu(): boolean {
  if (typeof navigator === "undefined") return false;
  try {
    return (navigator as Navigator & { gpu?: unknown }).gpu != null;
  } catch {
    return false;
  }
}

/**
 * Probe `prefers-reduced-motion` via `matchMedia`. In environments without a
 * live `matchMedia` (node, SSR, and jsdom unless explicitly set up) this
 * returns `false` — the "not opted in" default, which is the safe animation
 * direction for a non-browser context that would not render the scene anyway.
 */
function detectReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  const matchMedia = window.matchMedia;
  if (typeof matchMedia !== "function") return false;
  try {
    return matchMedia.call(window, "(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}
