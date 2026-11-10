/**
 * Deterministic, three-free bake of the plasma strand field (Gate A r6).
 *
 * The electron-cloud filaments are real geometry: thousands of hairline
 * ribbons bursting radially from the nucleus, grouped into petal bundles with
 * dark voids between them (idea5). Everything per strand (direction, length,
 * curl, flicker phase, activation rank) is baked ONCE here into vertex
 * attributes; the GPU animates and sizes them (screen-space width) from a
 * handful of uniforms, so there is no CPU per-strand work per frame.
 *
 * Directions live in a canonical frame; each atom rotates the whole field by
 * its own seeded orientation, so one shared geometry serves every atom.
 */

/** Strand count per atom (excited state shows all; idle shows a fraction). */
export const STRAND_COUNT = 2600;
/** Segments per strand (segments + 1 cross-sections, 2 vertices each). */
export const STRAND_SEGMENTS = 20;
/** Petal bundles (the reference flower reads as ~12-14 petals). */
export const STRAND_PETALS = 13;
/** Fraction of strands that ignore the petals (sparse fill inside the voids). */
export const STRAND_LOOSE_FRACTION = 0.1;
/** Rim sparkle count per atom (fine particulate fringe + pink/orange motes). */
export const SPARKLE_COUNT = 11000;

/** Seeded mulberry32 stream (deterministic; no Math.random). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type V3 = [number, number, number];

function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Uniform random unit vector. */
function randomDir(rnd: () => number): V3 {
  const z = rnd() * 2 - 1;
  const phi = rnd() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(phi), z, r * Math.sin(phi)];
}

/** Petal bundle axes: a Fibonacci sphere (even coverage, no clumping). */
export function petalAxes(count = STRAND_PETALS): V3[] {
  const out: V3[] = [];
  for (let b = 0; b < count; b += 1) {
    const z = 1 - (2 * (b + 0.5)) / count;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = b * 2.399963229728653;
    out.push([r * Math.cos(phi), z, r * Math.sin(phi)]);
  }
  return out;
}

export interface StrandBake {
  /** Canonical strand direction (vec3 per vertex, stored as `position`). */
  dir: Float32Array;
  /** x length (0..1 of cloud radius), y curl, z wobble frequency, w flicker phase. */
  shape: Float32Array;
  /** x along-strand t (0..1), y side (-1 | 1), z activation rank (0..1), w width (px). */
  param: Float32Array;
  index: Uint32Array;
  vertexCount: number;
}

/** Bake the shared strand ribbon geometry (pure, deterministic). */
export function bakeStrands(
  count = STRAND_COUNT,
  segments = STRAND_SEGMENTS,
  seed = 0x5eed01
): StrandBake {
  const rnd = mulberry32(seed);
  const axes = petalAxes();
  const perStrand = (segments + 1) * 2;
  const vertexCount = count * perStrand;
  const dir = new Float32Array(vertexCount * 3);
  const shape = new Float32Array(vertexCount * 4);
  const param = new Float32Array(vertexCount * 4);
  const index = new Uint32Array(count * segments * 6);
  let vi = 0;
  let ii = 0;
  for (let s = 0; s < count; s += 1) {
    const loose = rnd() < STRAND_LOOSE_FRACTION;
    const axis = axes[Math.floor(rnd() * axes.length) % axes.length];
    const jitter = randomDir(rnd);
    // Bundle spread varies per strand: a dense core of each petal + a fringe.
    const spread = 0.1 + 0.3 * rnd() * rnd();
    const d = loose
      ? randomDir(rnd)
      : normalize([
          axis[0] + jitter[0] * spread,
          axis[1] + jitter[1] * spread,
          axis[2] + jitter[2] * spread,
        ]);
    const len = loose ? 0.4 + 0.3 * rnd() : 0.8 + 0.2 * Math.sqrt(rnd());
    const curl = (rnd() - 0.5) * 1.1;
    const wobble = 2.5 + 5 * rnd();
    const flick = rnd() * 6.2831853;
    const rank = rnd();
    // Hairline: 0.5..1.5 px, a few slightly bolder "lead" strands.
    const width = 0.5 + rnd() * (rnd() < 0.08 ? 1.4 : 1.0);
    const base = vi;
    for (let j = 0; j <= segments; j += 1) {
      const t = j / segments;
      for (let side = -1; side <= 1; side += 2) {
        dir.set(d, vi * 3);
        shape.set([len, curl, wobble, flick], vi * 4);
        param.set([t, side, rank, width], vi * 4);
        vi += 1;
      }
    }
    for (let j = 0; j < segments; j += 1) {
      const a = base + j * 2;
      index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], ii);
      ii += 6;
    }
  }
  return { dir, shape, param, index, vertexCount };
}

export interface SparkleBake {
  /** Canonical direction (vec3 per vertex, stored as `position`). */
  dir: Float32Array;
  /** x radius (0..1 of cloud), y size px, z twinkle phase, w kind (0 rim, 1 mote). */
  shape: Float32Array;
  /** xy quad corner (-1..1), z activation rank. */
  corner: Float32Array;
  index: Uint32Array;
  vertexCount: number;
}

/** Bake the sparkle quads: a fine cyan fringe at the petal tips + inner motes. */
export function bakeSparkles(count = SPARKLE_COUNT, seed = 0x5a4c1e): SparkleBake {
  const rnd = mulberry32(seed);
  const axes = petalAxes();
  const vertexCount = count * 4;
  const dir = new Float32Array(vertexCount * 3);
  const shape = new Float32Array(vertexCount * 4);
  const corner = new Float32Array(vertexCount * 3);
  const index = new Uint32Array(count * 6);
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let s = 0; s < count; s += 1) {
    const mote = rnd() < 0.1;
    const axis = axes[Math.floor(rnd() * axes.length) % axes.length];
    const j = randomDir(rnd);
    // Rim particles hug the petal tips in a closed band (petal-biased, not axis-locked).
    const spread = mote ? 0.6 : 0.5 + 0.5 * rnd();
    const d = normalize([
      axis[0] + j[0] * spread,
      axis[1] + j[1] * spread,
      axis[2] + j[2] * spread,
    ]);
    const radius = mote ? 0.2 + 0.65 * rnd() : 0.93 + 0.09 * rnd() * rnd() + 0.03 * rnd();
    const size = mote ? 2.6 + 2.4 * rnd() : 1.0 + 1.8 * rnd() * rnd();
    const tw = rnd() * 6.2831853;
    const rank = rnd();
    for (let k = 0; k < 4; k += 1) {
      const v = s * 4 + k;
      dir.set(d, v * 3);
      shape.set([radius, size, tw, mote ? 1 : 0], v * 4);
      corner.set([corners[k][0], corners[k][1], rank], v * 3);
    }
    const a = s * 4;
    index.set([a, a + 1, a + 2, a, a + 2, a + 3], s * 6);
  }
  return { dir, shape, corner, index, vertexCount };
}

/** Fraction of strands lit for an energy state (idle = fewer, never zero). */
export function activeStrandFraction(excitation: number, brightness: number): number {
  const e = Number.isFinite(excitation) ? Math.min(1, Math.max(0, excitation)) : 0;
  const b = Number.isFinite(brightness) ? Math.min(1, Math.max(0, brightness)) : 0;
  return Math.min(1, 0.3 + 0.55 * e + 0.15 * b);
}
