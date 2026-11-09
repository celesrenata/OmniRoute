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
 * **Fallback.** There are no quality tiers: full retina DPR and AA always. The
 * 2D fallback decision is owned by the host, gated on the WebGL2 capability.
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
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";

import type { AtomicSceneProps } from "../AtomicTopologyRenderer";
import { computeCameraFit, computeCameraFocus, isUsableCameraFit } from "../cameraFit";
import { resolveRenderDpr } from "../quality";
import { clampRelax } from "./containerBounds";
import {
  detailGoalDistance,
  detailFov,
  detailComposition,
  detailAtomGeometries,
  detailSafeArea,
  clearDetailSweep,
  DETAIL_SWEEP_RAD,
  viewOffsetPx,
  DETAIL_FOV_DEG,
  type DetailComposition,
  type DetailRect,
  driftYawRate,
  flightOffset,
  flightProgress,
  DETAIL_FLIGHT_MS,
} from "./detailFlight";

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
  // Dev A/B only (query params, never a production toggle): `?bloom=0`,
  // `?backend=webgl`, `?restore-fail=1`.
  const fx = useMemo(() => readDevFx(), []);
  return <RtAtomicScene {...props} bloom={fx.bloom} />;
}

/** Dev-only query flags (`bloom=0`, `backend=webgl`, `restore-fail=1`). */
function readDevFx(): {
  bloom: boolean;
  forceWebGL: boolean;
  failRestore: boolean;
} {
  if (typeof window === "undefined") return { bloom: true, forceWebGL: false, failRestore: false };
  const q = new URLSearchParams(window.location.search);
  return {
    bloom: q.get("bloom") !== "0",
    forceWebGL: q.get("backend") === "webgl",
    // Dev only: every renderer rebuild after the first fails (drives the 2D fallback).
    failRestore: q.get("restore-fail") === "1" && process.env.NODE_ENV !== "production",
  };
}

/** Fraction of the fit distance the camera keeps from a focused atom (close hero framing). */
const FOCUS_DISTANCE_FACTOR = 0.38;

/** Full retina: the device pixel ratio, uncapped (no quality tiers). */
function deviceDpr(): number {
  const d = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  return resolveRenderDpr(d);
}

/** Document-hidden pause. */
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
          <VisibilityGate />
          <CameraRig context={context} />
          <CameraStateWriter context={context} />
          <DetailFlight context={context} />
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

/**
 * Stops the render loop while nothing can be seen (directive 19): the tab is
 * hidden (`visibilitychange`) or the canvas is scrolled out of view / not
 * visible (`IntersectionObserver`). The loop resumes, and invalidates once, as
 * soon as it is visible again. Independent of (and in addition to) the pause
 * prop, which keeps freezing the clock while frames still render.
 */
function VisibilityGate() {
  const gl = useThree((s) => s.gl);
  const setFrameloop = useThree((s) => s.setFrameloop);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const canvas = gl.domElement;
    if (!canvas) return;
    let inView = true;
    const apply = (): void => {
      const run = inView && !document.hidden;
      setFrameloop(run ? "always" : "never");
      if (run) invalidate();
    };
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            const last = entries[entries.length - 1];
            if (last) {
              inView = last.isIntersecting;
              apply();
            }
          })
        : null;
    io?.observe(canvas);
    document.addEventListener("visibilitychange", apply);
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", apply);
      setFrameloop("always");
    };
  }, [gl, setFrameloop, invalidate]);
  return null;
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
  // Opt-in detail view (Step 11): `DetailFlight` owns the camera position while
  // the viewer is inspecting an atom, so this rig must not snap it.
  const detailActive = Boolean(context.detailAtomId) && focusPosition != null;

  useEffect(() => {
    const focused = focusPosition
      ? computeCameraFocus(focusPosition, { fovDeg: SCENE_FOV_DEG, aspect, radius: fitRadius })
      : null;
    let fit =
      focused && isUsableCameraFit(focused)
        ? focused
        : computeCameraFit({ fovDeg: SCENE_FOV_DEG, aspect, radius: fitRadius });
    if (focused && fit === focused) {
      // Focus view: fly in along the same viewing direction so the focused atom
      // fills the frame (idea5 hero framing). Rotation is untouched; the orbit
      // controls still own zoom (min distance 200) and the container clamp is soft.
      const k = FOCUS_DISTANCE_FACTOR;
      const [lx, ly, lz] = fit.lookAt;
      fit = {
        ...fit,
        position: [
          lx + (fit.position[0] - lx) * k,
          ly + (fit.position[1] - ly) * k,
          lz + (fit.position[2] - lz) * k,
        ],
      };
    }
    if (!detailActive) {
      camera.position.set(fit.position[0], fit.position[1], fit.position[2]);
      camera.lookAt(fit.lookAt[0], fit.lookAt[1], fit.lookAt[2]);
    }
    // eslint-disable-next-line react-hooks/immutability -- the three.js PerspectiveCamera is imperative state: mutation is the R3F contract (React does not render it; frustum planes must track the fit — R3F's default far=1000 would clip the scene blank)
    camera.fov = SCENE_FOV_DEG;
    camera.near = fit.near;
    camera.far = fit.far;
    camera.updateProjectionMatrix();
  }, [camera, focusPosition, aspect, fitRadius, resetToken, detailActive]);

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
 * Opt-in detail view camera fly-in (Step 11). Active only while
 * `context.detailAtomId` is set and the atom has a focus target. It eases the
 * camera toward the inspected atom (pure pose math in `detailFlight.ts`) and
 * releases control to the unchanged orbit controls when the flight ends or the
 * viewer grabs the canvas (pointer / wheel). Mounted before
 * `<SceneOrbitControls />` so its pose is what the controls' `update()` keeps.
 * The default view never mounts any of this work: with no detail atom the
 * component is inert.
 */
