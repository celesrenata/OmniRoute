/**
 * Atomic topology renderer — plugin manifest (OR-ATOM-001 v2, T006a / M3 Phase A).
 *
 * Pure metadata: no DOM, no WebGL, no `three` imports. The `capability` field
 * names the environment capability this renderer requires; it is evaluated by
 * `capabilities.ts` (`detectTopologyCapabilities()`) and surfaced through the
 * plugin's `supported()` (see `index.ts`). The host treats a false/negative
 * `supported()` as "fall back to the default 2D renderer".
 *
 * NOTE (Phase A): the plugin's `mount()` is still a placeholder — Phase B ships
 * the real WebGL2 scene. See `index.ts` for the documented contract.
 */

/** Capability token required by the Atomic renderer (see `capabilities.ts`). */
export type AtomicCapability = "webgl2";

/** Static metadata for the Atomic topology renderer plugin. */
export interface AtomicManifest {
  /** Stable registry id used by the topology renderer registry. */
  id: "atomic";
  /** Human-readable name for UIs that list renderers. */
  name: "Atomic";
  /** Contract version; M3 Phase A plugins are version 1. */
  version: 1;
  /** Capability the environment must expose for this renderer to run. */
  capability: AtomicCapability;
}

/** Manifest for the Atomic topology renderer plugin. */
export const atomicManifest: AtomicManifest = {
  id: "atomic",
  name: "Atomic",
  version: 1,
  capability: "webgl2",
};
