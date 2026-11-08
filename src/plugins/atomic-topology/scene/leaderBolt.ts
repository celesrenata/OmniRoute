/**
 * Stepped-leader / dielectric-breakdown style lightning geometry for the
 * between-atom discharges (OR-ATOM-010 directive 22). Pure, three-free, seeded
 * and bounded.
 *
 * Unlike midpoint displacement (a static zigzag), the channel is GROWN like a
 * real leader: from the start, each step picks among several candidate
 * directions with probability weighted by the "potential" toward the target
 * (the dielectric-breakdown growth rule, eta-controlled), with directional
 * persistence so the channel meanders instead of jittering. Branches grow off
 * the channel with their own steps, thinner and shorter per generation, and
 * every segment records the `birth` (0..1) at which the advancing leader tip
 * reaches it, so the shader can reveal the strike progressively. Geometry lives
 * in a unit bolt space: start (0,0,0), end (0,0,1); lateral axes use the same
 * unit as the axial one (the placement scales all three by the link length).
 */

export type Vec3 = [number, number, number];

export interface LeaderSegment {
  a: Vec3;
  b: Vec3;
  /** 0 = main channel, 1.. = branch generation. */
  generation: number;
  /** 0..1: when the leader tip reaches the END of this segment. */
  birth: number;
}

export interface LeaderBolt {
  segments: LeaderSegment[];
}

export interface LeaderOptions {
  seed: number;
  /** Channel step length in unit space. */
  step?: number;
  /** Growth-rule exponent: higher = straighter toward the target. */
  eta?: number;
  /** Direction persistence 0..1 (meander). */
  persistence?: number;
  /** Branch generations (0..3). */
  branchDepth?: number;
  /** Hard cap on emitted segments. */
  maxSegments?: number;
}

