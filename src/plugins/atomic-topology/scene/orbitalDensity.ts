/**
 * Deterministic orbital layout for the ray-marched electron cloud (Gate A).
 * Pure, three-free, seeded (same mulberry/fnv discipline as the other scene
 * models). The shader evaluates |Y_lm|^2-style lobes about the `axis` of each
 * orbital: p-lobes (cos^2 of the angle to the axis) and d-lobes
 * ((3cos^2 - 1)^2 / 4), times a radial shell profile.
 */
import { CLOUD_BOUND_RADIUS, MAX_ORBITALS, MAX_WIRES } from "./shaderParams";

export interface Orbital {
  /** Unit lobe axis. */
  axis: [number, number, number];
  /** 1 = p-type lobe, 2 = d-type lobe. */
  l: 1 | 2;
  /** Relative weight before normalization (0..1). */
  weight: number;
  /** Radial peak, as a fraction of the cloud radius (0..1). */
  radialPeak: number;
}

export interface OrbitWire {
  /** Orthonormal in-plane basis. */
  u: [number, number, number];
  v: [number, number, number];
  /** Semi-axes in world units (bounded by the cloud envelope). */
  a: number;
  b: number;
  /** Angular speed multiplier (rad/s at speedMul 1) and start phase. */
  speed: number;
  phase: number;
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

function unit(r: () => number): [number, number, number] {
  const y = 1 - 2 * r();
  const s = Math.sqrt(Math.max(0, 1 - y * y));
  const t = r() * Math.PI * 2;
  return [s * Math.cos(t), y, s * Math.sin(t)];
}

/** Maximum lobe amplitude of the shader's p/d lobe functions (both are <= 1). */
export const MAX_LOBE_AMPLITUDE = 1;

export function orbitalLayout(seed: number): Orbital[] {
  const r = rng(seed ^ 0xa5a5a5a5);
  const out: Orbital[] = [];
  for (let i = 0; i < MAX_ORBITALS; i += 1) {
    out.push({
      axis: unit(r),
      l: i === 0 ? 1 : r() < 0.5 ? 1 : 2,
      weight: 0.55 + 0.45 * r(),
      radialPeak: 0.55 + 0.4 * r(),
    });
  }
  return out;
}

export function orbitWires(seed: number, count = MAX_WIRES): OrbitWire[] {
  const n = Math.min(Math.max(0, Math.floor(count)), MAX_WIRES);
  const r = rng(seed ^ 0x5bd1e995);
  const wires: OrbitWire[] = [];
  for (let i = 0; i < n; i += 1) {
    const nrm = unit(r);
    // Any vector not parallel to nrm.
    const ref: [number, number, number] = Math.abs(nrm[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const ux = ref[1] * nrm[2] - ref[2] * nrm[1];
    const uy = ref[2] * nrm[0] - ref[0] * nrm[2];
    const uz = ref[0] * nrm[1] - ref[1] * nrm[0];
    const ul = Math.hypot(ux, uy, uz) || 1;
    const u: [number, number, number] = [ux / ul, uy / ul, uz / ul];
    const v: [number, number, number] = [
      nrm[1] * u[2] - nrm[2] * u[1],
      nrm[2] * u[0] - nrm[0] * u[2],
      nrm[0] * u[1] - nrm[1] * u[0],
    ];
    const a = CLOUD_BOUND_RADIUS * (0.62 + 0.36 * r());
    const b = a * (0.45 + 0.4 * r());
    wires.push({
      u,
      v,
      a,
      b,
      speed: (0.35 + 0.5 * r()) * (r() < 0.5 ? -1 : 1),
      phase: r() * Math.PI * 2,
    });
  }
  return wires;
}
