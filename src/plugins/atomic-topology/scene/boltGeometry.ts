/**
 * Procedural fractal lightning geometry (Gate A). Pure, three-free, seeded
 * midpoint displacement with a bounded branch tree. Endpoints are exactly the
 * requested endpoints (no endpoint motion); every vertex count is bounded.
 */
import { MAX_BOLT_DEPTH, MAX_BOLT_VERTICES } from "./shaderParams";

export type Vec3 = [number, number, number];

export interface BoltSegment {
  a: Vec3;
  b: Vec3;
  /** 0 = main channel, 1.. = branch generation. */
  generation: number;
}

export interface Bolt {
  segments: BoltSegment[];
  /** Short spark ticks at branch tips. */
  sparks: BoltSegment[];
}

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

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function perpendicular(d: Vec3, r: () => number): Vec3 {
  const rnd: Vec3 = [r() - 0.5, r() - 0.5, r() - 0.5];
  const dd = len(d) || 1;
  const n: Vec3 = [d[0] / dd, d[1] / dd, d[2] / dd];
  const dot = rnd[0] * n[0] + rnd[1] * n[1] + rnd[2] * n[2];
  const p: Vec3 = [rnd[0] - n[0] * dot, rnd[1] - n[1] * dot, rnd[2] - n[2] * dot];
  const pl = len(p) || 1;
  return [p[0] / pl, p[1] / pl, p[2] / pl];
}

/** Midpoint-displaced polyline from `a` to `b` with 2^levels segments. */
function displace(a: Vec3, b: Vec3, levels: number, roughness: number, r: () => number): Vec3[] {
  let pts: Vec3[] = [a, b];
  let amp = len(sub(b, a)) * roughness;
  for (let l = 0; l < levels; l += 1) {
    const next: Vec3[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p = pts[i];
      const q = pts[i + 1];
      const d = sub(q, p);
      const off = perpendicular(d, r);
      const k = (r() * 2 - 1) * amp;
      next.push([
        (p[0] + q[0]) / 2 + off[0] * k,
        (p[1] + q[1]) / 2 + off[1] * k,
        (p[2] + q[2]) / 2 + off[2] * k,
      ]);
      next.push(q);
    }
    pts = next;
    amp *= 0.5;
  }
  // Pin endpoints exactly.
  pts[0] = a;
  pts[pts.length - 1] = b;
  return pts;
}

export interface BoltOptions {
  seed: number;
  /** Subdivision levels of the main channel (bounded by MAX_BOLT_DEPTH). */
  levels?: number;
  /** Branch generations (bounded by 3). */
  branchDepth?: number;
  roughness?: number;
}

/** Build a bolt from `a` to `b`. Deterministic by seed. */
export function buildBolt(a: Vec3, b: Vec3, opts: BoltOptions): Bolt {
  const r = rng(opts.seed);
  const levels = Math.min(MAX_BOLT_DEPTH, Math.max(1, Math.floor(opts.levels ?? 5)));
  const branchDepth = Math.min(3, Math.max(0, Math.floor(opts.branchDepth ?? 2)));
  const roughness = Math.min(0.5, Math.max(0.02, opts.roughness ?? 0.22));
  const segments: BoltSegment[] = [];
  const sparks: BoltSegment[] = [];
  const budget = MAX_BOLT_VERTICES;

  const emit = (pts: Vec3[], generation: number): void => {
    for (let i = 0; i < pts.length - 1; i += 1) {
      if (segments.length >= budget) return;
      segments.push({ a: pts[i], b: pts[i + 1], generation });
    }
  };

  const grow = (pts: Vec3[], generation: number): void => {
    emit(pts, generation);
    if (generation >= branchDepth) return;
    for (let i = 2; i < pts.length - 2; i += 1) {
      if (r() > 0.2 / (generation + 1)) continue;
      if (segments.length >= budget) return;
      const p = pts[i];
      const dir = sub(pts[pts.length - 1], pts[0]);
      const dl = len(dir) || 1;
      const off = perpendicular(dir, r);
      const blen = dl * (0.18 / (generation + 1)) * (0.5 + r());
      const end: Vec3 = [
        p[0] + (dir[0] / dl) * blen * 0.6 + off[0] * blen,
        p[1] + (dir[1] / dl) * blen * 0.6 + off[1] * blen,
        p[2] + (dir[2] / dl) * blen * 0.6 + off[2] * blen,
      ];
      const sub1 = displace(p, end, Math.max(2, levels - 2 - generation), roughness, r);
      grow(sub1, generation + 1);
      const tip = sub1[sub1.length - 1];
      for (let s = 0; s < 2; s += 1) {
        const so = perpendicular(dir, r);
        const sl = blen * 0.25;
        sparks.push({
          a: tip,
          b: [tip[0] + so[0] * sl, tip[1] + so[1] * sl, tip[2] + so[2] * sl],
          generation: generation + 1,
        });
      }
    }
  };

  grow(displace(a, b, levels, roughness, r), 0);
  return { segments, sparks };
}
