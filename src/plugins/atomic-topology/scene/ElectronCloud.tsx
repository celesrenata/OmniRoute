"use client";

/**
 * Electron cloud — layered, truly luminous orbital shells (OR-ATOM-007).
 *
 * Replaces the single coplanar ring of small spheres with **2–3 non-coplanar
 * orbital shells** per atom (webgpu-threejs-tsl particle pattern ported into
 * the WebGL2/R3F idiom: the *single-buffer, deterministic particle* pattern
 * from `examples/particle-system.js`). Each shell is a tilted great-circle
 * (tilt/polar angles deterministic from an FNV-1a seed — see
 * `cloudShells.ts`) with a slightly different radius
 * (1.0 / 1.22 / 1.45 × the base radius) and electron count (4 / 6 / 8 —
 * the spec's 5/7/9 example capped to keep the total sprite budget ≤ ~700).
 *
 * Electrons are **soft additive sprites** (ONE shared radial-gradient
 * `CanvasTexture`, generated at module scope on the client and disposed at
 * scene unmount — NOT per-atom) tinted by the atom's lane hue, size
 * attenuated, `depthWrite: false`, `AdditiveBlending` so shells layer into a
 * luminous cloud (visual-design-foundations: additive layer separation on a
 * dark background).
 *
 * Shell spin: base = the per-atom `spin.value` (rad/s) × a per-shell
 * multiplier (1.0 / 0.82 / 0.63) + a constant per-shell phase offset from the
 * seed. `paused` freezes the accumulated angle exactly (no drift — the shared
 * pause-aware scene clock holds still). Zero allocations per frame: only the
 * spin group's `rotation.y` is mutated.
 *
 * OR-ATOM-008 S8.2 adds a **volumetric haze layer** around the shells: 1–3
 * large, very soft, translucent additive billboards per atom (ONE shared
 * procedurally-generated low-contrast noise texture — module-local to this
 * file, lazily created on the client, disposed through
 * `disposeHazeTexture()` with the same lifetime contract as the glow
 * texture). Each billboard is centered on the atom, sized ~2.6–3.4× the base
 * cloud radius, tinted by the same lane hue the electrons use (unknown lane →
 * neutral), counter-rotating slowly (`sprite.material.rotation`) with a very
 * slow scale breathing (±3–5 %) — all driven by the same pause-aware clock,
 * so pause/reduced-motion freezes the haze exactly like the electrons. The
 * haze renders at a lower `renderOrder` than the electron sprites, so the
 * crisp moving points stay legible on top of the soft luminous volume.
 * Sprite budget: 38 atoms × 3 haze sprites (high tier) = 114, keeping the
 * scene under the ~700 total-sprite budget.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import { cloudShells, fnv1a } from "./cloudShells";
import {
  HAZE_RENDER_ORDER,
  HAZE_TIER,
  HAZE_TIER_TABLE,
  hazeBreathScale,
  hazeSpinRadians,
  hazeSprites,
} from "./cloudHaze";
import { getSharedGlowTexture } from "./sceneResources";
import { sceneClock, sceneState } from "./sceneState";

/** Electron sprite size, in atom-relative units (tuned soft). */
const ELECTRON_SPRITE_SCALE = 0.13;

/** The haze noise texture's edge size (px) and blob-grid resolution. */
const HAZE_NOISE_SIZE = 64;
const HAZE_BLOB_GRID = 8;

/** The shared noise-haze texture (created lazily on the client, module-local). */
let hazeTexture: THREE.CanvasTexture | null = null;
let hazeTextureCreated = false;

/**
 * Generate the soft orbital-haze canvas: low-contrast seeded blob noise (a
 * FNV-1a-seeded mulberry32 PRNG — NO `Math.random`) bilinearly smoothed,
 * multiplied by a radial falloff. Deterministic: the same module always
 * produces the same texture. Client-only — returns `null` under SSR (no
 * `document`) so the cloud simply renders no haze.
 */
