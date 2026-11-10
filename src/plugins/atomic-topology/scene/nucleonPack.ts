/**
 * Packs the production {@link buildNucleusCluster} output into the flat
 * arrays the ray-traced nucleus shader consumes (Gate A). Pure, three-free,
 * deterministic.
 *
 * The production builder supplies identities (seeded orientation, proton /
 * neutron roles, model-group sectors and tints). The packer adds an inner
 * shell from a second seeded cluster and runs a deterministic relaxation so
 * the nucleons form a tight, individually distinguishable ball (touching,
 * not interpenetrating), as in the reference atom.
 */
import { mixHex, buildNucleusCluster, type NucleusParticle } from "./nucleusCluster";
import { modelColor } from "../visualEncoding";
import { ATOM_WORLD_RADIUS, MAX_NUCLEONS } from "./shaderParams";

/** Ray-traced nucleon counts (plan: ring 24 outer, hub 40 outer). */
export const RT_RING_OUTER_COUNT = 24;
export const RT_HUB_OUTER_COUNT = 40;
/** Inner-shell fraction of the outer count. */
const INNER_FRACTION = 0.4;
/** Target nucleus ball radius, in atom radii. */
const RING_EXTENT = 0.82;
const HUB_EXTENT = 1.0;
const PACK_DENSITY = 0.6;
const RELAX_ITERATIONS = 90;

export interface PackedNucleus {
  count: number;
  /** vec4 per nucleon: x, y, z (world units about the atom centre), radius. */
  centers: Float32Array;
  /** vec4 per nucleon: linear r, g, b, isProton (1/0). */
  tints: Float32Array;
  /** Bounding radius of the nucleon ball (world units). */
  extent: number;
  spinAxis: [number, number, number];
  modelGroups: string[];
}

export interface NucleonPackInput {
  seed: number;
  hub: boolean;
  observedModelIds?: readonly string[];
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** `#RRGGBB` → linear-sRGB triple. */
export function hexToLinear(hex: string): [number, number, number] {
  const h = hex.length === 7 ? hex : "#808080";
  return [
    srgbToLinear(parseInt(h.slice(1, 3), 16) / 255),
    srgbToLinear(parseInt(h.slice(3, 5), 16) / 255),
    srgbToLinear(parseInt(h.slice(5, 7), 16) / 255),
  ];
}

/** Pack a deterministic nucleus ball for one atom. */
export function packNucleus(input: NucleonPackInput): PackedNucleus {
  const outerCount = input.hub ? RT_HUB_OUTER_COUNT : RT_RING_OUTER_COUNT;
  const innerCount = Math.round(outerCount * INNER_FRACTION);
  const outer = buildNucleusCluster({
    seed: input.seed,
    particleCount: outerCount,
    observedModelIds: input.observedModelIds,
  });
  const inner = buildNucleusCluster({
    seed: (input.seed ^ 0x9e3779b9) >>> 0,
    particleCount: innerCount,
    observedModelIds: input.observedModelIds,
  });

  const particles: { p: NucleusParticle; pos: [number, number, number] }[] = [];
  for (const p of outer.particles) {
    particles.push({
      p,
      pos: [
        p.position[0] * ATOM_WORLD_RADIUS,
        p.position[1] * ATOM_WORLD_RADIUS,
        p.position[2] * ATOM_WORLD_RADIUS,
      ],
    });
  }
  for (const p of inner.particles) {
    // Inner shell sits at ~half the outer radius.
    particles.push({
      p,
      pos: [
        p.position[0] * ATOM_WORLD_RADIUS * 0.5,
        p.position[1] * ATOM_WORLD_RADIUS * 0.5,
        p.position[2] * ATOM_WORLD_RADIUS * 0.5,
      ],
    });
  }
  const count = Math.min(particles.length, MAX_NUCLEONS);
  const used = particles.slice(0, count);

  const extentTarget = ATOM_WORLD_RADIUS * (input.hub ? HUB_EXTENT : RING_EXTENT);
  const baseR = extentTarget * Math.cbrt(PACK_DENSITY / count);
  const radii = used.map((u) => baseR * u.p.scaleMul);
  const pos = used.map((u) => [...u.pos] as [number, number, number]);

  // Deterministic relaxation: push overlapping pairs apart, pull toward origin.
  for (let it = 0; it < RELAX_ITERATIONS; it += 1) {
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const dx = pos[j][0] - pos[i][0];
        const dy = pos[j][1] - pos[i][1];
        const dz = pos[j][2] - pos[i][2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const min = (radii[i] + radii[j]) * 1.005;
        if (d < min) {
          const push = ((min - d) * 0.5) / d;
          pos[i][0] -= dx * push;
          pos[i][1] -= dy * push;
          pos[i][2] -= dz * push;
          pos[j][0] += dx * push;
          pos[j][1] += dy * push;
          pos[j][2] += dz * push;
        }
      }
    }
    for (let i = 0; i < count; i += 1) {
      pos[i][0] *= 0.985;
      pos[i][1] *= 0.985;
      pos[i][2] *= 0.985;
    }
  }

  const centers = new Float32Array(MAX_NUCLEONS * 4);
  const tints = new Float32Array(MAX_NUCLEONS * 4);
  let extent = 0;
  for (let i = 0; i < count; i += 1) {
    centers[i * 4] = pos[i][0];
    centers[i * 4 + 1] = pos[i][1];
    centers[i * 4 + 2] = pos[i][2];
    centers[i * 4 + 3] = radii[i];
    // Saturated model colour when attributed (production group assignment);
    // neutral two-tone otherwise. Neutrons stay darker than protons.
    const gi = used[i].p.modelGroupIndex;
    const [r0, g0, b0] =
      gi >= 0 && outer.modelGroups[gi]
        ? hexToLinear(modelColor(outer.modelGroups[gi]))
        : hexToLinear(used[i].p.tint);
    const k = used[i].p.isProton ? 1 : 0.6;
    const [r, g, b] = [r0 * k, g0 * k, b0 * k];
    tints[i * 4] = r;
    tints[i * 4 + 1] = g;
    tints[i * 4 + 2] = b;
    tints[i * 4 + 3] = used[i].p.isProton ? 1 : 0;
    extent = Math.max(extent, Math.hypot(pos[i][0], pos[i][1], pos[i][2]) + radii[i]);
  }
  return {
    count,
    centers,
    tints,
    extent,
    spinAxis: outer.spinAxis,
    modelGroups: outer.modelGroups,
  };
}

/** Linear-sRGB colour of a hex, desaturated by `1 - saturation` toward luma. */
export function desaturateLinear(
  rgb: readonly [number, number, number],
  saturation: number
): [number, number, number] {
  const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  const s = Math.min(1, Math.max(0, saturation));
  return [luma + (rgb[0] - luma) * s, luma + (rgb[1] - luma) * s, luma + (rgb[2] - luma) * s];
}

export { mixHex };
