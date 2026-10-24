"use client";

/**
 * WebGL context-loss guard (OR-ATOM-001 v2, M6).
 *
 * A three.js `WebGLRenderer` can lose its GPU context (driver crash, GPU
 * reset, memory pressure, a second heavy tab). Without handling it the canvas
 * goes permanently black. This component is the scene's "context-loss-safe"
 * half of the M6 hardening: it listens for `webglcontextlost` /
 * `webglcontextrestored` on the renderer's canvas and
 *
 *   - calls `preventDefault()` on `webglcontextlost` so the browser *restores*
 *     the context instead of killing it, and
 *   - re-invalidates the R3F frameloop on `webglcontextrestored` so the scene
 *     re-renders the moment the GPU context is back.
 *
 * It renders nothing (returns `null`), so it adds no visual weight — it is
 * pure lifecycle. `three` / R3F access is confined to this `scene/**` subtree.
 */
import { useEffect } from "react";
import { useThree } from "@react-three/fiber";

export function ContextGuard() {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const canvas = gl.domElement;
    if (!canvas || typeof canvas.addEventListener !== "function") return;

    const onLost = (event: Event) => {
      // Signal that we intend to restore the context, so the browser fires
      // `webglcontextrestored` later instead of permanently losing it.
      event.preventDefault();
    };
    const onRestored = () => {
      // The context is back — request a frame so the scene repaints. A no-op
      // when already running a continuous frameloop.
      invalidate();
    };

    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, [gl, invalidate]);

  return null;
}