function createHazeNoiseCanvas(): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = HAZE_NOISE_SIZE;
  canvas.height = HAZE_NOISE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // Seeded mulberry32 (FNV-1a of a stable tag) — deterministic, no Math.random.
  let state = fnv1a("atomic-haze-v1");
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let z = Math.imul(state ^ (state >>> 15), 1 | state);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
  const grid: number[] = [];
  for (let i = 0; i < HAZE_BLOB_GRID * HAZE_BLOB_GRID; i += 1) grid.push(next());
  const image = ctx.createImageData(HAZE_NOISE_SIZE, HAZE_NOISE_SIZE);
  const half = HAZE_NOISE_SIZE / 2;
  for (let y = 0; y < HAZE_NOISE_SIZE; y += 1) {
    for (let x = 0; x < HAZE_NOISE_SIZE; x += 1) {
      // Bilinear sample of the blob grid → soft, low-contrast blob variation.
      const gx = (x / HAZE_NOISE_SIZE) * HAZE_BLOB_GRID;
      const gy = (y / HAZE_NOISE_SIZE) * HAZE_BLOB_GRID;
      const x0 = Math.floor(gx) % HAZE_BLOB_GRID;
      const y0 = Math.floor(gy) % HAZE_BLOB_GRID;
      const x1 = (x0 + 1) % HAZE_BLOB_GRID;
      const y1 = (y0 + 1) % HAZE_BLOB_GRID;
      const fx = gx - Math.floor(gx);
      const fy = gy - Math.floor(gy);
      const top = grid[y0 * HAZE_BLOB_GRID + x0] * (1 - fx) + grid[y0 * HAZE_BLOB_GRID + x1] * fx;
      const bot = grid[y1 * HAZE_BLOB_GRID + x0] * (1 - fx) + grid[y1 * HAZE_BLOB_GRID + x1] * fx;
      const blob = top * (1 - fy) + bot * fy;
      // Radial falloff: (1 − d²)² — a soft gaussian-ish edge, like the glow.
      const d = Math.sqrt((x - half) ** 2 + (y - half) ** 2) / half;
      const falloff = d >= 1 ? 0 : (1 - d * d) * (1 - d * d);
      // Low-contrast: the blob only gently modulates the falloff (55–100 %).
      const alpha = Math.round(255 * falloff * (0.55 + 0.45 * blob));
      const o = (y * HAZE_NOISE_SIZE + x) * 4;
      image.data[o] = 255;
      image.data[o + 1] = 255;
      image.data[o + 2] = 255;
      image.data[o + 3] = alpha;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Get (and lazily create) the shared haze texture — module-local so the
 * shared `sceneResources.ts` stays untouched (OR-ATOM-008 scope). Same
 * lifetime contract as `getSharedGlowTexture()`: ONE texture for the whole
 * scene, created at most once per client module load.
 */
function getHazeTexture(): THREE.CanvasTexture | null {
  if (hazeTextureCreated) return hazeTexture;
  hazeTextureCreated = true;
  const canvas = createHazeNoiseCanvas();
  if (!canvas) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  hazeTexture = texture;
  return texture;
}

/**
 * Dispose the shared haze texture exactly once (scene unmount / context
 * rebuild). Idempotent — safe to call multiple times. Same contract as
 * `disposeSharedGlowTexture()` in `sceneResources.ts`.
 */
export function disposeHazeTexture(): void {
  if (hazeTexture) {
    hazeTexture.dispose();
    hazeTexture = null;
  }
  hazeTextureCreated = false;
}

/** Props for a layered electron cloud. */
export interface ElectronCloudProps {
  /** Base (innermost shell) orbit radius in world units. */
  radius: number;
  /** Spin speed in radians/second (from `spin.value`). */
  speed: number;
  /** When true the shells hold still (host `setPaused` contract). */
  paused: boolean;
  /** Electron tint (usually the atom's lane hue). */
  color: string;
  /** Deterministic seed (fnv1a of the atom id — same 32-bit FNV-1a). */
  seed: number;
  /**
   * Optional fixed electron count (single shell) for non-atom clouds (the
   * hub nucleus uses one ring). Absent → 3 seeded shells (4/6/8 electrons).
   */
  electronCount?: number;
  /** Optional fixed tilt for a single-shell cloud (radians, x-axis). */
  tilt?: number;
  /**
   * When true the cloud ignores the scene clock entirely (a fixed, static
   * speed multiplier) — used by the hub nucleus, whose spin is not driven by
   * atom telemetry.
   */
  staticSpeed?: number;
}

/**
 * A spinning, layered cloud of soft additive electrons around an atom.
 *
 * Pure with respect to props: `speed` / `paused` come from the pure
 * {@link AtomVisualDescriptor} encoding; the only per-frame mutation is each
 * shell's rotation (an imperative three.js update, not React state).
 */
export function ElectronCloud({
  radius,
  speed,
  paused,
  color,
  seed,
  electronCount,
  tilt,
  staticSpeed,
}: ElectronCloudProps) {
  const spinRefs = useRef<Array<THREE.Group | null>>([]);
  const glow = useMemo(() => getSharedGlowTexture(), []);

  // Haze (OR-ATOM-008 S8.2): deterministic per-sprite params + base scales.
  const haze = useMemo(() => getHazeTexture(), []);
  const hazeParams = useMemo(() => hazeSprites(seed, HAZE_TIER), [seed]);
  const hazeBaseScales = useMemo(
    () => hazeParams.map((p) => radius * p.scaleMultiplier),
    [hazeParams, radius]
  );
  const hazeRefs = useRef<Array<THREE.Sprite | null>>([]);

  // Deterministic shell parameters (non-coplanar great circles).
  const shells = useMemo(() => cloudShells(seed), [seed]);

  // Per-shell electron positions on a unit circle, scaled by the shell radius.
  const electronOffsets = useMemo<Array<Array<[number, number, number]>>>(
    () =>
      shells.map((shell) => {
        const r = radius * shell.radiusMultiplier;
        const n = shell.electronCount;
        const out: Array<[number, number, number]> = [];
        for (let i = 0; i < n; i += 1) {
          const a = (i / n) * Math.PI * 2 + shell.phaseOffset;
          out.push([Math.cos(a) * r, 0, Math.sin(a) * r]);
        }
        return out;
      }),
    [shells, radius]
  );

  // A single fixed-shell variant (hub nucleus): one ring of `electronCount`
  // sprites with a fixed tilt and speed (no seed-driven fan-out).
  const singleShell = electronCount != null;

  // Per-frame: advance each shell's rotation from the shared pause-aware clock.
  // `paused` freezes the accumulated angle exactly (the clock holds still, so
  // there is no drift and no jump on resume).
  useFrame(() => {
    const frozen = paused || sceneState.contextLost || sceneState.reducedMotion;
    const t = sceneClock.now;
    const base = frozen || staticSpeed != null ? 0 : speed;
    spinRefs.current.forEach((group, i) => {
      if (!group) return;
      if (singleShell) {
        if (frozen) return;
        const s = staticSpeed ?? speed;
        group.rotation.y = (s * t) % (Math.PI * 2);
        return;
      }
      const shell = shells[i];
      if (!shell) return;
      const w = frozen ? 0 : base * shell.speedMultiplier;
      // Absolute angle from the (frozen) clock → exact freeze, no drift.
      group.rotation.y = (w * t + shell.phaseOffset) % (Math.PI * 2);
    });
    // Haze: absolute spin/breath from the same pause-aware clock. A frozen
    // clock (paused / context-lost / reduced-motion) skips the mutation, so
    // the haze holds the last frame exactly; resume is contiguous.
    if (!frozen) {
      hazeRefs.current.forEach((sprite, i) => {
        const p = hazeParams[i];
        if (!sprite || !p) return;
        sprite.material.rotation = hazeSpinRadians(p, t);
        const s = hazeBaseScales[i] * hazeBreathScale(p, t, HAZE_TIER_TABLE[HAZE_TIER]);
        sprite.scale.x = s;
        sprite.scale.y = s;
      });
    }
  });

  const spriteScale = Math.max(4, radius * ELECTRON_SPRITE_SCALE);
  const singleTilt = tilt ?? 0.35;

  if (!glow) return null; // SSR / no-DOM: no sprites.

  return (
    <group>
      {!singleShell &&
        shells.map((shell, i) => (
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
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                  />
                </sprite>
              ))}
            </group>
          </group>
        ))}
      {singleShell && (
        <group rotation={[singleTilt, 0, 0]}>
          <group
            ref={(g) => {
              spinRefs.current[0] = g;
            }}
          >
            {Array.from({ length: Math.max(1, Math.floor(electronCount ?? 5)) }, (_, i) => {
              const a = (i / Math.max(1, Math.floor(electronCount ?? 5))) * Math.PI * 2;
              return (
                <sprite
                  key={i}
                  position={[Math.cos(a) * radius, 0, Math.sin(a) * radius]}
                  scale={[spriteScale, spriteScale, 1]}
                >
                  <spriteMaterial
                    map={glow}
                    color={color}
                    transparent
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                  />
                </sprite>
              );
            })}
          </group>
        </group>
      )}
      {/*
       * Volumetric haze (OR-ATOM-008 S8.2): 1–3 large, very soft, translucent
       * billboards centered on the atom — a luminous volume *around* the
       * crisp electron points (lower renderOrder → electrons composite on
       * top). Same lane-hue tint as the electrons; slow counter-spin +
       * ±3–5 % scale breathing, frozen with the shared clock.
       */}
      {haze &&
        hazeParams.map((p, i) => (
          <sprite
            key={`haze-${i}`}
            scale={[hazeBaseScales[i], hazeBaseScales[i], 1]}
            renderOrder={HAZE_RENDER_ORDER}
            ref={(s) => {
              hazeRefs.current[i] = s;
            }}
          >
            <spriteMaterial
              map={haze}
              color={color}
              transparent
              opacity={HAZE_TIER_TABLE[HAZE_TIER].spriteOpacity * p.opacityScale}
              rotation={p.spinPhase}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </sprite>
        ))}
    </group>
  );
}
