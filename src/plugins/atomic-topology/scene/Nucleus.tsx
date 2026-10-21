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
import { useMemo } from "react";

import type { AtomVisualDescriptor, AtomicVisualState } from "../AtomicTopologyRenderer";
import { QUALITY_BUDGETS } from "../quality";
import { useAtomicSceneContext } from "./sceneContext";
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
  const { quality } = useAtomicSceneContext();
  const coreColor =
    NUCLEUS_STATE_COLOR[descriptor.visualState.state] ?? NUCLEUS_STATE_COLOR.healthy;
  // A focused atom glows more strongly (readable emphasis without orbiting).
  const emissiveIntensity = focused ? 0.6 : 0.35;

  // Layered hub particles (OR-ATOM-002 item 5): a fixed band of small
  // "proton/neutron" spheres around the core makes the nucleus read as a
  // distinct multi-particle body (not a single matte sphere). Deterministic
  // positions (index-keyed), no randomness, no per-frame React state.
  const hubParticles = useMemo(() => {
    const count = 8;
    return Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2;
      return {
        position: [
          Math.cos(angle) * NUCLEUS_RADIUS * 0.82,
          Math.sin(angle * 1.3) * NUCLEUS_RADIUS * 0.4,
          Math.sin(angle) * NUCLEUS_RADIUS * 0.82,
        ] as [number, number, number],
        color: i % 2 === 0 ? "#bfdbfe" : "#e2e8f0",
      };
    });
  }, []);

  return (
    <group position={[0, 0, 0]}>
      {/* Core — slightly smaller, so the particle band reads as a shell. */}
      <mesh>
        <sphereGeometry args={[NUCLEUS_RADIUS * 0.72, 48, 48]} />
        <meshStandardMaterial
          color={coreColor}
          emissive={coreColor}
          emissiveIntensity={emissiveIntensity + 0.15}
          roughness={0.3}
          metalness={0.2}
        />
      </mesh>
      {/* Layered particle band — the hub is visually distinct from atoms. */}
      {hubParticles.map((p, i) => (
        <mesh key={i} position={p.position}>
          <sphereGeometry args={[NUCLEUS_RADIUS * 0.16, 20, 20]} />
          <meshStandardMaterial
            color={p.color}
            emissive={p.color}
            emissiveIntensity={emissiveIntensity * 0.5}
            roughness={0.35}
            metalness={0.15}
          />
        </mesh>
      ))}

      {/* A slow multi-shell orbital cloud around the nucleus so the hub reads
          as "alive" (3 tilted shells vs. the atoms' smaller cloud). */}
      <ElectronCloud
        radius={NUCLEUS_RADIUS + 26}
        speed={0.4}
        paused={paused}
        color="#93c5fd"
        electronCount={QUALITY_BUDGETS[quality].cloudParticles}
        shellCount={3}
      />
    </group>
  );
}
