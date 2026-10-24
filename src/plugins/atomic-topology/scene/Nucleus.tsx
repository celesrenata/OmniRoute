"use client";

/**
 * The hub nucleus — the central atom of the topology (OR-ATOM-003, V4).
 *
 * Rendered at the world origin as a dense cluster of tightly packed
 * proton/neutron particles wrapped around a brand-accent core. The hub reads
 * as a distinct, multi-particle body — not a single smooth sphere.
 *
 * **Brand vs. health separation (V7):** the core sphere carries the brand
 * accent (`#6366f1` indigo) as the hub's *identity* color. Runtime health is
 * expressed by a thin luminous ring (the "health halo") around the core,
 * colored by the resolved visual state (`NUCLEUS_STATE_COLOR`). This keeps the
 * hub visually distinct from provider atoms while still communicating health.
 *
 * **Separate nucleus spin from cloud orbital (V4):** the particle cluster
 * rotates at the descriptor's `spin` speed (TPS-driven; "unavailable" → the
 * neutral 0.1 rad/s reference). The {@link ElectronCloud} orbital motion is a
 * *fixed* ambient speed (0.4 rad/s) — the two are decoupled so the nucleus
 * "spin" (a data-driven signal) and the cloud "orbit" (ambient visual
 * decoration) never conflate.
 *
 * **GPU instancing (V4):** the ~48-particle cluster is a single
 * `InstancedMesh` (1 draw call), deterministically placed on a Fibonacci
 * sphere. No per-particle React state; the per-frame mutation is a single
 * group-rotation (the nucleus spin).
 *
 * Pure with respect to props: the descriptor drives every visual attribute.
 * R3F/three are confined to this `scene/**` subtree.
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import type { AtomVisualDescriptor, AtomicVisualState } from "../AtomicTopologyRenderer";
import { QUALITY_BUDGETS } from "../quality";
import { useAtomicSceneContext } from "./sceneContext";
import { ElectronCloud } from "./ElectronCloud";
import {
  HUB_BRAND_ACCENT,
  NUCLEUS_CLUSTER_RADIUS_FACTOR,
  NUCLEUS_PARTICLE_RADIUS_FACTOR,
  NUCLEUS_RADIUS,
  PARTICLE_COUNT_HIGH,
  PARTICLE_COUNT_LOW,
  nucleusParticleField,
} from "./geometry";

/** Nucleus health-halo color per resolved visual state (V7). */
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

  // Brand-accent core (identity) + health halo (state).
  const coreColor = HUB_BRAND_ACCENT;
  const haloColor =
    NUCLEUS_STATE_COLOR[descriptor.visualState.state] ?? NUCLEUS_STATE_COLOR.healthy;

  // Focused hub glows more strongly (readable emphasis without orbiting).
  const coreEmissive = focused ? 0.85 : 0.5;
  const haloEmissive = focused ? 0.7 : 0.45;

  // Dense particle cluster (instanced, 1 draw call).
  const particleCount = quality === "low" ? PARTICLE_COUNT_LOW : PARTICLE_COUNT_HIGH;
  const clusterRadius = NUCLEUS_RADIUS * NUCLEUS_CLUSTER_RADIUS_FACTOR;
  const particleRadius = clusterRadius * NUCLEUS_PARTICLE_RADIUS_FACTOR;

  // Deterministic positions + colors (proton/neutron alternating — pure,
  // shared with the ring-atom nuclei via ./geometry).
  const particles = useMemo(
    () => nucleusParticleField(particleCount, clusterRadius),
    [particleCount, clusterRadius]
  );

  // Instanced-mesh ref (the GPU-instanced particle cluster).
  const clusterRef = useRef<THREE.InstancedMesh | null>(null);

  // Set instance matrices + colors once (deterministic layout).
  useEffect(() => {
    const mesh = clusterRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < particleCount; i++) {
      const [x, y, z] = particles[i].position;
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, new THREE.Color(particles[i].color));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [particles, particleCount]);

  // Nucleus spin (TPS-driven, separate from the cloud orbital).
  const spinSpeed = descriptor.spin.value;

  useFrame((_state, delta) => {
    if (paused) return;
    const mesh = clusterRef.current;
    if (!mesh) return;
    const dt = Math.min(delta, 0.1);
    mesh.rotation.y += spinSpeed * dt;
  });

  return (
    <group position={[0, 0, 0]}>
      {/* Brand-accent core sphere (hub identity, separate from health). */}
      <mesh>
        <sphereGeometry args={[NUCLEUS_RADIUS * 0.52, 48, 48]} />
        <meshStandardMaterial
          color={coreColor}
          emissive={coreColor}
          emissiveIntensity={coreEmissive}
          roughness={0.25}
          metalness={0.3}
        />
      </mesh>

      {/* Dense instanced proton/neutron cluster (V4 — GPU instancing, 1 draw call). */}
      <instancedMesh
        ref={clusterRef}
        args={[undefined, undefined, particleCount]}
        key={particleCount}
      >
        <sphereGeometry args={[particleRadius, 10, 10]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#ffffff"
          emissiveIntensity={0.35}
          roughness={0.35}
          metalness={0.15}
        />
      </instancedMesh>

      {/* Health halo — a thin luminous ring colored by the resolved state (V7). */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[NUCLEUS_RADIUS * 0.62, 1.2, 8, 64]} />
        <meshStandardMaterial
          color={haloColor}
          emissive={haloColor}
          emissiveIntensity={haloEmissive}
          roughness={0.4}
          metalness={0.1}
          transparent
          opacity={0.85}
        />
      </mesh>

      {/* Slow multi-shell orbital cloud (ambient, decoupled from nucleus spin). */}
      <ElectronCloud
        radius={NUCLEUS_RADIUS + 22}
        speed={0.4}
        paused={paused}
        color={HUB_BRAND_ACCENT}
        electronCount={QUALITY_BUDGETS[quality].cloudParticles}
        shellCount={3}
      />
    </group>
  );
}
