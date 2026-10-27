"use client";

/**
 * Electron cloud — layered, non-coplanar sprite orbital system (OR-ATOM-007).
 *
 * The reusable orbital shell an atom (or the hub nucleus) wears. Each shell is
 * a tilted **great circle** (2–3 shells, non-coplanar — the orientation is
 * deterministic from a seed, see {@link cloudShells}) with a slightly different
 * radius and a per-shell speed/phase multiplier, so the cloud reads as a 3D
 * orbital system rather than a flat disc.
 *
 * Electrons are **soft additive sprites** — ONE shared radial-gradient
 * `CanvasTexture` (generated at module scope, disposed at scene unmount — NOT
 * per-atom) tinted by the atom's dominant lane hue, size attenuated,
 * `depthWrite: false`, `AdditiveBlending` so the shells layer into a luminous
 * cloud (visual-design-foundations: additive layer separation on a dark
 * background).
 *
 * **Quality budget (release contract, unchanged):** the total electron count
 * is the `electronCount` prop — the quality-scaled `cloudParticles` budget —
 * distributed across `shellCount` shells by {@link distributeElectrons}
 * (the 4:6:8 per-shell ratio, capped at the total). At `low` quality the
 * budget is smaller and fewer shells are used, so the per-atom draw-call
 * budget stays flat.
 *
 * **Pause / reduced-motion / context-loss:** every shell's spin is driven by
 * the shared pause-aware {@link sceneClock} — `paused` (or a lost context, or
 * `prefers-reduced-motion`) freezes the accumulated angle **exactly** (the
 * clock holds still, so there is no drift and no jump on resume). Zero
 * per-frame allocations; only each spin group's `rotation.y` is mutated.
 *
 * `three` / R3F are confined to this `scene/**` subtree.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import { cloudShells, distributeElectrons } from "./cloudShells";
import { getSharedGlowTexture } from "./sceneResources";
import { sceneClock, sceneState } from "./sceneState";

/** Electron sprite size, in atom-relative units (tuned soft). */
const ELECTRON_SPRITE_SCALE = 0.13;

/**
 * Shared seed for clouds that do not pass one (atoms + the hub nucleus). A
 * fixed constant (never `Math.random`): the cloud is stable across atoms and
 * renders — a per-atom hue/seed is *not* part of the release props contract,
 * so this keeps the caller API unchanged while still giving every shell a
 * distinct, deterministic tilt (OR-ATOM-007).
 */
const CLOUD_SEED = 0;

/** Props for the multi-shell electron cloud (release API — unchanged). */
export interface ElectronCloudProps {
  /** Shell radius (world units) — the base radius of the innermost orbit. */
  radius: number;
  /** Spin speed in radians/second (from `spinRadiansPerSecond`; ambient for the cloud). */
  speed: number;
  /** When true the electrons do not advance (host `setPaused`). */
  paused: boolean;
  /** Electron/orbit color (lane hue; neutral fallback when lane is unknown). */
  color: string;
  /** Total electron budget across all shells (from `QUALITY_BUDGETS[quality].cloudParticles`). */
  electronCount?: number;
  /** Number of orbital shells (default 3; clamped to ≥1, ≤3). */
  shellCount?: number;
  /**
   * Optional deterministic seed for the per-shell tilt/phase fan-out (default
   * {@link CLOUD_SEED}). Same seed → same shells (OR-ATOM-007 determinism).
   */
  seed?: number;
}

/**
 * A multi-shell non-coplanar sprite orbital electron cloud around an atom.
 *
 * Pure with respect to props: `speed` / `paused` come from the pure
 * {@link AtomVisualDescriptor} encoding; the only per-frame mutation is each
 * shell's rotation (an imperative three.js update, not React state — no
 * per-frame React allocation).
 */
export function ElectronCloud({
  radius,
  speed,
  paused,
  color,
  electronCount = 12,
  shellCount = 3,
  seed = CLOUD_SEED,
}: ElectronCloudProps) {
  const spinRefs = useRef<Array<THREE.Group | null>>([]);
  const glow = useMemo(() => getSharedGlowTexture(), []);

  // Deterministic per-shell orientation + timing (non-coplanar great circles).
  const shells = useMemo(() => cloudShells(seed, shellCount), [seed, shellCount]);

  // Distribute the release's total electron budget across the shells (the
  // 4:6:8 ratio, capped at `electronCount`) so the per-atom sprite count
  // follows the quality tier, not a fixed count.
  const counts = useMemo(
    () => distributeElectrons(seed, shellCount, electronCount),
    [seed, shellCount, electronCount]
  );

  // Per-shell electron positions on a unit circle, scaled by the shell radius.
  const electronOffsets = useMemo<Array<Array<[number, number, number]>>>(
    () =>
      shells.map((shell, i) => {
        const r = radius * shell.radiusMultiplier;
        const n = counts[i] ?? 0;
        const out: Array<[number, number, number]> = [];
        for (let j = 0; j < n; j += 1) {
          const a = (n > 0 ? (j / n) * Math.PI * 2 : 0) + shell.phaseOffset;
          out.push([Math.cos(a) * r, 0, Math.sin(a) * r]);
        }
        return out;
      }),
    [shells, counts, radius]
  );

  // Per-frame: advance each shell's rotation from the shared pause-aware
  // clock. `paused` (or a lost context / reduced motion) freezes the
  // accumulated angle exactly (the clock holds still → no drift, no jump).
  useFrame(() => {
    const frozen = paused || sceneState.contextLost || sceneState.reducedMotion;
    const t = sceneClock.now;
    const base = frozen ? 0 : speed;
    spinRefs.current.forEach((group, i) => {
      if (!group) return;
      const shell = shells[i];
      if (!shell) return;
      const w = frozen ? 0 : base * shell.speedMultiplier;
      // Absolute angle from the (frozen) clock → exact freeze, no drift.
      group.rotation.y = (w * t + shell.phaseOffset) % (Math.PI * 2);
    });
  });

  // SSR / no-DOM (or WebGL2 unavailable): no sprites to render.
  if (!glow) return null;

  const spriteScale = Math.max(4, radius * ELECTRON_SPRITE_SCALE);

  return (
    <group>
      {shells.map((shell, i) => (
        <group key={i} rotation={shell.tilt}>
          <group
            ref={(g) => {
              spinRefs.current[i] = g;
            }}
          >
            {electronOffsets[i].map((p, j) => (
              <sprite key={j} position={p} scale={[spriteScale, spriteScale, 1]}>
                <spriteMaterial
                  map={glow}
                  color={color}
                  transparent
                  opacity={0.85}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </sprite>
            ))}
          </group>
        </group>
      ))}
    </group>
  );
}
