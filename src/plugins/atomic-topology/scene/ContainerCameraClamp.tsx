"use client";

/**
 * Keeps the camera inside the circuit-board container (operator directive 15).
 * Runs after `SceneOrbitControls` has applied the frame's orbit/zoom/pan and
 * before the scene renders, softly compressing the camera position into the
 * container (see `containerBounds.ts`). It does not touch the orbit controls,
 * the default pose, auto-fit, reset or focus logic: when the pose is already
 * inside it is a no-op.
 */
import { useFrame, useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";

import { useAtomicSceneContext } from "./sceneContext";
import { containerBounds, softClampToBounds } from "./containerBounds";

// Dev A/B only: `?clamp=0` disables the containment (proves it never fights focus/zoom).
const noClamp =
  typeof window !== "undefined" &&
  process.env.NODE_ENV !== "production" &&
  new URLSearchParams(window.location.search).get("clamp") === "0";

/** Dev-only camera dump for the camera-limit / focus evidence scripts. */
function writeCamDebug(
  pos: { x: number; y: number; z: number },
  target: readonly number[],
  bounds: unknown,
  far: number
): void {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return;
  (window as unknown as { __atomicCamDbg?: unknown }).__atomicCamDbg = {
    pos: [pos.x, pos.y, pos.z],
    target: [...target],
    bounds,
    far,
  };
}

export function ContainerCameraClamp() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const { cameraState } = useAtomicSceneContext();
  useFrame(() => {
    const b = containerBounds.value;
    writeCamDebug(camera.position, cameraState.target, b, camera.far);
    if (!b || noClamp) return;
    const p = camera.position;
    const c = softClampToBounds([p.x, p.y, p.z], b);
    if (c[0] === p.x && c[1] === p.y && c[2] === p.z) return;
    p.set(c[0], c[1], c[2]);
    const t = cameraState.target;
    camera.lookAt(t[0], t[1], t[2]);
    camera.updateMatrixWorld();
    // eslint-disable-next-line react-hooks/immutability -- AtomicCameraState is the shared per-frame bridge the label overlay reads (mutation is the contract)
    cameraState.position[0] = c[0];
    cameraState.position[1] = c[1];
    cameraState.position[2] = c[2];
  }, 0.5);
  return null;
}