/**
 * Imperative fov + lens-shift write (the three.js camera is R3F's mutable state, same
 * as `CameraRig`). DOM labels follow the lens shift through two CSS variables on the
 * host (see `detailLabelCss`), so they stay on their atoms.
 */
function applyDetailLens(
  camera: PerspectiveCamera,
  dom: HTMLCanvasElement | undefined,
  host: HTMLElement | null,
  fov: number,
  shift: readonly [number, number]
): void {
  const w = dom?.clientWidth ?? 0;
  const h = dom?.clientHeight ?? 0;
  camera.fov = fov;
  if (w > 0 && h > 0) {
    const px = viewOffsetPx(shift, w, h);
    camera.setViewOffset(w, h, px.x, px.y, w, h); // also updates the projection matrix
    host?.style.setProperty("--atomic-lens-x", `${(-px.x).toFixed(2)}px`);
    host?.style.setProperty("--atomic-lens-y", `${(-px.y).toFixed(2)}px`);
  } else {
    camera.updateProjectionMatrix();
  }
}
/** DOM overlays inside the atomic host that the hero shot must stay clear of. */
const DETAIL_OVERLAY_SELECTOR =
  "[data-atomic-legend],[data-atomic-detail],[data-atomic-controls],[data-atomic-telemetry-status]";
