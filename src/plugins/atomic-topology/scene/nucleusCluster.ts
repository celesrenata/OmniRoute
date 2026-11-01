/**
 * Deterministic nucleus-cluster builder for the Atomic scene
 * (OR-ATOM-008, S8.3 — distinct proton/neutron shading + model identity).
 *
 * Pure module: no `three`, no DOM, no `Math.random` (seeded mulberry32 driven
 * by the caller's FNV-1a id hash — the same determinism pattern as
 * `cloudShells.ts` and `visualEncoding.ts`).
 *
 * What the builder produces (one {@link NucleusCluster} per atom, rendered by
 * the scene components as TWO instanced meshes sharing ONE unit-sphere
 * geometry):
 *
 *   - **positions** are unit-radius offsets (1 == the atom's core radius) on a
 *     small even Fibonacci shell of radius {@link NUCLEUS_SHELL_RADIUS}, so
 *     the cluster reads as the atom *body* — not orbiting electrons.
 *   - **protons vs neutrons** are distinguished by *scale + material +
 *     luminance*, not by a color wash (webgpu-threejs-tsl per-particle
 *     luminance separation): protons are larger, brighter, smooth
 *     ({@link PROTON_ROUGHNESS}); neutrons smaller, darker, matte
 *     ({@link NEUTRON_ROUGHNESS}). This module carries the per-particle
 *     `scaleMul` / `emissiveMul` / `tint` so the exact separation is unit-
 *     testable; the scene applies the role roughness on two shared material
 *     instances.
 *   - **model identity** (visual-design-foundations color-systems): when
 *     observed model ids exist, particles are grouped into at most
 *     {@link MAX_MODEL_GROUPS} deterministic angular sectors, each colored by
 *     `modelColor(modelId)`. Group identity is a hash of the model id (never
 *     the array index), so groups are stable across frames, redraws, and
 *     input-ORDER changes; sectors are contiguous azimuth bands, so 2–3 model
 *     colors read as spatially clustered groups. When ids are absent the
 *     cluster renders the honest neutral two-tone palette — never labeled as
 *     observed models.
 *
 * The topology snapshot does NOT expose per-node model ids today (the lane
 * derivation consumes them internally in `normalizeTopology`), so the scene
 * currently passes none and every nucleus renders neutral. The builder is
 * fully general and unit-tested so the model-color groups activate the moment
 * a descriptor carries `observedModelIds` — no scene change needed.
 */
import { modelColor } from "../visualEncoding";
import { fnv1a } from "./cloudShells";

/* ------------------------------------------------------------------ */
/* Constants — pinned by the unit tests                                */
/* ------------------------------------------------------------------ */

/** Particle count for a ring (provider/gpu) atom nucleus. Spec: 7–9. */
export const RING_NUCLEUS_PARTICLE_COUNT = 8;
/** Particle count for the hub nucleus (more particles keep its prominence). Spec: 11–13. */
export const HUB_NUCLEUS_PARTICLE_COUNT = 12;

/** Cluster shell radius, in units of the atom's core radius (~0.55×). */
export const NUCLEUS_SHELL_RADIUS = 0.55;
/** Deterministic per-particle radial jitter around the shell (± fraction). */
export const NUCLEUS_SHELL_JITTER = 0.06;
/**
 * Base particle radius, in units of the atom's core radius. Sized so the
 * even-Fibonacci shell spacing keeps the nucleons *packed but individually
 * distinguishable* (a nucleus reads as structured nucleons, not a fuzzy
 * ball): the min adjacent chord on the 0.55× shell (2·0.55·sin(π/N) ≈ 0.45
 * core units for 12 particles) is just above the max proton-proton diameter
 * (2·0.20·1.15 = 0.46), so same-role neighbors nearly touch without
 * swallowing each other.
 */
export const NUCLEUS_PARTICLE_BASE_RADIUS = 0.2;
/**
 * Central anchor sphere radius, as a fraction of the CLUSTER shell radius
 * (so the anchor stays small relative to the nucleon body on every atom —
 * S8.3: "keep core sphere as the small central anchor").
 */
export const ANCHOR_RADIUS_FRACTION = 0.35;

/** Proton scale range vs the base particle radius (slightly larger). */
export const PROTON_SCALE_MIN = 1.0;
export const PROTON_SCALE_MAX = 1.15;
/** Neutron scale range vs the base particle radius (slightly smaller). */
export const NEUTRON_SCALE_MIN = 0.75;
export const NEUTRON_SCALE_MAX = 0.9;

/**
 * Per-role roughness (webgpu-threejs-tsl: material differentiation, not a
 * color wash). Protons are smooth/luminous, neutrons matte/absorbent. Applied
 * as uniforms on two shared material instances — no shader change, so both
 * roles keep the ONE fresnel-injected compiled program.
 */
export const PROTON_ROUGHNESS = 0.35;
export const NEUTRON_ROUGHNESS = 0.7;

/** Emissive multipliers on top of the per-state emissive (role luminance). */
export const PROTON_EMISSIVE_MUL = 1.0;
export const NEUTRON_EMISSIVE_MUL = 0.35;

