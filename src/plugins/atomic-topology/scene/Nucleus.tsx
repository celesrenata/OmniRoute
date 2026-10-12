"use client";

/**
 * The hub nucleus — the central atom of the topology (OR-ATOM-001 v2, M3
 * Phase B).
 *
 * Rendered at the world origin as a soft glowing sphere: the "nucleus" of the
 * atomic model. It wears a slow-spinning {@link ElectronCloud} shell so the
 * hub reads as "alive" without moving atoms.
 *
 * Pure with respect to props: the descriptor drives every visual attribute,
 * including the nucleus core color (healthy → blue, degraded → amber,
 * error → red) via the resolved visual state.
 *
 * R3F/three are accessed through R3F's lowercase JSX intrinsics (`<group>`,
 * `<mesh>`, ...), which are confined to this `scene/**` subtree.
 *
 * Explicit unknown: the nucleus is a fixed-size single sphere; there is no
 * adaptive scale for very large atom counts (camera auto-fit is also an
 * explicit unknown in `AtomicScene`).
 */
import type { AtomVisualDescriptor, AtomicVisualState } from "../AtomicTopologyRenderer";
import { ElectronCloud } from "./ElectronCloud";

/** World-space radius of the nucleus sphere. */
const NUCLEUS_RADIUS = 42;

/** Nucleus core color per resolved visual state. */
const NUCLEUS_STATE_COLOR: Record<AtomicVisualState, string> = {
  error: "#ef4444",
  active: "#3b82f6",
  last: "#60a5fa",
  healthy: "#3b82f6",
  idle: "#64748b",
};

export function Nucleus({
  descriptor,
  paused,
  focused,
}: {
  descriptor: AtomVisualDescriptor;
  paused: boolean;
  focused: boolean;
}) {
  const coreColor =
    NUCLEUS_STATE_COLOR[descriptor.visualState.state] ?? NUCLEUS_STATE_COLOR.healthy;
  // A focused atom glows more strongly (readable emphasis without orbiting).
  const emissiveIntensity = focused ? 0.6 : 0.35;

  return (
    <group position={[0, 0, 0]}>
      <mesh>
        <sphereGeometry args={[NUCLEUS_RADIUS, 48, 48]} />
        <meshStandardMaterial
          color={coreColor}
          emissive={coreColor}
          emissiveIntensity={emissiveIntensity}
          roughness={0.35}
          metalness={0.2}
        />
      </mesh>

      {/* A slow shell around the nucleus so the hub reads as "alive". */}
      <ElectronCloud radius={NUCLEUS_RADIUS + 26} speed={0.4} paused={paused} color="#93c5fd" />
    </group>
  );
}
