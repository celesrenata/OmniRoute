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
import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { PerspectiveCamera } from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import type { AtomicSceneProps } from "../AtomicTopologyRenderer";
import { computeCameraFit, computeCameraFocus, isUsableCameraFit } from "../cameraFit";
import { LEGACY_BLOOM, resolveRenderDpr } from "../quality";

import { Nucleus } from "./Nucleus";
import { AtomNode } from "./AtomNode";
import { EnergyLink } from "./EnergyLink";
import { SceneOrbitControls } from "./SceneOrbitControls";
import { ContextGuard } from "./ContextGuard";
import {
  CanvasContextGuard,
  SceneClockDriver,
  sceneState,
  useReducedMotionSync,
} from "./sceneState";
import { RtTopologyContent } from "./RtTopologyScene";
import { createRtCanvasRenderer } from "./rt/rendererFactory";
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
export function AtomicScene(props: AtomicSceneProps) {
  // Dev A/B only (query params, never a production toggle): `?atomic-fx=legacy`
  // mounts the pre-Gate-B WebGL renderer until Gate B is approved.
  const fx = useMemo(() => readDevFx(), []);
  return fx.legacy ? (
    <LegacyAtomicScene {...props} />
  ) : (
    <RtAtomicScene {...props} bloom={fx.bloom} />
  );
}

/** Dev-only query flags (`atomic-fx=legacy`, `bloom=0`, `backend=webgl`). */
function readDevFx(): {
  legacy: boolean;
  bloom: boolean;
  forceWebGL: boolean;
  failRestore: boolean;
} {
  if (typeof window === "undefined")
    return { legacy: false, bloom: true, forceWebGL: false, failRestore: false };
  const q = new URLSearchParams(window.location.search);
  return {
    legacy: q.get("atomic-fx") === "legacy",
    bloom: q.get("bloom") !== "0",
    forceWebGL: q.get("backend") === "webgl",
    // Dev only: every renderer rebuild after the first fails (drives the 2D fallback).
    failRestore: q.get("restore-fail") === "1" && process.env.NODE_ENV !== "production",
  };
}

/** Full retina: the device pixel ratio, uncapped (no quality tiers). */
function deviceDpr(): number {
  const d = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  return resolveRenderDpr(d);
}

