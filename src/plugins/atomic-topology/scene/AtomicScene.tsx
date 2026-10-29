"use client";

/**
 * Atomic 3D scene — the R3F `<Canvas>` composition (OR-ATOM-001 v2, T006b / M3
 * Phase B + M4/M6 hardening).
 *
 * This module is the *only* place in the plugin that mounts a live R3F canvas,
 * and it is the sole top-level consumer of `three` + `@react-three/fiber`. It
 * is reached only through the adapter's client-only `import()` (see
 * `AtomicTopologyRenderer.tsx`), so `three`/R3F never enter the static module
 * graph of the plugin entry or of the jsdom test run.
 *
 * Composition:
 *   - `AtomicScene`    — the `<Canvas>` + ambient context provider. It is
 *                        *outside* the R3F tree, so it does no `useThree`
 *                        reading of its own; everything that needs the R3F
 *                        state sits in a child *inside* the Canvas.
 *   - `CameraRig`      — deterministic camera fit / focus (M6). Frames the
 *                        ring layout via the pure {@link computeCameraFit},
 *                        or slides to the focused atom via
 *                        {@link computeCameraFocus}. No rotation — the orbit
 *                        controls own rotation.
 *   - `ContextGuard`   — WebGL context-loss safety (M6): `preventDefault` on
 *                        `webglcontextlost`, re-invalidate on
 *                        `webglcontextrestored`.
 *   - `SceneContent`   — lighting, the hub nucleus, the provider/gpu atoms,
 *                        the route energy links, and
 *                        `<SceneOrbitControls />`.
 *
 * **M6 — document-hidden pause.** A `document.visibilitychange` to `hidden`
 * pauses the scene (the animation primitives key off `paused`; R3F also
 * throttles hidden tabs), and it resumes on `visible`.
 *
 * **M6 — quality fallback.** The host-resolved quality tier (see
 * `quality.ts`) scales the `gl` antialias + `dpr` budgets via
 * {@link QUALITY_BUDGETS}; the 2D fallback decision itself is unchanged
 * (owned by the host, gated on the WebGL2 capability).
 *
 * Every position/color/state rendered comes from the pure
 * {@link AtomVisualDescriptor} / {@link LinkVisualDescriptor} computed by the
 * adapter (via `layout.ts` + `visualEncoding.ts`) — this module does no layout
 * math and no state resolution of its own. We intentionally avoid
 * `@react-three/drei` to keep the 3D dependency surface at just `three` +
 * `@react-three/fiber`.
 */
