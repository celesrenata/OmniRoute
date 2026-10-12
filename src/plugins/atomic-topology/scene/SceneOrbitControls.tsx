"use client";

/**
 * Interactive orbit controls for the Atomic 3D scene (OR-ATOM-001 v2, M4).
 *
 * Wraps three's `OrbitControls` so the user can orbit / zoom / pan the scene
 * around the nucleus. It is mounted *inside* the R3F `<Canvas>` — it reads the
 * camera + WebGL renderer via `useThree` and attaches the imperative controls
 * to `gl.domElement` inside a `useEffect`.
 *
 * SSR-safe: the component renders **no** R3F primitive (it returns `null`), so
 * it is a no-op in the server render and in the tree diff. The only
 * three/WebGL touch (`new OrbitControls(...)`) happens in `useEffect`, which
 * never runs during server render, and is additionally guarded on the presence
 * of `gl.domElement`. (The whole scene module graph is already reached only
 * through the adapter's client-only `import()`, so this is belt-and-suspenders.)
 *
 * Deliberately NOT `@react-three/drei`'s `<OrbitControls>`: this keeps the 3D
 * dependency surface minimal (only `three` + `@react-three/fiber`, both already
 * in the scene graph) and lets us own the damping + dispose lifecycle
 * explicitly.
 */
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * Orbit / zoom / pan around the nucleus (the scene origin).
 *
 * - `enabled` gates the controls (default `true`); toggling it just flips the
 *   flag on the live controls instance — no re-creation.
 * - Damping is on for a smooth feel. Because damped controls need a per-frame
 *   `update()`, that is driven by `useFrame` so it participates in the same
 *   render loop as the atoms (and stays in sync with the auto-spin).
 * - Distance is clamped so the user cannot zoom into the nucleus or past the
 *   scene's `far` plane (the camera's `far` is 6000 in `AtomicScene`).
 *
 * The callback captured by `useFrame` is always the latest render's closure
 * (R3F keeps the subscription stable but invokes the current callback), so
 * `enabled` is never stale.
 */
export function SceneOrbitControls({ enabled = true }: { enabled?: boolean }) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const controlsRef = useRef<OrbitControls | null>(null);

  useEffect(() => {
    const dom = gl.domElement;
    if (!dom) return; // SSR / no DOM element yet — nothing to attach to.

    const controls = new OrbitControls(camera, dom);
    controls.target.set(0, 0, 0); // orbit around the nucleus (origin)
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 200;
    controls.maxDistance = 3000;
    controls.enabled = enabled;
    controls.update();
    controlsRef.current = controls;

    return () => {
      controls.dispose();
      controlsRef.current = null;
    };
    // `camera` / `gl` are stable for the lifetime of the Canvas; re-running on
    // them is harmless (disposes + rebuilds) and covers a remounted canvas.
  }, [camera, gl, enabled]);

  useFrame(() => {
    controlsRef.current?.update();
  });

  // No R3F primitive is rendered — this component only wires up the imperative
  // controls, so it contributes nothing to the rendered tree.
  return null;
}
