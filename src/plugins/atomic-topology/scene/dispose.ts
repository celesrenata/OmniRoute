/**
 * Atomic scene — three.js object disposal (P0 WebGL context leak).
 *
 * The Atomic scene lives for minutes (telemetry re-renders on a ~3.5 s
 * cadence), so GPU resources it allocates imperatively (geometries,
 * materials) must be disposed on dependency change AND on unmount —
 * otherwise the scene leaks WebGL buffers (and, through the host's context
 * churn, can exhaust the browser's ~16 active-WebGL-context limit).
 *
 * Pure + side-effect-free per call: `disposeSceneObject` disposes the
 * geometry and material(s) of a single scene object, tolerating `null`
 * fields (the Atomic memo-built geometries are `T | null`).
 */

/** A three.js object with optional GPU-backed geometry and material(s). */
export interface DisposableSceneObject {
  geometry?: { dispose(): void } | null;
  material?: { dispose(): void } | Array<{ dispose(): void }> | null;
}

/**
 * Dispose the geometry and material(s) of a three.js scene object, skipping
 * any that are absent. Idempotent per three.js contract (dispose() merely
 * notifies the renderer; calling it twice is harmless).
 *
 * @param obj the object to dispose (or `null`/`undefined` — a no-op).
 */
export function disposeSceneObject(obj: DisposableSceneObject | null | undefined): void {
  if (!obj) return;
  if (obj.geometry) obj.geometry.dispose();
  const materials = obj.material;
  if (materials) {
    if (Array.isArray(materials)) {
      for (const material of materials) material.dispose();
    } else {
      materials.dispose();
    }
  }
}
