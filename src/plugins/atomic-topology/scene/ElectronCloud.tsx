"use client";

/**
 * Electron cloud — the reusable spinning shell an atom (or the hub nucleus)
 * wears (OR-ATOM-001 v2, M3 Phase B).
 *
 * A ring of small "electron" spheres that rotates around the atom at the
 * per-atom speed supplied by the pure encoding
 * (`spinRadiansPerSecond` — see `AtomVisualDescriptor.spin`). When `paused` is
 * true the shell holds still (the `setPaused` contract).
 *
 * The spin is driven in `useFrame` (R3F's frame loop) — no React state per
 * frame, so there are no re-renders and no shared host state.
 *
 * `three` / R3F are confined to this `scene/**` subtree.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

/** Props for a reusable electron shell. */
export interface ElectronCloudProps {
  /** Shell radius (world units) — the orbit radius of the electrons. */
  radius: number;
  /** Spin speed in radians/second (from `spinRadiansPerSecond`). */
  speed: number;
  /** When true the shell does not advance (host `setPaused`). */
  paused: boolean;
  /** Electron color (usually the atom's lane hue). */
  color: string;
  /** Number of electrons on the shell (default 5). */
  electronCount?: number;
}

/**
 * A slowly-spinning shell of electrons around an atom.
 *
 * Pure with respect to props: `speed` / `paused` come from the pure
 * {@link AtomVisualDescriptor} encoding; the only per-frame mutation is the
 * group's rotation (an imperative three.js update, not React state).
 */
export function ElectronCloud({
  radius,
  speed,
  paused,
  color,
  electronCount = 5,
}: ElectronCloudProps) {
  const shellRef = useRef<THREE.Group | null>(null);

  // Deterministic electron positions on a circle (index-stable, no randomness).
  const electrons = useMemo(() => {
    const count = Math.max(1, Math.floor(electronCount));
    return Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2;
      return {
        position: [Math.cos(angle) * radius, 0, Math.sin(angle) * radius] as [
          number,
          number,
          number,
        ],
      };
    });
  }, [radius, electronCount]);

  // Advance the shell rotation each frame — but only when not paused.
  useFrame((_state, delta) => {
    if (paused) return;
    const shell = shellRef.current;
    if (!shell) return;
    // Clamp delta so a tab-switch spike cannot fling the shell forward.
    shell.rotation.y += speed * Math.min(delta, 0.1);
  });

  return (
    // A slight tilt so the shell reads as an orbit plane, not a flat disc.
    <group rotation={[0.35, 0, 0.12]}>
      <group ref={shellRef}>
        {electrons.map((electron, i) => (
          <mesh key={i} position={electron.position}>
            <sphereGeometry args={[Math.max(2.5, radius * 0.05), 16, 16]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={0.55}
              roughness={0.4}
              metalness={0.2}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}