/** Document-hidden pause shared by both scene paths. */
function useDocumentHidden(): boolean {
  const [documentHidden, setDocumentHidden] = useState<boolean>(() =>
    typeof document !== "undefined" ? document.hidden : false
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => setDocumentHidden(document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  return documentHidden;
}

/** Restores attempted after a GPU device / context loss before giving up to 2D. */
const MAX_RESTORE_FAILURES = 2;

/**
 * The ray-traced scene (Gate B): `WebGPURenderer` (WebGL2 backend fallback)
 * inside the same R3F `<Canvas>` composition, so the camera rig, the label
 * camera bridge and the orbit controls are the unchanged components below.
 *
 * Device / context loss: the clock freezes, the Canvas (renderer, pipeline,
 * materials, environment) is torn down and rebuilt on a fresh canvas; after
 * {@link MAX_RESTORE_FAILURES} failed rebuilds the host is told to fall back
 * to the 2D renderer (`onRendererFatal`).
 */
function RtAtomicScene({
  descriptors,
  linkDescriptors,
  paused,
  focusNodeId,
  sceneContext,
  onRendererFatal,
  bloom,
}: AtomicSceneProps & { bloom: boolean }) {
  const documentHidden = useDocumentHidden();
  useReducedMotionSync();
  const effectivePaused = paused || documentHidden;
  const context = sceneContext;
  const [epoch, setEpoch] = useState(0);
  const failures = useRef(0);
  const forceWebGL = useMemo(() => readDevFx().forceWebGL, []);
  const failRestore = useMemo(() => readDevFx().failRestore, []);
  const builds = useRef(0);
  const dpr = useMemo(() => deviceDpr(), []);

  const onLost = useCallback(() => {
    sceneState.contextLost = true;
    failures.current += 1;
    if (failures.current > MAX_RESTORE_FAILURES) {
      onRendererFatal?.();
      return;
    }
    // Rebuild on a fresh canvas (a lost canvas can never be reused).
    setEpoch((e) => e + 1);
  }, [onRendererFatal]);

  const glFactory = useCallback(
    async (defaults: { canvas: HTMLCanvasElement | OffscreenCanvas }) => {
      const disposed = { value: false };
      builds.current += 1;
      if (failRestore && builds.current > 1) throw new Error("dev: forced restore failure");
      const { renderer, device } = await createRtCanvasRenderer(defaults.canvas, {
        forceWebGL,
        onDeviceLost: (reason) => {
          // Our own teardown destroys the device too; only real losses rebuild.
          if (disposed.value && !forcedLoss.value) return;
          forcedLoss.value = false;
          void reason;
          onLost();
        },
      });
      const dispose = renderer.dispose.bind(renderer);
      (renderer as unknown as { dispose: () => void }).dispose = () => {
        disposed.value = true;
        dispose();
      };
      installLossHook(renderer, device);
      return renderer as never;
    },
    [forceWebGL, failRestore, onLost]
  );

  return (
    <CanvasErrorBoundary key={epoch} onError={onLost}>
      <Canvas gl={glFactory} dpr={dpr} frameloop="always">
        <AtomicSceneContext.Provider value={context}>
          <SceneClockDriver paused={effectivePaused} />
          <CanvasContextGuard />
          <ContextGuard />
          <RestoreWatch
            onReady={() => {
              failures.current = 0;
              sceneState.contextLost = false;
            }}
            onLost={onLost}
          />
          <CameraRig context={context} />
          <CameraStateWriter context={context} />
          <SceneOrbitControls />
          <RtTopologyContent
            descriptors={descriptors}
            linkDescriptors={linkDescriptors}
            paused={effectivePaused}
            focusNodeId={focusNodeId}
            bloom={bloom}
          />
        </AtomicSceneContext.Provider>
      </Canvas>
    </CanvasErrorBoundary>
  );
}

/** Set before a dev-forced `device.destroy()` so it counts as a real loss. */
const forcedLoss = { value: false };

/**
 * Dev / test hook (non-production only): `window.__atomicForceContextLoss()`
 * destroys the live WebGPU device (or loses the WebGL2 context) to exercise
 * the recovery path end to end.
 */
function installLossHook(renderer: unknown, device: GPUDevice | null): void {
  if (typeof window === "undefined" || process.env.NODE_ENV === "production") return;
  (window as unknown as { __atomicForceContextLoss?: () => string }).__atomicForceContextLoss =
    () => {
      if (device) {
        forcedLoss.value = true;
        device.destroy();
        return "webgpu:device.destroy";
      }
      const gl = (renderer as { backend?: { gl?: WebGL2RenderingContext } }).backend?.gl;
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      return "webgl:WEBGL_lose_context";
    };
}

/**
 * Inside the Canvas: marks the renderer healthy after the first frames, and
 * turns a WebGL2-backend `webglcontextlost` into the same rebuild path as a
 * WebGPU device loss.
 */
function RestoreWatch({ onReady, onLost }: { onReady: () => void; onLost: () => void }) {
  const gl = useThree((s) => s.gl);
  const frames = useRef(0);
  useEffect(() => {
    const canvas = gl.domElement;
    if (!canvas) return;
    const lost = () => onLost();
    canvas.addEventListener("webglcontextlost", lost);
    return () => canvas.removeEventListener("webglcontextlost", lost);
  }, [gl, onLost]);
  useFrame(() => {
    frames.current += 1;
    if (frames.current === 3) onReady();
  });
  return null;
}

/** Catches a failed renderer (re)initialisation so it counts as a failed restore. */
class CanvasErrorBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(): void {
    this.props.onError();
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The pre-Gate-B WebGL renderer, reachable only with `?atomic-fx=legacy` (dev
 * A/B) until Gate B is approved, then deleted. Full retina DPR + antialias; no
 * quality tiers.
 */
function LegacyAtomicScene({
  descriptors,
  linkDescriptors,
  paused,
  focusNodeId,
  sceneContext,
  bloomOverride,
}: AtomicSceneProps) {
  const documentHidden = useDocumentHidden();
  useReducedMotionSync();
  const effectivePaused = paused || documentHidden;
  const context = sceneContext;
  const bloomBudget = bloomOverride ?? LEGACY_BLOOM;
  const dpr = useMemo(() => deviceDpr(), []);

  return (
    <Canvas gl={{ antialias: true, powerPreference: "high-performance", alpha: true }} dpr={dpr}>
      <AtomicSceneContext.Provider value={context}>
        <SceneClockDriver paused={effectivePaused} />
        <ColorScience />
        {bloomBudget.enabled && (
          <BloomComposer
            strength={bloomBudget.strength}
            radius={bloomBudget.radius}
            threshold={bloomBudget.threshold}
          />
        )}
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
/**
 * OR-ATOM-010 T10.5 — renderer-level color science (NO postprocessing pass).
 *
 * Filmic ACES tone mapping + sRGB output + a modest exposure lift. This
 * gives the additive glow / env-map speculars the "bloom" roll-off the
 * spec asks for WITHOUT a second render target — the no-postFX path of the
 * quality ladder. One-time renderer state: zero per-frame cost, no effect
 * targets, no render-target leaks. Must sit INSIDE the `<Canvas>` so it
 * can read the live WebGL renderer via `useThree`.
 */
function ColorScience() {
  const gl = useThree((s) => s.gl);
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- the three.js WebGLRenderer is imperative state, not React-managed: tone mapping / exposure / color space are set once on the live renderer (the same R3F contract as the camera mutation above), so mutating `gl` IS the contract
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    // Exposure lift (OR-ATOM-010 T10.5 retune): the scene's per-atom radiance is
    // low (emissive ≈0.25–1.2, additive glows ≈0.2–0.4 over near-black), so at
    // exposure 1.1 ACES lands everything in the desaturated dark-mid band — the
    // "muted, small, washed-blue" look. Lifting to 1.65 pushes the additive
    // halos + fresnel rims into the luminous ACES roll-off region so the orbs
    // read as neon light sources on the dark background, while ACES keeps the
    // highlights controlled (no washout). Renderer-level only: no post-FX pass,
    // no layout/camera/label change.
    // OR-ATOM-010 T10.5d iteration-d: 1.65 → 1.9. The filament core + plasma
    // ribbon now carry higher opacity/width (EnergyLink), and the atoms'
    // emissive rims are unchanged — lifting the global exposure a notch
    // pushes the additive halos into the ACES roll-off so the scene reads as
    // luminous on the dark background without washing out (ACES keeps the
    // highlight shoulder controlled). Renderer-level only.
    gl.toneMappingExposure = 1.9;
    gl.outputColorSpace = THREE.SRGBColorSpace;
  }, [gl]);
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
/**
 * GPU bloom postprocessing chain — OR-ATOM-010 T10.5e.
 *
 * The per-tier `bloom` budget from {@link QUALITY_BUDGETS} drives a three-pass
 * `EffectComposer` (`RenderPass → UnrealBloomPass → OutputPass`). Disabled
 * tiers (`low` / `none`) keep the direct renderer path: the ACES tone map is
 * applied by the renderer itself on the canvas render (r186
 * `WebGLPrograms.js` tone-maps only when `currentRenderTarget === null`), so
 * `enabled: false` is the cheapest possible path — no composer allocation.
 *
 * **Render takeover (single pass).** The composer renders *instead of* R3F's
 * internal `gl.render()`: the `useFrame(..., 1)` positive render priority
 * increments the canvas store's `internal.priority` counter (r9.8.1
 * `events…esm.js:1159`), which suppresses the auto-render gate at
 * `…esm.js:17419` (`if (!state.internal.priority && state.gl.render)`).
 * Registering a positive-priority subscription is the documented R3F way to
 * "take rendering into your own hands" — so `composer.render()` is the sole
 * render per frame and the scene is never drawn twice. The positive priority
 * also *defends* the contract: any other positive-priority `useFrame` added
 * later to the scene would also take over rendering and double-render unless
 * it renders through the same composer.
 *
 * **Sizing / lifecycle.** `EffectComposer` is NOT auto-resized by R3F's
 * `Canvas` dpr / resize handling, so a `ResizeObserver` on the canvas syncs
 * the internal render-target buffers (DPR-aware: the canvas *drawing*
 * buffer is the physical size; logical width/height = physical / DPR).
 * Disposal mirrors the three r186 pass API: `EffectComposer.dispose()`
 * frees only `renderTarget1/2` + `copyPass`, so the `bloom` and `output`
 * passes are disposed explicitly (their `renderTargetBright` / mips /
 * materials leak otherwise).
 *
 * **Color pipeline.** `OutputPass` is the composer's last pass (the r186
 * tone-map/encoding equivalent of the renderer's built-in tone map) — it
 * re-reads `gl.toneMapping` (ACES), `gl.toneMappingExposure` (1.9) and
 * `gl.outputColorSpace` (sRGB) every frame, so the `ColorScience` retune is
 * honored through the postFX chain instead of being skipped (the renderer
 * tone-maps only on the direct canvas render, never on the composer's
 * HalfFloat render-target passes).
 *
 * **Pause.** `frameloop="always"` drives this `useFrame` regardless of the
 * scene's pause state — the same clock-advancing `SceneClockDriver`
 * subscription contract. The clock accumulates 0 while paused, so the scene
 * holds a static (but bloom-lit) frame, identical to the no-postFX pause
 * behavior.
 */
function BloomComposer({
  strength,
  radius,
  threshold,
}: {
  strength: number;
  radius: number;
  threshold: number;
}) {
  // Stable object references via selectors — each `useThree` subscription keys
  // off one slice of the R3F store, so this component does NOT re-render on
  // per-frame camera writes or unrelated state changes (a full `useThree()`
  // destructure would). The tier-level numbers arrive as stable props, so the
  // composer is built exactly once per mount (a quality-tier flip remounts the
  // scene, which unmounts / remounts this component).
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const composerRef = useRef<EffectComposer | null>(null);
  // Reusable temp for `getSize` / `getDrawingBufferSize` (avoids per-resize
  // allocation). Kept in a ref so a second mounted instance cannot mutate it.
  const tmpVec2Ref = useRef(new THREE.Vector2());
  useEffect(() => {
    const composer = new EffectComposer(gl);
    composer.addPass(new RenderPass(scene, camera));
    const initSize = gl.getSize(tmpVec2Ref.current);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, initSize.x), Math.max(1, initSize.y)),
      strength,
      radius,
      threshold
    );
    composer.addPass(bloomPass);
    const outputPass = new OutputPass();
    composer.addPass(outputPass);
    composerRef.current = composer;
    return () => {
      // Dispose the passes explicitly — the composer's own `dispose()`
      // only frees its buffers and the built-in `copyPass`.
      bloomPass.dispose();
      outputPass.dispose();
      composer.dispose();
      composerRef.current = null;
    };
    // The pass parameters are tier-level constants (a
    // quality change remounts
    // this component, not this effect).
  }, [gl, scene, camera, strength, radius, threshold]);
  // Keep the composer buffers in step with the canvas drawing buffer
  // (R3F manages the canvas size / DPR, not the composer — see the module
  // doc above). The canvas *drawing* buffer is the physical size;
  // `getPixelRatio` is the canvas DPR R3F sets from the `dpr` prop.
  useEffect(() => {
    const canvas = gl.domElement;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      // Defer to the next frame so the canvas `width` / `height` attributes
      // (which R3F sets via the resize event) are current.
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const composer = composerRef.current;
        if (!composer) return;
        const physical = gl.getDrawingBufferSize(tmpVec2Ref.current);
        const dpr = Math.max(0.0001, gl.getPixelRatio());
        const w = Math.max(1, Math.floor(physical.x / dpr));
        const h = Math.max(1, Math.floor(physical.y / dpr));
        composer.setPixelRatio(dpr);
        composer.setSize(w, h);
      });
    });
    observer.observe(canvas);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [gl]);
  // Sole render path (see the render-takeover note above).
  useFrame((_, delta) => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.render(delta);
  }, 1);
  return null;
}

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
      <ambientLight intensity={0.4} />
      {/* A point light at the nucleus gives the atoms a soft core highlight. */}
      <pointLight
        position={[0, 0, 0]}
        intensity={2.4}
        distance={2600}
        decay={1.2}
        color="#dbeafe"
      />
      <directionalLight position={[400, 600, 400]} intensity={0.5} />
      {/* OR-ATOM-010 T10.5d iteration-d — cinematic rim/backlight: a cool
       *  directional from behind-and-above the nucleus reads as an in-scene
       *  rim/atmosphere term (lighting only — no post pass, screen-space
       *  independent, zero render-target cost). It gives the nucleon shells
       *  and orbital trails a directional falloff the flat ambient key
       *  cannot, so the scene reads as "lit from behind" like the neon
       *  references without claiming unavailable bloom postprocessing. */}
      <directionalLight position={[-380, 260, -420]} intensity={0.7} color="#4f7cff" />
      {/* OR-ATOM-010 T10.5 — depth cue: exponential fog matched to the host
       *  canvas background (#05060f) so outer-ring atoms recede into a
       *  deep-navy atmosphere instead of floating on flat black. Dense
       *  enough to read as "depth" at the default camera distance
       *  (~1500–2500 world units from the nucleus) but light enough that
       *  the hub nucleus and first two rings stay crisp. Fog is a
       *  scene-level state (three `scene.fog`), not a post pass — zero
       *  render-target cost, SSR-safe (the fog element is a no-op outside
       *  a Canvas), and frozen automatically under pause/reduced-motion
       *  because it is a static material parameter, not a per-frame
       *  animation. */}
      <fogExp2 attach="fog" args={["#05060f", 0.00018]} />

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
