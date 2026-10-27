"use client";

/**
 * Scene-wide runtime state for the Atomic scene (OR-ATOM-007): the shared
 * pause-aware clock, the WebGL context-loss flag, and the reduced-motion flag.
 *
 * Deliberately a *module singleton* (no React state): every scene component
 * reads/writes it imperatively inside `useFrame`, so per-frame work stays
 * allocation-free and React never re-renders the scene (web-quality-
 * performance: no per-frame state). The two flags are set by small R3F hooks
 * inside the `<Canvas>`:
 *
 * - {@link SceneClockDriver} advances the shared clock each frame
 *   (registered first, so it runs before every reader).
 * - {@link CanvasContextGuard} listens for `webglcontextlost` /
 *   `webglcontextrestored` (webgpu-threejs-tsl `device-loss.md` pattern,
 *   ported to the WebGL2 event API): lost → `preventDefault()` + freeze the
 *   clock; restored → resume (the clock is contiguous — no jump).
 *
 * `reducedMotion` is resolved once at mount via `matchMedia`
 * (accessibility.md: `prefers-reduced-motion` → static render) and kept in
 * sync with the media query; it is `false` under SSR (no `window`).
 *
 * Note: this module is the *pause-aware clock / accessibility* half of the
 * scene. The release already carries a separate {@link ContextGuard} (in
 * `./ContextGuard`) that re-invalidates the R3F frameloop on restore; the two
 * are complementary — `CanvasContextGuard` freezes the *shared clock* (so the
 * scene holds a static frame), `ContextGuard` makes sure the renderer repaints
 * once the GPU context is back.
 */
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";

import { advanceSceneTime } from "./motion";

/** The shared pause-aware clock (accumulated seconds). */
export const sceneClock = { now: 0 };

/** Runtime flags read by every scene component (module-scoped, no React state). */
export const sceneState = {
  /** True while the WebGL context is lost — the clock must not advance. */
  contextLost: false,
  /** True when the OS requests reduced motion — all continuous animation stops. */
  reducedMotion: false,
};

/** Whether the scene should advance continuous animation this frame. */
export function motionEnabled(): boolean {
  return !sceneState.contextLost && !sceneState.reducedMotion;
}

/**
 * Advances the shared clock once per frame. Mount it as the FIRST child of
 * the `<Canvas>` so its `useFrame` subscribes (and runs) before every other
 * scene component's reader.
 *
 * The clock accumulates 0 while `paused` or the context is lost (static frame,
 * contiguous resume — pinned by `tests/unit/atomic-topology/sceneMotion.test.ts`).
 */
export function SceneClockDriver({ paused }: { paused: boolean }) {
  const pausedRef = useRef(paused);
  // Sync in an effect (not during render — react-hooks/refs). The
  // `useRef(paused)` initializer covers the very first frame.
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useFrame((_state, delta) => {
    advanceSceneTime(sceneClock, delta, pausedRef.current || sceneState.contextLost);
  });
  return null;
}

/**
 * Attaches the WebGL2 context-loss listeners to the canvas element
 * (device-loss.md: `preventDefault()` on `lost`, freeze the loop; resume on
 * `restored`). SSR-safe: `gl.domElement` is only available client-side.
 */
export function CanvasContextGuard() {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const canvas = gl.domElement;
    if (!canvas) return;
    const onLost = (event: Event): void => {
      // Prevent the browser's default "lost" teardown so restoration can
      // reuse the context; freeze all animation state until it returns.
      event.preventDefault();
      sceneState.contextLost = true;
    };
    const onRestored = (): void => {
      // The context is back — the clock resumes from where it froze (no jump).
      sceneState.contextLost = false;
    };
    canvas.addEventListener("webglcontextlost", onLost, false);
    canvas.addEventListener("webglcontextrestored", onRestored, false);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, [gl]);
  return null;
}

/**
 * Tracks `prefers-reduced-motion` (accessibility.md) and mirrors it into
 * {@link sceneState.reducedMotion}. SSR-safe: under Node there is no
 * `matchMedia`, so the flag stays `false`.
 *
 * Call from a component inside the scene host (it uses `useEffect`, so it is
 * a no-op during server render).
 */
export function useReducedMotionSync(): void {
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = (): void => {
      sceneState.reducedMotion = query.matches;
    };
    apply();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", apply);
      return () => query.removeEventListener("change", apply);
    }
    // Older Safari: addListener API.
    query.addListener(apply);
    return () => query.removeListener(apply);
  }, []);
}