/** The host card's 2D/Atomic toggle sits over the canvas but outside the plugin host. */
const DETAIL_HOST_OVERLAY_SELECTOR = '[role="group"][aria-label="Topology view mode"]';
/** Overlay rectangles in canvas CSS px (only what actually covers the canvas). */
function measureDetailOverlays(canvas: HTMLCanvasElement): {
  width: number;
  height: number;
  rects: DetailRect[];
  host: HTMLElement | null;
} {
  const c = canvas.getBoundingClientRect();
  const host = canvas.closest<HTMLElement>("[data-atomic-host]");
  const els: Element[] = host ? Array.from(host.querySelectorAll(DETAIL_OVERLAY_SELECTOR)) : [];
  const fsEl = typeof document !== "undefined" ? document.fullscreenElement : null;
  const hostFullscreen = Boolean(host && fsEl && (fsEl === host || fsEl.contains(host)));
  if (host && !hostFullscreen) {
    let up: HTMLElement | null = host.parentElement;
    for (let i = 0; i < 4 && up; i += 1, up = up.parentElement) {
      const found = up.querySelectorAll(DETAIL_HOST_OVERLAY_SELECTOR);
      if (found.length > 0) {
        els.push(...Array.from(found));
        break;
      }
    }
  }
  const rects: DetailRect[] = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    rects.push({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height });
  }
  return { width: c.width, height: c.height, rects, host };
}
function DetailFlight({ context }: { context: AtomicSceneContextValue }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const gl = useThree((state) => state.gl);
  const detailId = context.detailAtomId ?? null;
  // The descriptors (and so `focusTarget`) are rebuilt on every snapshot; keep
  // the latest values in a ref so a telemetry refresh never restarts the flight.
  const live = useRef(context);
  useEffect(() => {
    live.current = context;
  });
  const flight = useRef<{
    active: boolean;
    elapsedMs: number;
    o0: [number, number, number] | null;
    goal: number;
    /** Cinematic drift (settled shot) is running until the viewer grabs the camera. */
    drift: boolean;
    driftMs: number;
    /** Last eased flight progress (drives the fov and the lens shift). */
    e: number;
    /** Hero field of view and lens shift (safe-area composition). */
    goalFov: number;
    goalShift: [number, number];
    /** Shift / fov currently applied (eased toward the goal after a re-composition). */
    shift: [number, number];
    fov: number;
    /** Yaw sweep that ends with a clear line of sight to the atom. */
    sweep: number;
    /** The overlays or the canvas changed size: recompose on the next frame. */
    dirty: boolean;
    composed: boolean;
    host: HTMLElement | null;
  }>({
    active: false,
    elapsedMs: 0,
    o0: null,
    goal: 0,
    drift: false,
    driftMs: 0,
    e: 0,
    goalFov: DETAIL_FOV_DEG,
    goalShift: [0, 0],
    shift: [0, 0],
    fov: SCENE_FOV_DEG,
    sweep: DETAIL_SWEEP_RAD,
    dirty: false,
    composed: false,
    host: null,
  });

  useEffect(() => {
    const f = flight.current;
    if (!detailId) {
      f.active = false;
      f.drift = false;
      f.o0 = null;
      return;
    }
    const c = live.current;
    const fit = computeCameraFit({
      fovDeg: SCENE_FOV_DEG,
      aspect: c.cameraAspect,
      radius: c.fitRadius,
    });
    const fitDistance = Math.hypot(fit.position[0], fit.position[1], fit.position[2]);
    f.goal = detailGoalDistance(fitDistance);
    f.goalFov = DETAIL_FOV_DEG;
    f.goalShift = [0, 0];
    f.shift = [0, 0];
    f.fov = SCENE_FOV_DEG;
    f.composed = false;
    f.dirty = true; // composed on the first frame (the detail panel has mounted by then)
    f.elapsedMs = 0;
    f.o0 = null; // captured on the first frame, from the live camera
    f.active = true;
    f.drift = false;
    f.driftMs = 0;
    f.e = 0;
    clampRelax.detail = true; // low eye-level shot: shrink the soft wall band (still inside)
    const dom = gl.domElement;
    const stop = (): void => {
      f.active = false;
      f.drift = false; // the viewer owns the camera now
    };
    dom?.addEventListener("pointerdown", stop);
    dom?.addEventListener("wheel", stop, { passive: true });
    // Recompose when the canvas or an overlay changes size (card resize, fullscreen,
    // the detail panel expanding). Debounced; never per frame.
    const host = dom?.closest<HTMLElement>("[data-atomic-host]") ?? null;
    f.host = host;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const markDirty = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        f.dirty = true;
      }, 120);
    };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(markDirty) : null;
    const observeAll = (): void => {
      if (!ro || !dom) return;
      ro.disconnect();
      ro.observe(dom);
      host?.querySelectorAll(DETAIL_OVERLAY_SELECTOR).forEach((el) => ro.observe(el));
    };
    observeAll();
    const mo =
      host && typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            observeAll();
            markDirty();
          })
        : null;
    mo?.observe(host as HTMLElement, { childList: true });
    document.addEventListener("fullscreenchange", markDirty);
    return () => {
      dom?.removeEventListener("pointerdown", stop);
      dom?.removeEventListener("wheel", stop);
      document.removeEventListener("fullscreenchange", markDirty);
      if (timer) clearTimeout(timer);
      ro?.disconnect();
      mo?.disconnect();
      f.active = false;
      f.drift = false;
      f.composed = false;
      clampRelax.detail = false;
      // Exact restore: no lens shift; CameraRig re-applies the scene fov on exit.
      camera.clearViewOffset();
      host?.style.removeProperty("--atomic-lens-x");
      host?.style.removeProperty("--atomic-lens-y");
    };
  }, [detailId, gl, camera]);

  useFrame((_s, delta) => {
    const f = flight.current;
    const c = live.current;
    const target = c.focusTarget;
    if (!target || !detailId) return;
    if (f.dirty && gl.domElement) {
      const geo = detailAtomGeometries.get(detailId);
      if (geo) {
        f.dirty = false;
        const m = measureDetailOverlays(gl.domElement);
        const safe = detailSafeArea(m.width, m.height, m.rects);
        const tgt: [number, number, number] = [target.x, target.y, target.z];
        let comp: DetailComposition;
        if (!f.composed) {
          comp = detailComposition(geo, tgt, { width: m.width, height: m.height }, safe);
          f.goal = comp.distance;
          f.composed = true;
        } else {
          // Re-composition (resize / panel change): keep the flight's goal distance
          // while flying, the viewer's distance once settled.
          const d = f.active
            ? f.goal
            : Math.hypot(
                camera.position.x - target.x,
                camera.position.y - target.y,
                camera.position.z - target.z
              );
          comp = detailComposition(
            geo,
            tgt,
            { width: m.width, height: m.height },
            safe,
            undefined,
            d
          );
        }
        f.goalFov = comp.fovDeg;
        f.goalShift = comp.shift;
        if (typeof window !== "undefined") {
          (window as unknown as { __atomicDetailComposition?: unknown }).__atomicDetailComposition =
            { safe, comp, canvas: { width: m.width, height: m.height }, overlays: m.rects };
        }
      }
    }
    // Lens: during the flight it follows the eased progress; afterwards it eases to
    // the latest composition (frame-rate independent, instant in reduced motion).
    const k = c.reducedMotion ? 1 : 1 - Math.exp(-8 * Math.min(delta, 0.1));
    const goalFovNow = f.active ? detailFov(SCENE_FOV_DEG, f.e, f.goalFov) : f.goalFov;
    const goalShiftNow: [number, number] = f.active
      ? [f.goalShift[0] * f.e, f.goalShift[1] * f.e]
      : f.goalShift;
    if (f.e > 0) {
      const nf = f.active ? goalFovNow : f.fov + (goalFovNow - f.fov) * k;
      const ns: [number, number] = f.active
        ? goalShiftNow
        : [
            f.shift[0] + (goalShiftNow[0] - f.shift[0]) * k,
            f.shift[1] + (goalShiftNow[1] - f.shift[1]) * k,
          ];
      if (
        Math.abs(nf - camera.fov) > 1e-4 ||
        Math.abs(ns[0] - f.shift[0]) > 1e-5 ||
        Math.abs(ns[1] - f.shift[1]) > 1e-5 ||
        !camera.view?.enabled
      ) {
        f.fov = nf;
        f.shift = ns;
        applyDetailLens(camera, gl.domElement, f.host, nf, ns);
      }
    }
    if (!f.active) {
      // Settled hero shot: slow bounded yaw sway about the atom (off in reduced motion).
      if (f.drift && !c.reducedMotion) {
        f.driftMs += Math.min(delta, 0.1) * 1000;
        const dyaw = driftYawRate(f.driftMs, false) * Math.min(delta, 0.1);
        const ox = camera.position.x - target.x;
        const oz = camera.position.z - target.z;
        const cs = Math.cos(dyaw);
        const sn = Math.sin(dyaw);
        camera.position.set(
          target.x + ox * cs + oz * sn,
          camera.position.y,
          target.z - ox * sn + oz * cs
        );
      }
      return;
    }
    if (!f.composed) return; // wait one frame for the geometry + overlays
    if (!f.o0) {
      f.o0 = [
        camera.position.x - target.x,
        camera.position.y - target.y,
        camera.position.z - target.z,
      ];
      // Never park the hero camera behind (or inside) a neighbouring atom.
      const geo = detailAtomGeometries.get(detailId);
      const others = [...detailAtomGeometries.entries()]
        .filter(([id]) => id !== detailId)
        .map(([, g]) => ({ center: g.center, radius: g.envelope }));
      f.sweep = geo
        ? clearDetailSweep(
            [target.x, target.y, target.z],
            geo.center,
            Math.atan2(f.o0[0], f.o0[2]),
            f.goal,
            others
          )
        : DETAIL_SWEEP_RAD;
    }
    f.elapsedMs += Math.min(delta, 0.1) * 1000;
    const e = flightProgress(f.elapsedMs, c.reducedMotion);
    f.e = Math.max(e, 1e-6);
    const o = flightOffset(f.o0, f.goal, e, f.sweep);
    camera.position.set(target.x + o[0], target.y + o[1], target.z + o[2]);
    if (f.elapsedMs >= DETAIL_FLIGHT_MS || c.reducedMotion) {
      f.active = false;
      f.drift = !c.reducedMotion;
      f.driftMs = 0;
    }
  });

  return null;
}
