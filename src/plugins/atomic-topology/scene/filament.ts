/**
 * Pure filament math for the Atomic scene (OR-ATOM-008 S8.1).
 *
 * No `three`, no DOM, no `Math.random`, no clock. The scene components consume
 * these pure functions so the arc-length lookup, the bounded pulse-packet
 * scheduling, the traveling completion impulse, the seeded failure branches
 * and the ribbon strip layout are deterministic and unit-testable in Node.
 *
 * Zero per-frame allocation contract (web-quality-performance): the caller
 * builds the arc-length table ONCE per geometry (`buildArcLengthTable` —
 * memoized) and passes a preallocated `number[3]` scratch (in the scene, a
 * shared `THREE.Vector3`) into every per-frame call. Every per-frame helper
 * here is allocation-free and stateless; `branchGeometry` /
 * `buildRibbonStripData` allocate once per geometry change (memoized
 * upstream — never per frame).
 */
import { fnv1a } from "./cloudShells";
import { mulberry32 } from "./discharge";

/** A flat (x0,y0,z0, x1,y1,z1, …) list of sampled curve points. */
export type PointArray = readonly number[];

/** Something that receives a written (x, y, z) — a scratch `number[3]`. */
export interface Vec3Out {
  x: number;
  y: number;
  z: number;
}

/**
 * A cumulative arc-length table over a sampled polyline.
 *
 * `totalLength` is the sum of all segment lengths; `cumulative[i]` is the
 * length from the first point up to point `i` (`cumulative[0] === 0`,
 * `cumulative[last] === totalLength`). A valid table has ≥ 2 points.
 */
export interface ArcLengthTable {
  /** Total arc length of the polyline. */
  readonly totalLength: number;
  /** `cumulative[i]` — arc length from `points[0]` to point `i`. */
  readonly cumulative: Float32Array;
}

/**
 * Build the cumulative arc-length table from flat sampled points
 * (webgpu-threejs-tsl `arc-length progress` technique: the Bézier is sampled
 * ONCE into `CURVE_SEGMENTS` points — `EnergyLink` already does this — and
 * emission heads are placed by arc-length fraction instead of raw index, so
 * packets travel at a visually constant speed along the curve).
 *
 * Pure + allocation-free beyond the single output `Float32Array`. Fewer than
 * 2 points yields `totalLength === 0` (the lookup then writes zeros —
 * degenerate guard).
 */
