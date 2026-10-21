/**
 * Atomic scene context — shared, per-frame state the scene primitives read
 * (OR-ATOM-001 v2, M4/M6).
 *
 * A single `React` context (no `three`, no R3F) carried from the `<Canvas>`
 * root down to the scene primitives (`AtomNode`, `EnergyLink`,
 * `SceneOrbitControls`). Reading it through `useContext` keeps the per-frame
 * discharge read (the event pool) off React state — the pool lives in a stable
 * ref owned by the imperative instance, and each primitive reads the current
 * discharge inside `useFrame` (animated mode) or once at render (reduced-motion
 * mode). This is the "refs / pooling / no per-frame React state" contract.
 *
 * Why a context instead of props: the `<SceneOrbitControls />` mount in
 * `AtomicScene.tsx` stays a clean self-closing tag (a contract pinned by
 * `tests/unit/atomic-topology/sceneOrbitControls.test.ts`), and the scene
 * primitives don't need to know about the imperative adapter — only about the
 * ambient scene state.
 */
import { createContext, useContext } from "react";

import type { AtomicEventPool } from "../eventPool";
import type { AtomicSceneQuality } from "../quality";

/** A world-space position (the focused atom / orbit target). */
export interface SceneWorldPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * A mutable, per-frame camera snapshot the DOM label overlay reads (UX
 * correction for the detached label roster).
 *
 * The scene (inside the R3F `<Canvas>`) writes the live camera position +
 * orbit target + viewport size into this object every frame (via `useFrame`).
 * The DOM overlay (`overlays/AtomicLabels.tsx`) is *outside* the R3F tree, so
 * it cannot use `useFrame`; instead it reads this object inside its own
 * `requestAnimationFrame` loop and positions the projected labels
 * imperatively (no React re-render). This keeps the label overlay three-free
 * (no `three` / R3F import) while still tracking the live camera.
 *
 * `valid` is `false` until the scene has written at least one frame — the
 * overlay falls back to the compact roster until then (projection is not
 * safely available yet).
 */
export interface AtomicCameraState {
  /** Camera world position (written by the scene every frame). */
  position: [number, number, number];
  /** Orbit target the camera looks at (written by the scene every frame). */
  target: [number, number, number];
  /** Vertical FOV in degrees (matches the R3F camera). */
  fovDeg: number;
  /** Viewport aspect ratio (width / height). */
  aspect: number;
  /** Near clipping plane (world units). */
  near: number;
  /** Far clipping plane (world units). */
  far: number;
  /** Viewport CSS-pixel width (the scene canvas). */
  viewportWidth: number;
  /** Viewport CSS-pixel height (the scene canvas). */
  viewportHeight: number;
  /** True once the scene has written at least one frame (projection usable). */
  valid: boolean;
}

/** Create a fresh, not-yet-valid camera state (safe defaults for the overlay). */
export function createAtomicCameraState(): AtomicCameraState {
  return {
    position: [0, 250, 1000],
    target: [0, 0, 0],
    fovDeg: 50,
    aspect: 1,
    near: 1,
    far: 3000,
    viewportWidth: 0,
    viewportHeight: 0,
    valid: false,
  };
}

/** The ambient scene state every Atomic scene primitive can read. */
export interface AtomicSceneContextValue {
  /**
   * The bounded request-lifecycle event pool (transient discharges). `null`
   * when the host has no pool (the steady-state-only path — e.g. a snapshot
   * with no lifecycle feed). Primitives treat `null` as "no discharge".
   */
  pool: AtomicEventPool | null;
  /** World position to center the view on (`focusNode`), or `null`. */
  focusTarget: SceneWorldPosition | null;
  /** Reduced motion: minimize continuous animation (settle-on-update). */
  reducedMotion: boolean;
  /** Coarse render quality (drives geometry/segment/DPR budgets). */
  quality: AtomicSceneQuality;
  /** Camera vertical FOV (deg) — shared so fit/focus math matches the rig. */
  cameraFovDeg: number;
  /** Camera viewport aspect (width/height) — 1 when unknown. */
  cameraAspect: number;
  /**
   * The snapshot's capture time (epoch ms) — the deterministic clock the
   * *render-time* discharge reads are pinned to (reduced-motion static
   * emphasis). Using the snapshot's own `capturedAt` keeps renders pure (no
   * wall clock during render); per-frame animated reads still advance on the
   * wall clock inside `useFrame`. `0` when the snapshot has no capture time
   * (discharges then read at age `−observedAt`, i.e. already settled).
   */
  nowMs: number;
  /**
   * The mutable per-frame camera snapshot the DOM label overlay reads
   * (projected labels — see {@link AtomicCameraState}). The scene writes it
   * every frame; the overlay reads it via `requestAnimationFrame`. Stable for
   * the lifetime of the host (created once, mutated in place).
   */
  cameraState: AtomicCameraState;
  /**
   * The framing radius (world units) computed from the *actual* atom positions
   * (see {@link computeFitRadiusFromPositions} in `cameraFit.ts`). Replaces the
   * constant `DEFAULT_FIT_RADIUS` so a small fleet is not framed at the full
   * layout radius. Computed by the adapter, read by the scene's `CameraRig`.
   */
  fitRadius: number;
}

/**
 * The ambient scene context. `null` is a valid value (outside the Canvas);
 * {@link useAtomicSceneContext} returns a safe default in that case.
 */
export const AtomicSceneContext = createContext<AtomicSceneContextValue | null>(null);

/** Safe accessor — returns a default value when read outside the Canvas. */
export function useAtomicSceneContext(): AtomicSceneContextValue {
  return (
    useContext(AtomicSceneContext) ?? {
      pool: null,
      focusTarget: null,
      reducedMotion: false,
      quality: "high",
      cameraFovDeg: 50,
      cameraAspect: 1,
      nowMs: 0,
      cameraState: createAtomicCameraState(),
      fitRadius: 1010,
    }
  );
}
