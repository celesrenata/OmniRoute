"use client";

/**
 * Electron cloud — the reusable multi-shell **elliptical** orbital system an
 * atom (or the hub nucleus) wears (OR-ATOM-003, V5).
 *
 * 2–3 tilted **elliptical** orbital shells (not flat circular tori). Each shell
 * is a thin luminous orbital line, a translucent volumetric "filament shell"
 * (the luminous volume), and a few bright electrons that travel *along* the
 * ellipse with a short curved trailing ghost (the "comet tail"). Shells are
 * tilted at distinct angles so the cloud reads as a 3D orbital system, not a
 * flat disc.
 *
 * **Dominant lane hue:** the whole cloud is tinted by the atom's dominant lane
 * hue (neutral slate when the lane is unknown) — passed in as `color`.
 *
 * **Tone-mapped glow:** no postprocessing. The luminous look comes from
 * elevated `emissiveIntensity` on the orbit line + electrons + a translucent
 * volumetric shell (three's built-in tone mapping handles the rolloff).
 *
 * **Bounded draw calls:** the total electron count is capped by the quality
 * budget (`cloudParticles`), distributed across `shellCount` shells. At the
 * `low` quality the outer shell is dropped (2 shells) and each shell carries
 * fewer electrons, keeping the per-atom draw-call budget flat.
 *
 * **Reduced motion / pause:** each electron holds its position when `paused`
 * is true (no per-frame advance); the cloud still renders statically.
 *
 * `three` / R3F are confined to this `scene/**` subtree.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import { type ElectronShellConfig, electronShellConfig } from "./geometry";

/** Props for the multi-shell electron cloud. */
export interface ElectronCloudProps {
  /** Shell radius (world units) — the major-axis radius of the outermost orbit. */
  radius: number;
  /** Spin speed in radians/second (from `spinRadiansPerSecond`; ambient for the cloud). */
  speed: number;
  /** When true the electrons do not advance (host `setPaused`). */
  paused: boolean;
  /** Electron/orbit color (lane hue; neutral fallback when lane is unknown). */
  color: string;
  /** Total electron budget across all shells (from `QUALITY_BUDGETS`). */
  electronCount?: number;
  /** Number of orbital shells (default 3; clamped to ≥1, ≤3). */
  shellCount?: number;
}

/**
 * Per-shell tilt / speed / radius / ellipticity tables and the per-shell
 * static geometry (the pure {@link ElectronShellConfig}) live in
 * `./geometry` — deterministic and unit-tested; this component only renders
 * them.
 */
/** Angular lag of the trailing ghost behind each electron (radians). */
const TRAIL_LAG = 0.22;

/** A single shell's static geometry configuration (pure, memoized). */
type ShellConfig = ElectronShellConfig;

/**
 * A multi-shell elliptical orbital electron cloud around an atom.
 *
 * Pure with respect to props: `speed` / `paused` come from the pure
 * {@link AtomVisualDescriptor} encoding; the only per-frame mutation is the
 * per-electron position advance along its ellipse (imperative three.js, not
 * React state — no per-frame React allocation).
 */
export function ElectronCloud({
  radius,
  speed,
  paused,
  color,
  electronCount = 12,
  shellCount = 3,
}: ElectronCloudProps) {
  const shells = useMemo<ShellConfig[]>(
    () => electronShellConfig(radius, electronCount, shellCount),
    [radius, electronCount, shellCount]
  );

  // Flat per-electron / per-ghost mesh refs (indexed by shell-major order).
  const electronRefs = useRef<(THREE.Mesh | null)[]>([]);
  const ghostRefs = useRef<(THREE.Mesh | null)[]>([]);
  // Per-shell orbital phase (advanced per frame; never React state). The
  // lazy initialization happens *inside* the frame loop — reading or writing a
  // ref during render is disallowed (react-hooks/refs), and the electrons are
  // rendered at their static starting positions anyway, so the first frame
  // after an unpause / shell-count change is the right moment to reset.
  const phaseRef = useRef<number[]>([]);

  useFrame((_state, delta) => {
    if (phaseRef.current.length !== shells.length) {
      phaseRef.current = shells.map(() => 0);
    }
    if (paused) return;
    const dt = Math.min(delta, 0.1);
    for (let s = 0; s < shells.length; s += 1) {
      const { rx, rz, electrons } = shells[s];
      phaseRef.current[s] =
        (phaseRef.current[s] + speed * shells[s].speedFactor * dt) % (Math.PI * 2);
      const phase = phaseRef.current[s];
      for (let i = 0; i < electrons.length; i += 1) {
        const angle = phase + (i / electrons.length) * Math.PI * 2;
        const electron = electronRefs.current[s * 16 + i];
        if (electron) electron.position.set(Math.cos(angle) * rx, 0, Math.sin(angle) * rz);
        const ghost = ghostRefs.current[s * 16 + i];
        if (ghost) {
          const gAngle = angle - TRAIL_LAG;
          ghost.position.set(Math.cos(gAngle) * rx, 0, Math.sin(gAngle) * rz);
        }
      }
    }
  });

  const electronRadius = Math.max(2.2, radius * 0.045);

  return (
    <group>
      {shells.map((shell, s) => (
        <group key={s} rotation={[shell.tiltX, 0, shell.tiltZ]}>
          {/* Elliptical orbital line (thin luminous torus, squashed to an ellipse). */}
          <mesh rotation={[Math.PI / 2, 0, 0]} scale={[1, shell.ellipticity, 1]}>
            <torusGeometry args={[shell.rx, Math.max(0.7, shell.rx * 0.01), 6, 64]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={0.9}
              roughness={0.5}
              metalness={0.1}
              transparent
              opacity={0.55}
            />
          </mesh>

          {/* Translucent volumetric filament shell — the luminous cloud volume. */}
          <mesh rotation={[Math.PI / 2, 0, 0]} scale={[1, shell.ellipticity, 1]}>
            <torusGeometry args={[shell.rx, shell.rx * 0.09, 6, 48]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={0.35}
              roughness={0.6}
              metalness={0}
              transparent
              opacity={0.1}
              depthWrite={false}
            />
          </mesh>

          {/* Electrons + curved trailing ghosts (travel along the ellipse). */}
          {shell.electrons.map((pos, i) => (
            <group key={i}>
              <mesh
                position={pos}
                ref={(mesh) => {
                  electronRefs.current[s * 16 + i] = mesh;
                }}
              >
                <sphereGeometry args={[electronRadius, 12, 12]} />
                <meshStandardMaterial
                  color={color}
                  emissive={color}
                  emissiveIntensity={1.2}
                  roughness={0.35}
                  metalness={0.15}
                />
              </mesh>
              {/* Trailing ghost — the curved "comet tail" behind the electron. */}
              <mesh
                position={pos}
                scale={0.65}
                ref={(mesh) => {
                  ghostRefs.current[s * 16 + i] = mesh;
                }}
              >
                <sphereGeometry args={[electronRadius, 10, 10]} />
                <meshStandardMaterial
                  color={color}
                  emissive={color}
                  emissiveIntensity={0.5}
                  roughness={0.5}
                  metalness={0.1}
                  transparent
                  opacity={0.4}
                  depthWrite={false}
                />
              </mesh>
            </group>
          ))}
        </group>
      ))}
    </group>
  );
}