/** Bounds exported for tests and the geometry builder. */
export const LEADER_MAX_SEGMENTS = 360;
export const LEADER_MAX_STEPS = 90;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
function norm(a: Vec3): Vec3 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function randUnit(r: () => number): Vec3 {
  // Rejection-free uniform direction.
  const z = r() * 2 - 1;
  const t = r() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return [s * Math.cos(t), s * Math.sin(t), z];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function rotateAbout(v: Vec3, axis: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [
    v[0] * c + k[0] * s + axis[0] * d,
    v[1] * c + k[1] * s + axis[1] * d,
    v[2] * c + k[2] * s + axis[2] * d,
  ];
}

/**
 * Grow a leader path from `from` toward `target` (or freely, when `target` is
 * null, with `bias` as the preferred direction). Returns the visited points.
 */
function grow(
  from: Vec3,
  target: Vec3 | null,
  bias: Vec3,
  stepLen: number,
  maxSteps: number,
  eta: number,
  persistence: number,
  r: () => number
): Vec3[] {
  const pts: Vec3[] = [from];
  let p = from;
  let prev: Vec3 = norm(target ? sub(target, from) : bias);
  for (let i = 0; i < maxSteps; i += 1) {
    const toT = target ? sub(target, p) : null;
    const dist = toT ? len(toT) : Infinity;
    if (toT && dist <= stepLen * 1.15) {
      pts.push(target as Vec3);
      return pts;
    }
    const goal = toT ? norm(toT) : bias;
    // Candidate directions in a cone around the goal; the growth probability is
    // proportional to (alignment with the goal)^eta (the DBM potential term).
    let best: Vec3 = goal;
    let total = 0;
    const cands: { d: Vec3; w: number }[] = [];
    for (let c = 0; c < 6; c += 1) {
      const jitter = mul(randUnit(r), 0.95);
      const d = norm(add(add(mul(goal, 1 - persistence), mul(prev, persistence)), jitter));
      const align = Math.max(0.02, dot(d, goal) + 1.05);
      const w = Math.pow(align, eta);
      cands.push({ d, w });
      total += w;
    }
    let pick = r() * total;
    for (const c of cands) {
      pick -= c.w;
      if (pick <= 0) {
        best = c.d;
        break;
      }
      best = c.d;
    }
    const sl = stepLen * (0.55 + r() * 0.9);
    p = add(p, mul(best, sl));
    prev = best;
    pts.push(p);
  }
  if (target) pts.push(target);
  return pts;
}

/** Cumulative arc length per point. */
function arc(pts: Vec3[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i += 1) out.push(out[i - 1] + len(sub(pts[i], pts[i - 1])));
  return out;
}

/** Build one strike channel (deterministic by seed). */
export function buildLeaderBolt(opts: LeaderOptions): LeaderBolt {
  const r = rng(opts.seed);
  const stepLen = Math.min(0.12, Math.max(0.015, opts.step ?? 0.04));
  const eta = Math.min(8, Math.max(0.5, opts.eta ?? 3));
  const persistence = Math.min(0.9, Math.max(0, opts.persistence ?? 0.38));
  const depth = Math.min(3, Math.max(0, Math.floor(opts.branchDepth ?? 3)));
  const cap = Math.min(LEADER_MAX_SEGMENTS, Math.max(8, Math.floor(opts.maxSegments ?? 300)));
  const start: Vec3 = [0, 0, 0];
  const end: Vec3 = [0, 0, 1];
  const segments: LeaderSegment[] = [];

  const main = grow(start, end, [0, 0, 1], stepLen, LEADER_MAX_STEPS, eta, persistence, r);
  main[0] = start;
  main[main.length - 1] = end;
  const mainArc = arc(main);
  const mainLen = mainArc[mainArc.length - 1] || 1;
  // Leader tip reaches the end of the channel at birth = 0.92 (the return
  // stroke then lights the whole path at once).
  const MAIN_SPAN = 0.92;
  const mainBirth = (i: number): number => (mainArc[i] / mainLen) * MAIN_SPAN;
  for (let i = 1; i < main.length && segments.length < cap; i += 1) {
    segments.push({ a: main[i - 1], b: main[i], generation: 0, birth: mainBirth(i) });
  }

  const sprout = (pts: Vec3[], births: number[], gen: number, scale: number): void => {
    if (gen >= depth) return;
    const rate = (gen === 0 ? 0.2 : 0.11) / (gen + 1);
    for (let i = 2; i < pts.length - 2; i += 1) {
      if (segments.length >= cap) return;
      if (r() > rate) continue;
      const p = pts[i];
      const tangent = norm(sub(pts[Math.min(pts.length - 1, i + 1)], pts[i - 1]));
      // Branch leaves at 25..65 degrees from the channel, around a random axis.
      const side = norm(cross(tangent, randUnit(r)));
      const ang = ((25 + r() * 40) * Math.PI) / 180;
      const dir = norm(rotateAbout(tangent, side, ang));
      const steps = Math.max(2, Math.round((gen === 0 ? 5 + r() * 9 : 2 + r() * 4) * scale));
      const bp = grow(p, null, dir, stepLen * (0.8 - gen * 0.15), steps, 1.2, 0.5, r);
      const bArc = arc(bp);
      // The branch grows after the parent tip passes, over a shorter span.
      const t0 = births[i];
      const span = (1 - t0) * (0.55 - gen * 0.1);
      const bBirths = bp.map((_, k) =>
        Math.min(1, t0 + (bArc[k] / (bArc[bArc.length - 1] || 1)) * span)
      );
      for (let k = 1; k < bp.length && segments.length < cap; k += 1) {
        segments.push({ a: bp[k - 1], b: bp[k], generation: gen + 1, birth: bBirths[k] });
      }
      sprout(bp, bBirths, gen + 1, scale * 0.6);
    }
  };
  sprout(
    main,
    main.map((_, i) => mainBirth(i)),
    0,
    1
  );
  return { segments };
}
