"use client";

/**
 * Electron cloud — the reusable multi-shell orbital system an atom (or the hub
 * nucleus) wears (OR-ATOM-002 item 6: replaces the single flat 5-dot ring).
 *
 * 2–3 tilted orbital shells, each a thin torus "orbit line" plus a few
 * electrons, spinning at the per-atom speed. Shells are tilted at distinct
 * angles so the cloud reads as a 3D orbital system, not a flat disc.
 *
 * **Bounded draw calls:** the total electron count is capped by the quality
 * budget (`cloudParticles`), distributed across `shellCount` shells. At the
 * `low` quality the outer shell is dropped (2 shells) and each shell carries
 * fewer electrons, keeping the per-atom draw-call budget flat regardless of
 * atom count.
 *
 * **Reduced motion:** each shell holds still when `paused` is true; no
 * per-frame mutation occurs.
 *
 * `three` / R3F are confined to this `scene/**` subtree.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

/** Props for the multi-shell electron cloud. */
export interface ElectronCloudProps {
  /** Shell radius (world units) — the orbit radius of the electrons. */
  radius: number;
  /** Spin speed in radians/second (from `spinRadiansPerSecond`). */
  speed: number;
  /** When true the shell does not advance (host `setPaused`). */
  paused: boolean;
  /** Electron/orbit color (lane hue; neutral fallback when lane is unknown). */
  color: string;
  /** Total electron budget across all shells (from `QUALITY_BUDGETS`). */
  electronCount?: number;
  /** Number of orbital shells (default 3; clamped to ≥1, ≤3). */
  shellCount?: number;
}

/**
 * Per-shell tilt (X-axis radians). Deterministic, distinct per shell index so
 * no two shells share a plane — the cloud reads as a 3D orbital system.
 */
const SHELL_TILTS_X = [0.45, -0.2, 0.9] as const;
/** Per-shell Z-rotation (radians) — additional tilt variety. */
const SHELL_TILTS_Z = [0.2, 0.55, -0.35] as const;
/** Per-shell speed multiplier (outer shells spin slightly slower). */
const SHELL_SPEED_FACTOR = [1.0, 0.72, 0.5] as const;
/**
 * Per-shell radius multiplier (OR-ATOM-002, V5). Without this every shell
 * shares the *same* radius and the cloud reads as one tilted disc; scaling
 * the shells inner→outer gives the layered-depth orbital system the spec asks
 * for. The innermost shell sits just outside the atom core, the outermost is
 * the widest visible orbit.
 */
const SHELL_RADIUS_FACTOR = [0.72, 1.0, 1.3] as const;

/**
 * A multi-shell orbital electron cloud around an atom.
 *
 * Pure with respect to props: `speed` / `paused` come from the pure
 * {@link AtomVisualDescriptor} encoding; the only per-frame mutation is each
 * shell group's rotation (imperative three.js, not React state).
 */
export function ElectronCloud({
  radius,
  speed,
  paused,
  color,
  electronCount = 12,
  shellCount = 3,
}: ElectronCloudProps) {
  const shellsRef = useRef<(THREE.Group | null)[]>([]);

  const shells = useMemo(() => {
    const count = Math.min(3, Math.max(1, Math.floor(shellCount)));
    const perShell = Math.max(2, Math.floor(electronCount / count));
    return Array.from({ length: count }, (_, s) => {
      const tiltX = SHELL_TILTS_X[s] ?? 0.4;
      const tiltZ = SHELL_TILTS_Z[s] ?? 0.2;
      const speedFactor = SHELL_SPEED_FACTOR[s] ?? 0.5;
      const shellRadius = radius * (SHELL_RADIUS_FACTOR[s] ?? 1);
      const electrons = Array.from({ length: perShell }, (_, i) => {
        const angle = (i / perShell) * Math.PI * 2 + s * 0.6;
        return [
          Math.cos(angle) * shellRadius,
          0,
          Math.sin(angle) * shellRadius,
        ] as [number, number, number];
      });
      return { tiltX, tiltZ, speedFactor, shellRadius, electrons };
    });
  }, [radius, electronCount, shellCount]);

  useFrame((_state, delta) => {
    if (paused) return;
    const dt = Math.min(delta, 0.1);
    for (let s = 0; s < shells.length; s += 1) {
      const shell = shellsRef.current[s];
      if (shell) shell.rotation.y += speed * shells[s].speedFactor * dt;
    }
  });

  return (
    <group>
      {shells.map((shell, s) => (
        <group key={s} rotation={[shell.tiltX, 0, shell.tiltZ]}>
          <group
            ref={(el) => {
              shellsRef.current[s] = el;
            }}
          >
            {/* Thin orbit line (torus) — the "electron path". Each shell uses
                its own radius so the cloud reads as layered depth (V5). */}
            <mesh>
              <torusGeometry args={[shell.shellRadius, Math.max(0.8, shell.shellRadius * 0.012), 6, 48]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={0.35}
                roughness={0.5}
                metalness={0.1}
                transparent
                opacity={0.45}
              />
            </mesh>
            {/* Electrons on this shell. */}
            {shell.electrons.map((pos, i) => (
              <mesh key={i} position={pos}>
                <sphereGeometry args={[Math.max(2.2, shell.shellRadius * 0.04), 12, 12]} />
                <meshStandardMaterial
                  color={color}
                  emissive={color}
                  emissiveIntensity={0.6}
                  roughness={0.4}
                  metalness={0.2}
                />
              </mesh>
            ))}
          </group>
        </group>
      ))}
    </group>
  );
}
