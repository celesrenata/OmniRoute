"use client";

/**
 * Atom node — one provider/gpu atom at its deterministic layout position
 * (OR-ATOM-001 v2, M3 Phase B).
 *
 * An atom is a sphere colored by its deterministic lane hue / provider color,
 * wearing a slow-spinning {@link ElectronCloud} at the per-atom
 * `spinRadiansPerSecond` speed, and — when a queue is measured — a subtle
 * positional "vibration" (tremor) at the `queueVibration` amplitude/frequency.
 *
 * The position comes from {@link AtomVisualDescriptor.position} (a pure
 * {@link computeAtomicLayout} output); the spin + vibration come from the pure
 * `visualEncoding`. This component does no math of its own except applying the
 * vibration offset per frame.
 *
 * `three` / R3F are confined to this `scene/**` subtree.
 *
 * Explicit unknowns:
 * - **Vibration in M1**: the snapshot carries no queue telemetry, so
 *   `descriptor.vibration.mode` is `"unavailable"` (amplitude 0) and the atom
 *   does not vibrate — we never fabricate a queue. The machinery is present so
 *   M4's queue telemetry lights it up with no scene change.
 * - **GPU device atoms (`kind: "gpu"`)**: never emitted by M1; rendered
 *   forward-compatibly like a provider.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import type { AtomVisualDescriptor } from "../AtomicTopologyRenderer";
import { ElectronCloud } from "./ElectronCloud";

/** World-space radius of a ring atom's core sphere. */
const ATOM_RADIUS = 22;
/** How much a focused atom grows (readable emphasis, not orbit). */
const FOCUS_SCALE = 1.18;

/** Per-state emissive boost (a focused/error atom glows brighter). */
const STATE_EMISSIVE: Record<AtomVisualDescriptor["visualState"]["state"], number> = {
  error: 0.9,
  active: 0.75,
  last: 0.5,
  healthy: 0.35,
  idle: 0.25,
};

export function AtomNode({
  descriptor,
  paused,
  focused,
}: {
  descriptor: AtomVisualDescriptor;
  paused: boolean;
  focused: boolean;
}) {
  const groupRef = useRef<THREE.Group | null>(null);

  const { position } = descriptor;
  const basePosition = useMemo<[number, number, number]>(
    () => [position.x, position.y, position.z],
    [position]
  );

  const { amplitude, frequencyHz, mode } = descriptor.vibration;
  const vibrating = !paused && mode === "measured" && amplitude > 0;

  // Per-frame update: apply the queue vibration (a small positional tremor)
  // when a queue is measured; hold still otherwise. No React state involved.
  useFrame((state) => {
    const group = groupRef.current;
    if (!group) return;
    if (vibrating) {
      // A gentle 3-axis tremor at the encoded amplitude/frequency. The phase is
      // derived from the clock time so it is continuous across re-renders.
      const t = state.clock.elapsedTime * frequencyHz * Math.PI * 2;
      group.position.set(
        position.x + Math.sin(t) * amplitude,
        position.y + Math.cos(t * 0.9) * amplitude,
        position.z + Math.sin(t * 1.1) * amplitude
      );
    } else {
      group.position.set(position.x, position.y, position.z);
    }
  });

  const emissiveBase = STATE_EMISSIVE[descriptor.visualState.state] ?? 0.35;
  const emissiveIntensity = focused ? emissiveBase + 0.3 : emissiveBase;
  const scale = focused ? FOCUS_SCALE : 1;

  return (
    <group ref={groupRef} position={basePosition}>
      {/* Core sphere — colored by the deterministic atom color. */}
      <mesh scale={scale}>
        <sphereGeometry args={[ATOM_RADIUS, 32, 32]} />
        <meshStandardMaterial
          color={descriptor.color}
          emissive={descriptor.laneHue}
          emissiveIntensity={emissiveIntensity}
          roughness={0.4}
          metalness={0.25}
        />
      </mesh>

      {/* Electron cloud spinning at the per-atom speed. */}
      <ElectronCloud
        radius={ATOM_RADIUS + 16}
        speed={descriptor.spin.value}
        paused={paused}
        color={descriptor.laneHue}
      />
    </group>
  );
}
