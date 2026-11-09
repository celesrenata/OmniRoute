/**
 * Shared TSL nodes for the reduced-resolution hero translucency (directive 44.2, dev flag
 * `?herores=<scale>`). Module level like `sharedUniforms.ts`: only one hero atom exists at a
 * time, and the nodes are renderer-agnostic.
 *
 * The low-resolution pass writes, per low-res pixel of the hero's impostor quad:
 *   rgb = cloud emission (`acc`), a = packHeroCloud(1 - trans, 1 - transBg, nucleusHit).
 * The full-resolution impostor of the hero reads it back with a depth-aware upsample.
 */
import { texture, uniform } from "three/tsl";
import { DataTexture, FloatType, NearestFilter, RGBAFormat, Vector2 } from "three/webgpu";

/** Quantisation steps of each packed transmittance (11 bits). */
export const HERO_Q = 2047;
/** Multiplier of the second transmittance in the packed value. */
export const HERO_Q2 = 2048;
/** Nucleus-hit flag weight (above both 11-bit fields; total stays < 2^24, exact in fp32). */
export const HERO_MASK = 4194304;

/** CPU mirror of the shader packing (tested): opacities in [0, 1], hit flag. */
export function packHeroCloud(opacity: number, opacityBg: number, nucleusHit: boolean): number {
  const q = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * HERO_Q);
  return (nucleusHit ? HERO_MASK : 0) + q(opacity) * HERO_Q2 + q(opacityBg);
}

/** CPU mirror of the shader unpacking. */
export function unpackHeroCloud(packed: number): {
  opacity: number;
  opacityBg: number;
  nucleusHit: boolean;
} {
  const hit = Math.floor(packed / HERO_MASK);
  const rest = packed - hit * HERO_MASK;
  const q1 = Math.floor(rest / HERO_Q2);
  const q2 = rest - q1 * HERO_Q2;
  return { opacity: q1 / HERO_Q, opacityBg: q2 / HERO_Q, nucleusHit: hit >= 1 };
}

const placeholder = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
placeholder.minFilter = NearestFilter;
placeholder.magFilter = NearestFilter;
placeholder.generateMipmaps = false;
placeholder.needsUpdate = true;

/** Low-res cloud target (swapped to the live render target's texture by the hero pass). */
export const heroCloudTex = texture(placeholder);
/** Low-res target size in pixels. */
export const heroLowSize = uniform(new Vector2(1, 1));
/** Low-res / full-res pixel ratio per axis. */
export const heroLowScale = uniform(new Vector2(1, 1));
/** Strand width scale of the low-res strand pass (= the hero resolution scale). */
export const heroStrandScale = uniform(1);
