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

import { useAtomicSceneContext, resolveOrbitTarget } from "./sceneContext";

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
 * - **Focus pivot tracking (OR-ATOM-002, V2):** `controls.target` is not left
 *   at the origin — every frame it eases toward the focused atom
 *   (`context.focusTarget`), or back to the origin when no atom is focused.
 *   Because `OrbitControls.update()` re-derives the camera from its target,
 *   tracking the pivot is what makes `CameraRig`'s focus slide *persist*
 *   (without it, the first `update()` yanks the camera back to an origin
 *   orbit). Reduced motion settles the pivot in one step instead of easing.
 *
 * The callback captured by `useFrame` is always the latest render's closure
 * (R3F keeps the subscription stable but invokes the current callback), so
 * `enabled` is never stale.
 */
export function SceneOrbitControls({ enabled = true }: { enabled?: boolean }) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const controlsRef = useRef<OrbitControls | null>(null);
  // The mutable per-frame camera snapshot the DOM label overlay reads (UX
  // correction — projected labels). This component owns the live OrbitControls
  // instance, so it is the *target* writer: every frame (after damping
  // `update()`) it copies `controls.target` into the shared state. The camera
  // position / frustum / viewport halves are written by `CameraStateWriter`.
  const { focusTarget, reducedMotion, cameraState } = useAtomicSceneContext();

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

  // eslint-disable-next-line react-hooks/immutability -- this component is the orbit-target writer: AtomicCameraState is the intentional per-frame shared mutable bridge (see sceneContext.ts), so copying controls.target into it every frame IS the contract
  useFrame((_state, delta) => {
    const controls = controlsRef.current;
    if (controls) {
      // Ease the orbit pivot toward the focused atom (or the origin when no
      // atom is focused). `update()` below re-derives the camera from this
      // target, so the CameraRig focus slide survives the frame — the pivot
      // move *is* the animation. Frame-rate-independent settle (~0.2s);
      // reduced motion snaps in one step.
      const goal = resolveOrbitTarget(focusTarget);
      const target = controls.target;
      const dx = goal[0] - target.x;
      const dy = goal[1] - target.y;
      const dz = goal[2] - target.z;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-3) {
        const k = reducedMotion ? 1 : 1 - Math.exp(-12 * Math.min(delta, 0.1));
        target.set(target.x + dx * k, target.y + dy * k, target.z + dz * k);
      }
      controls.update();
      // eslint-disable-next-line react-hooks/immutability -- per-frame orbit-target write to the shared mutable bridge (mutation is the contract)
      cameraState.target[0] = controls.target.x;
      cameraState.target[1] = controls.target.y;
      cameraState.target[2] = controls.target.z;
    }
  });

  // No R3F primitive is rendered — this component only wires up the imperative
  // controls, so it contributes nothing to the rendered tree.
  return null;
}
