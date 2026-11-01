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
 * Cache for the WebGL2 probe. `null` = not probed yet; `true`/`false` = the
 * cached result for this page load. A real WebGL2 context is expensive and
 * scarce (the browser caps ~16 live contexts), so the probe allocates at most
 * ONCE and releases it immediately via `WEBGL_lose_context` — the probe never
 * counts against the limit, and every caller (mount gate + render gate) shares
 * this single cached result.
 *
 * OR-ATOM-009.1 (F5): ported from the plugin branch `webgl2Available()` —
 * the one residual the branch-diff audit identified as missing on release
 * (the renderer was re-probing a real WebGL2 context on every render).
 */
let webgl2Result: boolean | null = null;

/**
 * Probe whether the page can create a real WebGL2 context, caching the result
 * for the lifetime of the page.
 *
 * SSR-safe: returns `false` when `document` is absent (node, SSR). A probe that
 * *throws* is treated as "not available", never a crash (permissive semantics).
 * On success the freshly-created context is released immediately (via
 * `WEBGL_lose_context`) before the function returns, so the probe context never
 * counts against the browser's active-context limit.
 */
export function webgl2Available(): boolean {
  if (webgl2Result !== null) return webgl2Result;
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    webgl2Result = false;
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("webgl2");
    webgl2Result = ctx != null;
    if (ctx) {
      const lose = (
        ctx as unknown as { getExtension?: (n: string) => { loseContext(): void } | null }
      ).getExtension?.("WEBGL_lose_context");
      lose?.loseContext();
    }
  } catch {
    webgl2Result = false;
  }
  return webgl2Result;
}

/**
 * Reset the cached WebGL2 probe result. **Test-only** — lets unit tests reset
 * the module-level cache between cases.
 */
export function __resetWebgl2CacheForTests(): void {
  webgl2Result = null;
}

/**
 * Probe for a WebGL2 context on a detached canvas. A `null` context result (or
 * a probe that throws) means "unavailable". The canvas is never attached to the
 * document, so there is nothing to dispose.
 *
 * Routes through {@link webgl2Available} (the single cached,
 * context-releasing probe) so the mount gate and any render gate share one
 * allocation instead of each leaking a live context.
 */
function detectWebgl2(): boolean {
  return webgl2Available();
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