export function buildArcLengthTable(points: PointArray): ArcLengthTable {
  const n = points.length / 3;
  if (n < 2) {
    return { totalLength: 0, cumulative: new Float32Array(0) };
  }
  const cumulative = new Float32Array(n);
  cumulative[0] = 0;
  for (let i = 1; i < n; i += 1) {
    const ax = points[(i - 1) * 3];
    const ay = points[(i - 1) * 3 + 1];
    const az = points[(i - 1) * 3 + 2];
    const dx = points[i * 3] - ax;
    const dy = points[i * 3 + 1] - ay;
    const dz = points[i * 3 + 2] - az;
    cumulative[i] = cumulative[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return { totalLength: cumulative[n - 1], cumulative };
}

/**
 * A `fraction → point` lookup bound to one polyline (webgpu-threejs-tsl
 * `curve.getPointAt(t)` equivalent on the memoized table). The returned
 * closure writes into `out` (a preallocated `THREE.Vector3`) via binary
 * search over the cumulative table + linear interpolation inside the hit
 * segment — zero per-frame allocation, zero per-frame state.
 */
export function createPointAtFraction(
  table: ArcLengthTable,
  points: PointArray
): (fraction: number, out: Vec3Out) => void {
  const n = table.cumulative.length;
  return (fraction, out) => {
    const total = table.totalLength;
    if (total <= 0 || n < 2) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      return;
    }
    const f = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
    const target = f * total;
    // Binary search: first index with cumulative[i] >= target.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (table.cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const segStart = table.cumulative[i - 1];
    const segLen = table.cumulative[i] - segStart;
    const w = segLen > 1e-9 ? (target - segStart) / segLen : 0;
    const ax = points[(i - 1) * 3];
    const ay = points[(i - 1) * 3 + 1];
    const az = points[(i - 1) * 3 + 2];
    out.x = ax + (points[i * 3] - ax) * w;
    out.y = ay + (points[i * 3 + 1] - ay) * w;
    out.z = az + (points[i * 3 + 2] - az) * w;
  };
}

/* ------------------------------------------------------------------ */
/* Bounded pulse-packet pool (≤ MAX_PACKET_POOL packets per link)      */
/* ------------------------------------------------------------------ */

/** The hard bound on pulse packets per link (spec: ≤ 3). */
export const MAX_PACKET_POOL = 3;
/** Tails per packet (head + 2 tail sprites — spec; fixed → no allocation). */
export const PACKET_TAILS = 2;
/**
 * A packet is dormant during the last `PACKET_GAP_FRACTION` of its hop —
 * the comet has arrived at the atom and the packet is invisible, so
 * staggered packets never pop at the wrap (bounded, no fabricated motion).
 */
export const PACKET_GAP_FRACTION = 0.32;
/** Tail spacing behind the head, in arc-length fraction (innermost first). */
export const PACKET_TAIL_STEP = 0.045;
/** Per-tail decay factor for opacity + scale (comet trail). */
export const PACKET_TAIL_DECAY = 0.55;
/** Head fade in/out band (fraction of the visible hop) — no wrap pop. */
export const PACKET_FADE_BAND = 0.15;

/**
 * Pool size from the link's visual-state evidence (no fabrication):
 * - `0` when the link has no active traffic (`active === false`) — static
 *   filament only;
 * - `0` under reduced motion (`reducedMotion === true`) — spec: pool scales
 *   down to zero, static only;
 * - otherwise `min(activeSlots, MAX_PACKET_POOL)` — multiple in-flight
 *   requests render distinct packets, bounded by the pool cap.
 */
export function packetPoolSize(
  activeSlots: number,
  active: boolean,
  reducedMotion: boolean
): number {
  if (!active || reducedMotion) return 0;
  if (activeSlots <= 0) return 0;
  return Math.min(activeSlots, MAX_PACKET_POOL);
}

/**
 * Raw (un-eased) head progress ∈ [0, 1] of the `index`-th packet in a pool
 * of `packets` at scene-time `tSeconds`.
 *
 * Stagger discipline (interaction-design: bounded, continuous motion):
 * every packet runs its OWN full hop of `periodSeconds` (spec: ~2.5 s/hop,
 * independent of pool size), offset by `index / packets` of the period so
 * staggered packets never occupy the same point of the path at the same
 * time. The last `PACKET_GAP_FRACTION` of the hop is a dormant trailing gap
 * where the packet has arrived at the atom and is hidden — combined with the
 * head fade-in/out band (`packetHeadOpacity`) this removes the wrap-around
 * pop completely (no motion without evidence).
 *
 * Wrap-safe with the pause-aware clock (`tSeconds % period`), so a
 * paused/resumed clock produces no jump (motion.ts contract).
 */
export function packetHeadProgress(
  tSeconds: number,
  periodSeconds: number,
  index: number,
  packets: number
): number {
  if (periodSeconds <= 0 || packets <= 0) return 0;
  const m = tSeconds % periodSeconds;
  const phase = ((m < 0 ? m + periodSeconds : m) / periodSeconds + index / packets) % 1;
  const visibleEnd = 1 - PACKET_GAP_FRACTION;
  if (phase >= visibleEnd) return 0; // trailing gap → dormant
  return phase / visibleEnd; // 0..1 progress across the visible path
}

/**
 * Tail offset (arc-length fraction BEHIND the head) for the `tailIndex`-th
 * tail sprite (0 = innermost). Always `0 < tailOffset` when `tailIndex ≥ 0`;
 * the caller clamps `head − tailOffset` to ≥ 0.
 */
export function packetTailStep(tailIndex: number): number {
  if (tailIndex < 0) return 0;
  return PACKET_TAIL_STEP * (tailIndex + 1);
}

/**
 * Head sprite opacity for a packet at raw progress `p` ∈ [0, 1]: fades in
 * over the first `PACKET_FADE_BAND` and out over the last one (no pop at
 * the hop wrap). Bounded to [0, 1].
 */
export function packetHeadOpacity(progress: number): number {
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  const fadeIn = Math.min(1, p / PACKET_FADE_BAND);
  const fadeOut = Math.min(1, (1 - p) / PACKET_FADE_BAND);
  return fadeIn * fadeOut;
}

/**
 * Tail sprite opacity for the `tailIndex`-th tail (monotone-decaying comet
 * trail): `headOpacity(p) × PACKET_TAIL_DECAY^(tailIndex+1)`. Bounded [0, 1].
 */
export function packetTailOpacity(progress: number, tailIndex: number): number {
  const decay = Math.pow(PACKET_TAIL_DECAY, tailIndex + 1);
  return packetHeadOpacity(progress) * decay;
}

/** Tail sprite scale multiplier for the `tailIndex`-th tail (bounded ≤ 1). */
export function packetTailScale(tailIndex: number): number {
  return 0.85 * Math.pow(PACKET_TAIL_DECAY, tailIndex + 1);
}

/* ------------------------------------------------------------------ */
/* Traveling completion impulse (the flash now moves)                  */
/* ------------------------------------------------------------------ */

/**
 * How far (arc-length fraction) the completion impulse travels over its
 * ~350 ms duration — a short "cool" impulse starting just behind the atom
 * and arriving AT the atom as it decays (S8.1: "moves toward the atom").
 */
export const COMPLETION_TRAVEL_FRACTION = 0.15;

/**
 * Arc-length fraction of the traveling completion impulse at
 * `elapsedFraction` ∈ [0, 1] through its duration, given an already-eased
 * progress `easedProgress` ∈ [0, 1] (the scene feeds `easeOutSharp`).
 *
 * - Starts just behind the atom end: `1 − COMPLETION_TRAVEL_FRACTION`.
 * - Arrives exactly at the atom (fraction 1) as the intensity decays to 0 —
 *   the flash lands on the atom and dissolves there (clean decay).
 * - Monotone non-decreasing; clamped to [1 − TRAVEL_FRACTION, 1].
 */
export function completionImpulseFraction(elapsedFraction: number, easedProgress: number): number {
  const e = elapsedFraction < 0 ? 0 : elapsedFraction > 1 ? 1 : elapsedFraction;
  const eased = easedProgress < 0 ? 0 : easedProgress > 1 ? 1 : easedProgress;
  return 1 - COMPLETION_TRAVEL_FRACTION * (1 - eased * e);
}

/* ------------------------------------------------------------------ */
/* Seeded failure branches (1–2 short kinks off mid-segments)          */
/* ------------------------------------------------------------------ */

/**
 * Deterministic branch count (1–2) for a link from a seed — the same link in
 * the same state always grows the same number of branches (FNV-1a seed, the
 * repo's established pattern; NO `Math.random`).
 */
export function branchCount(seedString: string): number {
  const h = fnv1a(seedString);
  return 1 + (h % 2);
}

/**
 * One branch in bolt-unit space (x along the hub→target axis, y/z
 * perpendicular — the SAME space as `discharge.boltPoints`): an anchor point
 * on the bolt plus two kinks that fork off the mid-segment and die out.
 */
export interface BoltBranch {
  /** Branch root — sits exactly on the bolt polyline. */
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  /** First kink — perpendicular to the bolt, bounded by `amplitude`. */
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
  /** Second kink — further out along the branch's own direction (dying spark). */
  readonly x2: number;
  readonly y2: number;
  readonly z2: number;
}

/**
 * Deterministic short branches forking OFF the mid-segments of a bolt.
 *
 * - Pure + seeded: `mulberry32(fnv1a(seedString))` (same seed → identical
 *   branches); NO `Math.random`.
 * - `boltPointsFlat` is the bolt's flat unit-space points
 *   (x,y,z triples; hub = origin, target = (1,0,0)); branch `b` anchors at
 *   `0.38 + 0.24·b` of the bolt's span (mid-segments, away from both ends
 *   so the bolt still connects hub→atom).
 * - Each branch consumes a FIXED 5-value PRNG stream, so the branch count
 *   never re-seeds the other branches' values.
 * - Bounded: kink 1's perpendicular offset ≤ `amplitude` (same units as the
 *   bolt's jitter, i.e. `BOLT_MAX_JITTER / chordLength` in the scene); the
 *   branch extends at most ~15% of the chord along the tangent.
 *
 * Allocates exactly one small output array (memoized once per mount — never
 * per frame).
 */
export function branchGeometry(
  seedString: string,
  boltPointsFlat: PointArray,
  amplitude: number
): BoltBranch[] {
  const count = branchCount(seedString);
  const n = boltPointsFlat.length / 3;
  const branches: BoltBranch[] = [];
  if (n < 2) return branches;
  const last = n - 1;
  for (let b = 0; b < count; b += 1) {
    const rand = mulberry32(fnv1a(`${seedString}:branch:${b}`));
    // Anchor on the bolt at the branch's mid-segment fraction.
    const anchorF = (0.38 + 0.24 * b) * last;
    const ai = Math.min(last - 1, Math.max(1, Math.round(anchorF)));
    const w = anchorF - ai;
    const ax =
      boltPointsFlat[(ai - 1) * 3] + (boltPointsFlat[ai * 3] - boltPointsFlat[(ai - 1) * 3]) * w;
    const ay =
      boltPointsFlat[(ai - 1) * 3 + 1] +
      (boltPointsFlat[ai * 3 + 1] - boltPointsFlat[(ai - 1) * 3 + 1]) * w;
    const az =
      boltPointsFlat[(ai - 1) * 3 + 2] +
      (boltPointsFlat[ai * 3 + 2] - boltPointsFlat[(ai - 1) * 3 + 2]) * w;
    // Tangent along the bolt at the anchor (≈ +x; (1,0,0) fallback).
    let tx = boltPointsFlat[ai * 3] - boltPointsFlat[(ai - 1) * 3];
    let ty = boltPointsFlat[ai * 3 + 1] - boltPointsFlat[(ai - 1) * 3 + 1];
    let tz = boltPointsFlat[ai * 3 + 2] - boltPointsFlat[(ai - 1) * 3 + 2];
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl > 1e-9) {
      tx /= tl;
      ty /= tl;
      tz /= tl;
    } else {
      tx = 1;
      ty = 0;
      tz = 0;
    }
    // Seeded unit direction perpendicular to the tangent, in the bolt's
    // (y, z) jitter plane (the bolt's jitter lives there too, so the branch
    // forks naturally out of the discharge).
    const dy = rand() * 2 - 1;
    const dz = rand() * 2 - 1;
    const dot = ty * dy + tz * dz;
    let oy = dy - ty * dot;
    let oz = dz - tz * dot;
    const ol = Math.sqrt(oy * oy + oz * oz);
    if (ol > 1e-6) {
      oy /= ol;
      oz /= ol;
    } else {
      oy = 1;
      oz = 0;
    }
    // Branch reach: ~9–14% of the chord, shrinking toward the target end.
    const lenFrac = 0.09 + 0.05 * (rand() * 2 - 1);
    const len = lenFrac * Math.max(0.5, 1 - Math.abs(ax));
    const amp = amplitude * 0.9;
    // Kink 1: off the bolt along the perpendicular, plus a seeded twist.
    const twist = 0.4 * (rand() * 2 - 1);
    const k1 = Math.sqrt(Math.max(0, 1 - twist * twist));
    branches.push({
      x0: ax,
      y0: ay,
      z0: az,
      x1: ax + tx * len * 0.35,
      y1: ay + ty * len * 0.35 + (oy * k1 + ty * twist) * amp,
      z1: az + tz * len * 0.35 + (oz * k1 + tz * twist) * amp,
      // Kink 2: further out along the branch's own direction (dying spark).
      x2: ax + tx * len * 0.8,
      y2: ay + ty * len * 0.8 + (oy * k1 + ty * twist) * amp * 1.9,
      z2: az + tz * len * 0.8 + (oz * k1 + tz * twist) * amp * 1.9,
    });
    // Consume the final rand so the per-branch stream is fixed-width.
    rand();
  }
  return branches;
}