import { useEffect, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";

import type { AtomicSceneProps } from "../AtomicTopologyRenderer";
import { computeCameraFit, computeCameraFocus, isUsableCameraFit } from "../cameraFit";
import { QUALITY_BUDGETS } from "../quality";

import { Nucleus } from "./Nucleus";
import { AtomNode } from "./AtomNode";
import { EnergyLink } from "./EnergyLink";
import { SceneOrbitControls } from "./SceneOrbitControls";
import { ContextGuard } from "./ContextGuard";
import { CanvasContextGuard, SceneClockDriver, useReducedMotionSync } from "./sceneState";
import { AtomicSceneContext, type AtomicSceneContextValue } from "./sceneContext";

/** The scene's vertical FOV — shared by the camera fit math and the camera. */
const SCENE_FOV_DEG = 50;

/**
 * The Atomic scene root. Composes the canvas, lighting, the hub nucleus, the
 * provider/gpu atoms, the route energy links, and interactive orbit controls.
 *
 * Pure with respect to props: re-rendering with the same descriptors is a
 * no-op visually (R3F diffs the tree).
 */
export function AtomicScene({
  descriptors,
  linkDescriptors,
  paused,
  focusNodeId,
  sceneContext,
}: AtomicSceneProps) {
  // A document-hidden pause: the scene freezes when the tab/page is hidden
  // (bounded work, no GPU spend) and resumes when it is visible again.
  const [documentHidden, setDocumentHidden] = useState<boolean>(() =>
    typeof document !== "undefined" ? document.hidden : false
  );
  // Track prefers-reduced-motion → static render (OR-ATOM-007, accessibility.md).
  // Mirrors the media query into the shared scene state; a no-op under SSR.
  useReducedMotionSync();
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => setDocumentHidden(document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const effectivePaused = paused || documentHidden;
  const context = sceneContext;
  const budget = QUALITY_BUDGETS[context.quality];

  return (
    <Canvas
      gl={{ antialias: budget.antialias, powerPreference: "high-performance", alpha: true }}
      dpr={[1, budget.dprMax]}
    >
      <AtomicSceneContext.Provider value={context}>
        {/* OR-ATOM-007: pause-aware shared clock. Mounted FIRST so its useFrame
            advances sceneClock before every scene component reads it. */}
        <SceneClockDriver paused={effectivePaused} />
        {/* OR-ATOM-007: freeze the shared clock on WebGL2 context loss.
            Complements ContextGuard (which re-invalidates the renderer on
            restore) — together the scene holds a static frame and resumes. */}
        <CanvasContextGuard />
        <ContextGuard />
        <CameraRig context={context} />
        <CameraStateWriter context={context} />
        <SceneContent
          descriptors={descriptors}
          linkDescriptors={linkDescriptors}
          paused={effectivePaused}
          focusNodeId={focusNodeId}
        />
      </AtomicSceneContext.Provider>
    </Canvas>
  );
}

/**
 * Deterministic camera framing (M6) — now *responsive* (UX correction).
 *
 * Sits inside the `<Canvas>` so it can read the camera via `useThree`. Frames
 * the ring layout via the pure {@link computeCameraFit} using the *measured*
 * viewport aspect (`context.cameraAspect`) and the *actual* layout bounds
 * (`context.fitRadius` — see {@link computeFitRadiusFromPositions} in
 * `cameraFit.ts`), or slides to the focused atom via {@link computeCameraFocus}.
 * A non-finite / unordered fit is rejected by {@link isUsableCameraFit} and the
 * base fit is used.
 *
 * The fit's `near` / `far` / `fov` are applied to the live camera: R3F's
 * default `far` (1000) clips a default-radius fit (~2166 units back) blank, so
 * the frustum planes must track the fit or the topology never renders.
 *
 * Re-runs when the viewport aspect changes (container resize) so the framing
 * stays legible at any canvas aspect; it also runs once on mount.
 *
 * Renders nothing; it only positions the camera, so the user can still orbit /
 * zoom / pan via `<SceneOrbitControls>` (focus *slides* the view — it does not
 * rotate it, and the controls own all rotation).
 */
function CameraRig({ context }: { context: AtomicSceneContextValue }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const focusPosition = context.focusTarget;
  const aspect = context.cameraAspect;
  const fitRadius = context.fitRadius;
  const resetToken = context.resetToken;

  useEffect(() => {
    const focused = focusPosition
      ? computeCameraFocus(focusPosition, { fovDeg: SCENE_FOV_DEG, aspect, radius: fitRadius })
      : null;
    const fit =
      focused && isUsableCameraFit(focused)
        ? focused
        : computeCameraFit({ fovDeg: SCENE_FOV_DEG, aspect, radius: fitRadius });
    camera.position.set(fit.position[0], fit.position[1], fit.position[2]);
    camera.lookAt(fit.lookAt[0], fit.lookAt[1], fit.lookAt[2]);
    // eslint-disable-next-line react-hooks/immutability -- the three.js PerspectiveCamera is imperative state: mutation is the R3F contract (React does not render it; frustum planes must track the fit — R3F's default far=1000 would clip the scene blank)
    camera.fov = SCENE_FOV_DEG;
    camera.near = fit.near;
    camera.far = fit.far;
    camera.updateProjectionMatrix();
  }, [camera, focusPosition, aspect, fitRadius, resetToken]);

  return null;
}

/**
 * Per-frame camera snapshot writer (UX correction — projected labels).
 *
 * The DOM label overlay is *outside* the R3F tree, so it cannot use
 * `useFrame`; instead it reads the mutable {@link AtomicCameraState} carried
 * in the scene context. This component is the *only* writer: every frame it
 * copies the live camera position, the orbit target, the frustum params and
 * the viewport size into that shared object (in place — no React state, no
 * re-render, no `three` allocation on the overlay side).
 *
 * Runs every frame even while paused: orbit damping can still settle the
 * camera, and the overlay must not project against a stale view.
 */
function CameraStateWriter({ context }: { context: AtomicSceneContextValue }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const cameraState = context.cameraState;

  // NOTE: the orbit *target* is written by `<SceneOrbitControls />` (it owns
  // the live OrbitControls instance; R3F's `state.controls` is only populated
  // when controls are registered through the Canvas `controls` prop).
  useFrame(() => {
    const s = cameraState;
    // eslint-disable-next-line react-hooks/immutability -- AtomicCameraState is the intentional per-frame shared mutable bridge (see sceneContext.ts): identity is stable for the host's lifetime, the scene writes it and the DOM overlay reads it — mutation is the contract, no React state
    s.position[0] = camera.position.x;
    s.position[1] = camera.position.y;
    s.position[2] = camera.position.z;
    // eslint-disable-next-line react-hooks/immutability -- per-frame frustum write to the shared bridge (mutation is the contract)
    s.fovDeg = camera.fov;
    s.aspect = camera.aspect;
    s.near = camera.near;
    s.far = camera.far;
    s.viewportWidth = gl.domElement ? gl.domElement.clientWidth : size.width;
    s.viewportHeight = gl.domElement ? gl.domElement.clientHeight : size.height;
    s.valid = true;
  });

  return null;
}

/**
 * The scene body: lighting + the hub nucleus + the provider/gpu atoms + the
 * route energy links + the orbit controls. Rendered inside the
 * `<AtomicSceneContext.Provider>` so the scene primitives read the ambient
 * context (event pool, focus, reduced motion, quality).
 *
 * Pure with respect to props — R3F diffs the tree, so re-rendering with the
 * same descriptors is a no-op visually.
 */
function SceneContent({
  descriptors,
  linkDescriptors,
  paused,
  focusNodeId,
}: {
  descriptors: AtomicSceneProps["descriptors"];
  linkDescriptors: AtomicSceneProps["linkDescriptors"];
  paused: boolean;
  focusNodeId: string | null;
}) {
  const hub = descriptors.find((d) => d.kind === "hub") ?? null;
  const ringAtoms = descriptors.filter((d) => d.kind !== "hub");

  return (
    <>
      <ambientLight intensity={0.65} />
      {/* A point light at the nucleus gives the atoms a soft core highlight. */}
      <pointLight
        position={[0, 0, 0]}
        intensity={2.4}
        distance={2600}
        decay={1.2}
        color="#dbeafe"
      />
      <directionalLight position={[400, 600, 400]} intensity={0.5} />

      {/* Interactive orbit/zoom/pan around the nucleus. SSR-safe: renders no
       *  R3F primitive; the three OrbitControls attach to gl.domElement in an
       *  effect (never during server render). */}
      <SceneOrbitControls />

      {hub && <Nucleus descriptor={hub} paused={paused} focused={focusNodeId === hub.id} />}

      {ringAtoms.map((atom) => (
        <AtomNode
          key={atom.id}
          descriptor={atom}
          paused={paused}
          focused={focusNodeId === atom.id}
        />
      ))}

      {linkDescriptors.map((link) => (
        <EnergyLink key={link.id} descriptor={link} atoms={ringAtoms} paused={paused} />
      ))}
    </>
  );
}
