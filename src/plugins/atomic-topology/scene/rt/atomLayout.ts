/**
 * Per-atom GPU data layout for the batched ray-traced atoms (Gate B, C7a).
 * Pure and three-free so the packing contract is unit-testable.
 *
 * Every atom owns ONE ROW that all batched draws (impostor, floor reflection,
 * strands, sparkles, wires, bolts, flares) read by row. One upload per buffer
 * per frame replaces the ~28 per-object uniform uploads per atom that caused
 * the writeBuffer stalls.
 *
 *   uniform buffers (vec4 entries, rewritten every frame):
 *     fields            FIELD_COUNT per atom ({@link FIELD})
 *     dynamic           DYN_COLS per atom: electron angles per wire (x, y;
 *                       < -50 disables), then bolt slots (3 each: A +
 *                       intensity, B + variant, colour)
 *   static texture (written when an atom is (re)configured):
 *     wire definitions (4 texels per wire)
 *
 * (Nucleon centres/tints stay in each atom's own impostor uniforms; see
 * `impostorSlot.ts`.)
 */
export const WIRES_PER_ATOM = 11;
export const BOLT_SLOTS_PER_ATOM = 8;
export const BOLT_TEXELS = 3;
export const BOLT_VARIANT_COUNT = 4;

/** Field indices (each a vec4) inside an atom's slice of the fields uniform buffer. */
export const FIELD = {
  CENTER_CLOUD_R: 0, // center.xyz, cloudRadius
  RIGHT_QUADHALF: 1, // camRight.xyz, quadHalf
  UP_GLASS_R: 2, // camUp.xyz, glassRadius
  ENERGY_PHASE: 3, // excitation, saturation, brightness, phase
  WEIGHTS_MEDIUM: 4, // orbital weights xyz, mediumK
  FAR_CROWD_REACH_STEPS: 5, // far, crowd, reach, steps
  LOBE_NCOUNT: 6, // lobe kinds xyz, nucleon count
  PEAKS_SWIRL: 7, // radial peaks xyz, swirl
  ORIENT0_ROOT_R: 8, // orientation row 0 xyz, rootR (fraction of cloud)
  ORIENT1_ACTIVE: 9, // orientation row 1 xyz, active strand fraction
  ORIENT2_PX: 10, // orientation row 2 xyz, pxScale
  HUE0_LIFE: 11, // hue 0 xyz, lifeOn
  HUE1_OCC: 12, // hue 1 xyz, occluder radius (nucleus extent * 0.92)
  HUE2_WIRESCALE: 13, // hue 2 xyz, wire scale
  INNER_WIRETIME: 14, // inner xyz, wire time
  RIM_WIREENERGY: 15, // rim xyz, wire energy (brightness * crowd)
  CORE_STRANDCROWD: 16, // core colour xyz, strand gain (crowd^1.4 / lod)
  ROOT_STREAK: 17, // strand root colour xyz, streak intensity
  AXIS0_GLOW: 18, // orbital axis 0 xyz, glow intensity
  AXIS1_RING: 19, // orbital axis 1 xyz, ring intensity
  AXIS2_FLAGS: 20, // orbital axis 2 xyz, flags (hub = 1)
  WIRE_TINT: 21, // reserved
  SPARE0: 22, // strand inner colour xyz
  SPARE1: 23, // x sparkle gain (crowd^2.8), y sparkle lit fraction (no LOD), z failure alert
} as const;

export const FIELD_COUNT = 24;
/** Dynamic per-wire / per-bolt buffer (vec4 entries per atom). */
export const ELECTRON_BASE = 0;
export const BOLT_BASE = ELECTRON_BASE + WIRES_PER_ATOM; // 11
export const DYN_COLS = BOLT_BASE + BOLT_SLOTS_PER_ATOM * BOLT_TEXELS; // 35

/** Static wire-definition texture (written on configure only). */
export const WIRE_DEF_BASE = 0;
export const WIRE_DEF_TEXELS = 4;
export const STATIC_COLS = WIRE_DEF_BASE + WIRES_PER_ATOM * WIRE_DEF_TEXELS; // 44

/** Layout invariants (asserted by tests so a constant edit cannot silently overlap). */
export function layoutFits(): boolean {
  return (
    ELECTRON_BASE + WIRES_PER_ATOM <= BOLT_BASE &&
    BOLT_BASE + BOLT_SLOTS_PER_ATOM * BOLT_TEXELS <= DYN_COLS &&
    WIRE_DEF_BASE + WIRES_PER_ATOM * WIRE_DEF_TEXELS <= STATIC_COLS
  );
}

/** Float offset of texel `col` in row `row` of a texture with `cols` columns. */
export function texelOffset(row: number, col: number, cols: number): number {
  return (row * cols + col) * 4;
}

/** Back-to-front order (farthest first) of atom rows by squared camera distance; stable. */
export function sortRowsBackToFront(
  rows: readonly number[],
  distSq: (row: number) => number,
  out: number[]
): number[] {
  out.length = 0;
  for (const r of rows) out.push(r);
  out.sort((a, b) => {
    const d = distSq(b) - distSq(a);
    return d !== 0 ? d : a - b;
  });
  return out;
}

/** Strand/sparkle draw buckets: fractions of the (rank-sorted) strand index buffer. */
export const STRAND_BUCKETS = [0.125, 0.25, 0.5, 1] as const;
/** Smallest projected-size LOD (fraction of strands drawn when an atom is tiny on screen). */
export const STRAND_LOD_MIN = 0.125;

/**
 * Projected-size strand LOD: the fraction of strands drawn for an atom whose
 * on-screen size relative to the approved single-atom view is `crowd` (1 at
 * the default and close views, so those frames are unchanged; full count down
 * to crowd 0.5). Fewer strands
 * are drawn as the atom shrinks and each is brightened by 1/lod, so the summed
 * light per pixel (the overdraw the crowd curve already normalises) is kept.
 */
export function strandLod(crowd: number): number {
  const c = Number.isFinite(crowd) ? crowd : 1;
  // Full strand count down to half the approved projected size (pair/close
  // framings keep their closed rim), then proportional to projected size.
  return Math.min(1, Math.max(STRAND_LOD_MIN, c * STRAND_LOD_KNEE));
}
/** Projected-size multiplier at which the LOD starts (crowd <= 1 / knee). */
export const STRAND_LOD_KNEE = 2;

/**
 * Bucket index for a required strand fraction `q` (lit fraction x LOD). Picks
 * the smallest bucket that still contains every lit strand; `prev` adds a 10 %
 * hysteresis band so an atom near a boundary does not flip buckets each frame.
 */
export function strandBucket(q: number, prev = -1): number {
  const need = Number.isFinite(q) ? Math.min(1, Math.max(0, q)) : 1;
  let b = STRAND_BUCKETS.findIndex((f) => f >= need);
  if (b < 0) b = STRAND_BUCKETS.length - 1;
  if (prev > b && prev < STRAND_BUCKETS.length && need > STRAND_BUCKETS[b] * 0.9) return prev;
  return b;
}

/** Rank-sorted strand order: indices of `ranks` ascending (stable, deterministic). */
export function rankOrder(ranks: ArrayLike<number>): number[] {
  const idx = Array.from({ length: ranks.length }, (_, i) => i);
  idx.sort((a, b) => ranks[a] - ranks[b] || a - b);
  return idx;
}