/** Target proton share of the cluster (~55/45 proton/neutron split). */
export const PROTON_TARGET_SHARE = 0.55;

/** Maximum distinct model-color groups readable in the nucleus. */
export const MAX_MODEL_GROUPS = 3;

/**
 * Neutral two-tone palette for unknown model attribution (visual-
 * design-foundations: an intentionally neutral two-tone — not a color wash
 * and not labeled as observed models).
 *
 * `PROTON_TINT_WARM` — warm white (a bright neutral).
 * `NEUTRON_TINT_SLATE` — `UNKNOWN_MODEL_COLOR` (#64748B) darkened toward
 * slate (#334155) by 45 % → #4E5D73, a cool neutral clearly below the
 * proton luminance.
 */
export const PROTON_TINT_WARM = "#F2EDE3";
export const NEUTRON_TINT_SLATE = "#4E5D73";

/** Blend toward the warm tint for observed-group protons (bright, warm-lit). */
export const GROUP_PROTON_WARM_BLEND = 0.45;
/** Blend toward the cool slate for observed-group neutrons (dim, cool). */
export const GROUP_NEUTRON_SLATE_BLEND = 0.55;

/** Golden angle — even Fibonacci-sphere spacing, deterministic. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** Deterministic seeded PRNG (mulberry32) — stable across engines. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix two hex colors toward `b` by `t` ∈ [0,1]. Returns uppercase hex. */
export function mixHex(a: string, b: string, t: number): string {
  const ch = (x: number, y: number): string =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return (
    `#${ch(parseInt(a.slice(1, 3), 16), parseInt(b.slice(1, 3), 16))}` +
    `${ch(parseInt(a.slice(3, 5), 16), parseInt(b.slice(3, 5), 16))}` +
    `${ch(parseInt(a.slice(5, 7), 16), parseInt(b.slice(5, 7), 16))}`
  ).toUpperCase();
}

/**
 * Canonicalize observed model ids for group assignment:
 * trim + lowercase (same canonical form as `modelColor`), drop blanks and
 * duplicates, then sort by the FNV-1a hash of the id — so group k is always
 * the k-th smallest hash, NEVER the k-th array slot (order-independent).
 * Caps at {@link MAX_MODEL_GROUPS}.
 */
