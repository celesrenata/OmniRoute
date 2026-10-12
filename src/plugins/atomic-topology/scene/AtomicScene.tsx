"use client";

/**
 * Atomic 3D scene — the R3F `<Canvas>` composition (OR-ATOM-001 v2, T006b / M3
 * Phase B).
 *
 * This module is the *only* place in the plugin that mounts a live R3F canvas,
 * and it is the sole top-level consumer of `three` + `@react-three/fiber`. It
 * is reached only through the adapter's client-only `import()` (see
 * `AtomicTopologyRenderer.tsx`), so `three`/R3F never enter the static module
 * graph of the plugin entry or of the jsdom test run.
 *
 * It is a thin *composition*: it owns the R3F `<Canvas>`, the lighting, and a
 * fixed camera, then delegates the atom/energy visuals to the scene
 * primitives:
 *   - `Nucleus`      — the hub (origin).
 *   - `AtomNode`     — one provider/gpu atom at its deterministic layout position.
 *   - `ElectronCloud`— the reusable spinning shell an atom wears.
 *   - `EnergyLink`   — one hub→atom route edge.
 *
 * Every position/color/state rendered here comes from the pure
 * {@link AtomVisualDescriptor} / {@link LinkVisualDescriptor} computed by the
 * adapter (via `layout.ts` + `visualEncoding.ts`) — this module does no layout
 * math and no state resolution of its own.
 *
 * Explicit unknowns (bounded scope — deliberately NOT implemented here):
 * - **Camera auto-fit**: the initial camera framing is fixed; auto-fitting an
 *   arbitrary atom count is out of scope. Interactive orbit *is* available via
 *   `<SceneOrbitControls>` (user-driven, not auto).
 * - **Event-pool pulses (M4)**: atoms reflect snapshot state only.
 * - **Live queue telemetry**: vibration is "unavailable" in M1 (see adapter).
 * - **GPU device atoms (`kind: "gpu"`)**: never emitted by M1; rendered
 *   forward-compatibly.
 */
import { Canvas } from "@react-three/fiber";

import type { AtomicSceneProps } from "../AtomicTopologyRenderer";

import { Nucleus } from "./Nucleus";
import { AtomNode } from "./AtomNode";
import { EnergyLink } from "./EnergyLink";
import { SceneOrbitControls } from "./SceneOrbitControls";

/**
 * The Atomic scene root. Composes the canvas, lighting, the hub nucleus, the
 * provider/gpu atoms, the route energy links, and interactive orbit controls.
 *
 * The camera has a *fixed initial framing* (position + look-at origin) but the
 * user can orbit / zoom / pan via `<SceneOrbitControls>` (wrapping three's
 * `OrbitControls`). We intentionally avoid `@react-three/drei` to keep the 3D
 * dependency surface at just `three` + `@react-three/fiber`.
 *
 * Pure with respect to props: re-rendering with the same descriptors is a
 * no-op visually (R3F diffs the tree).
 */
export function AtomicScene({
  descriptors,
  linkDescriptors,
  paused,
  focusNodeId,
}: AtomicSceneProps) {
  const hub = descriptors.find((d) => d.kind === "hub") ?? null;
  const ringAtoms = descriptors.filter((d) => d.kind !== "hub");

  // A fixed camera: positioned on a circle in front of the origin, looking at
  // the nucleus. (The scene is centered at the origin; ring radii are at most
  // ~1010 world units, so this framing keeps the first two rings in view.)
  const cameraPosition: [number, number, number] = [0, 160, 640];

  return (
    <Canvas
      gl={{ antialias: true, powerPreference: "high-performance", alpha: true }}
      dpr={[1, 2]}
      camera={{ position: cameraPosition, fov: 50, near: 1, far: 6000 }}
    >
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
        <EnergyLink key={link.id} descriptor={link} atoms={ringAtoms} />
      ))}
    </Canvas>
  );
}