/* ------------------------------------------------------------------ */
/* Ribbon strip layout (the halo quad-strip along the curve)          */
/* ------------------------------------------------------------------ */

/**
 * Build the flat vertex/UV/index data for a ribbon quad-strip woven along a
 * sampled curve: `segments` quads (positions at arc-length fractions
 * `i/segments` … `1`, each pair offset ±`halfWidth` along the curve
 * PERPENDICULAR in the screen-facing plane `planeBasis` — a single unit
 * vector in the (y,z) space of the curve, so every quad's normal points
 * toward the camera at the default framing).
 *
 * Layout (counter-clockwise when looking down the curve):
 * ```
 *   [i*2-1, i*2]     — quad i: v0 = center − halfWidth·basis
 *   [i*2+1, i*2+3]   — v1 = center + halfWidth·basis
 * ```
 * - `positions` length = `(segments + 1) * 2 * 3`.
 * - `uvs` length = `(segments + 1) * 2 * 2` — u along the curve (0..1),
 *   v = 0 (−side) / 1 (+side).
 * - `indices` length = `segments * 6` (unsigned short range — ≤ 65535
 *   vertices; the scene uses `RIBBON_SEGMENTS = 32` → 66 vertices).
 *
 * Pure; allocates exactly the three output arrays (memoized once per
 * geometry — never per frame). `basisY`/`basisZ` must be a unit vector.
 */
export function buildRibbonStripData(
  table: ArcLengthTable,
  points: PointArray,
  segments: number,
  halfWidth: number,
  basisY: number,
  basisZ: number
): { positions: number[]; uvs: number[]; indices: number[] } {
  const pointAt = createPointAtFraction(table, points);
  const scratch = { x: 0, y: 0, z: 0 };
  const segs = Math.max(1, Math.floor(segments));
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i <= segs; i += 1) {
    const f = i / segs;
    pointAt(f, scratch);
    positions.push(
      scratch.x,
      scratch.y - halfWidth * basisY,
      scratch.z - halfWidth * basisZ,
      scratch.x,
      scratch.y + halfWidth * basisY,
      scratch.z + halfWidth * basisZ
    );
    uvs.push(f, 0, f, 1);
  }
  const indices: number[] = [];
  for (let i = 0; i < segs; i += 1) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  return { positions, uvs, indices };
}