function resolveModelGroups(ids: readonly string[] | undefined): string[] {
  if (!ids || ids.length === 0) return [];
  const seen = new Set<string>();
  const canonical = ids
    .map((id) => id.trim().toLowerCase())
    .filter((id) => {
      if (id.length === 0 || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  canonical.sort((x, y) => {
    const h = fnv1a(x) - fnv1a(y);
    return h !== 0 ? h : x < y ? -1 : x > y ? 1 : 0;
  });
  return canonical.slice(0, MAX_MODEL_GROUPS);
}

/**
 * Final instance tint for one particle:
 * - unknown attribution → the neutral two-tone (role color, no model label);
 * - observed group → `modelColor(modelId)` blended toward the warm (proton)
 *   or cool-slate (neutron) role tint, so the group reads as a spatially
 *   clustered color family while protons stay brighter than neutrons.
 */
function particleTint(isProton: boolean, modelId: string | null): string {
  if (modelId === null) return isProton ? PROTON_TINT_WARM : NEUTRON_TINT_SLATE;
  const group = modelColor(modelId);
  return isProton
    ? mixHex(group, PROTON_TINT_WARM, GROUP_PROTON_WARM_BLEND)
    : mixHex(group, NEUTRON_TINT_SLATE, GROUP_NEUTRON_SLATE_BLEND);
}

/** Rotate (x,y,z) around the Y axis by `angle` (radians). */
function rotateY(x: number, y: number, z: number, angle: number): [number, number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c + z * s, y, -x * s + z * c];
}

/** Rotate (x,y,z) around the X axis by `angle` (radians). */
function rotateX(x: number, y: number, z: number, angle: number): [number, number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x, y * c - z * s, y * s + z * c];
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

/** One nucleus particle spec (rendered as an instanced unit sphere). */
export interface NucleusParticle {
  /**
   * Unit-radius offset — 1 == the atom's core radius. The scene scales it by
   * the core radius; the cluster is therefore proportional per atom.
   */
  position: [number, number, number];
  /** Protons are the larger, brighter, low-roughness role. */
  isProton: boolean;
  /** 0..k-1 (observed model-group sector) or `-1` (unknown / neutral). */
  modelGroupIndex: number;
  /** Particle radius multiplier relative to the base particle radius. */
  scaleMul: number;
  /** Emissive multiplier on top of the per-state emissive (role luminance). */
  emissiveMul: number;
  /** Final per-instance tint (hex) — neutral two-tone or model-group color. */
  tint: string;
}

/** The full deterministic nucleus cluster (particles + spin axis + groups). */
export interface NucleusCluster {
  particles: NucleusParticle[];
  /**
   * Unit spin axis (seeded, distinct per atom) — the scene rotates the whole
   * cluster around it at the measured spin rate; absent spin → static.
   */
  spinAxis: [number, number, number];
  /** Observed model ids after canonicalization (≤ {@link MAX_MODEL_GROUPS}); empty when unknown. */
  modelGroups: string[];
}

/** Inputs to {@link buildNucleusCluster}. */
export interface NucleusClusterInput {
  /** FNV-1a hash of the atom id (the same seed the electron cloud uses). */
  seed: number;
  /** Number of particles (ring = 8, hub = 12 — see the count constants). */
  particleCount: number;
  /**
   * Observed in-flight model ids, when available. Absent / empty → neutral
   * two-tone palette (honest unknown, no fabricated attribution).
   */
  observedModelIds?: readonly string[];
}

/**
 * Build the deterministic nucleus cluster.
 *
 * Determinism contract (same discipline as `cloudShells.ts`): the same
 * `(seed, particleCount, observedModelIds)` ALWAYS yields the same specs —
 * no `Math.random`, no wall clock, no array-order dependence (model ids are
 * hashed, not indexed). Different seeds give different (but equally even)
 * orientations.
 */
export function buildNucleusCluster(input: NucleusClusterInput): NucleusCluster {
  const { seed, particleCount } = input;
  const groups = resolveModelGroups(input.observedModelIds);
  if (particleCount <= 0) {
    return { particles: [], spinAxis: [0, 1, 0], modelGroups: groups };
  }

  const rng = mulberry32(seed);

  // Seeded spin axis on the unit sphere (deterministic per atom; the scene
  // rotates the cluster around it only when a measured spin rate exists).
  const axisY = 1 - 2 * rng();
  const axisR = Math.sqrt(Math.max(0, 1 - axisY * axisY));
  const axisTheta = rng() * Math.PI * 2;
  const spinAxis: [number, number, number] = [
    axisR * Math.cos(axisTheta),
    axisY,
    axisR * Math.sin(axisTheta),
  ];

  // Fibonacci-sphere phase + seed-derived orientation (two fixed-axis
  // rotations): every atom gets a distinct cluster orientation, but the
  // spacing stays even and fully deterministic.
  const phase = rng() * Math.PI * 2;
  const yaw = rng() * Math.PI * 2;
  const pitch = rng() * Math.PI * 2;

  // Proton slots: round-robin every 2nd slot from a seeded start, so the
  // roles alternate around the cluster (no role clumping); a collision from
  // the wrap-around advances by 1 (deterministic).
  const protonCount = Math.min(
    particleCount,
    Math.max(1, Math.round(particleCount * PROTON_TARGET_SHARE))
  );
  const start = Math.floor(rng() * particleCount);
  const isProton = new Array<boolean>(particleCount).fill(false);
  const taken = new Set<number>();
  for (let placed = 0; placed < protonCount; placed += 1) {
    let slot = (start + placed * 2) % particleCount;
    while (taken.has(slot)) slot = (slot + 1) % particleCount;
    isProton[slot] = true;
    taken.add(slot);
  }

  const particles: NucleusParticle[] = [];
  for (let i = 0; i < particleCount; i += 1) {
    // Even Fibonacci distribution on the unit sphere.
    const t = (i + 0.5) / particleCount;
    const y0 = 1 - 2 * t;
    const r0 = Math.sqrt(Math.max(0, 1 - y0 * y0));
    const theta = i * GOLDEN_ANGLE + phase;
    let x = r0 * Math.cos(theta);
    let y = y0;
    let z = r0 * Math.sin(theta);
    [x, y, z] = rotateY(x, y, z, yaw);
    [x, y, z] = rotateX(x, y, z, pitch);

    // Deterministic per-particle radial jitter around the shell radius.
    const radius = NUCLEUS_SHELL_RADIUS + (rng() * 2 - 1) * NUCLEUS_SHELL_JITTER;

    // Model-group sector from the POST-rotation azimuth: sectors are
    // contiguous angular ranges, so groups read as spatial clusters and the
    // mapping is stable under model ORDER changes (group identity is the
    // hash-sorted model id, never the array index).
    const azimuth = Math.atan2(z, x);
    const modelGroupIndex =
      groups.length > 0
        ? Math.floor(((azimuth + Math.PI) / (Math.PI * 2)) * groups.length) % groups.length
        : -1;

    const proton = isProton[i];
    const scaleMul = proton
      ? PROTON_SCALE_MIN + (PROTON_SCALE_MAX - PROTON_SCALE_MIN) * rng()
      : NEUTRON_SCALE_MIN + (NEUTRON_SCALE_MAX - NEUTRON_SCALE_MIN) * rng();

    particles.push({
      position: [x * radius, y * radius, z * radius],
      isProton: proton,
      modelGroupIndex,
      scaleMul,
      emissiveMul: proton ? PROTON_EMISSIVE_MUL : NEUTRON_EMISSIVE_MUL,
      tint: particleTint(proton, modelGroupIndex >= 0 ? groups[modelGroupIndex] : null),
    });
  }

  return { particles, spinAxis, modelGroups: groups };
}
