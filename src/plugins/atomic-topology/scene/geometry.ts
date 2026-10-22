/**
 * Pure deterministic geometry helpers for the atomic scene (OR-ATOM-003, V7).
 *
 * The scene primitives (`Nucleus`, `ElectronCloud`) each need deterministic,
 * reproducible placement math: the nucleus's dense Fibonacci-sphere particle
 * cluster and the electron cloud's per-shell orbital configuration. This module
 * is that math, extracted so it is unit-testable on its own — **no `three`,
 * no `@react-three/fiber`, no `react`** — while the components stay the thin
 * render layer around it (a single instanced-mesh draw for the nucleus, a
 * handful of torus + electron meshes for the cloud).
 *
 * Every exported function is a pure function of its arguments: same inputs →
 * same outputs, no wall clock, no randomness, no module-level mutable state.
 * That keeps the 3D scene deterministic across renders (and across the whole
 * test suite), so the visuals never depend on when or how many times a frame
 * ran.
 */

/** A world-space position (x, y, z). */
export type Vec3 = [number, number, number];

/* ------------------------------------------------------------------ */
/* Nucleus particle field (the dense proton/neutron cluster)           */
/* ------------------------------------------------------------------ */

/** World-space radius of the nucleus core sphere (the hub atom). */
export const NUCLEUS_RADIUS = 42;

/**
 * Brand-accent identity color for the hub core (V7 — the hub's *identity*
 * color, deliberately separate from the runtime-health halo color). The hub is
 * the topology's "nucleus"; it wears the brand indigo so it reads as the
 * anchor, while provider atoms use their own model/lane colors.
 */
export const HUB_BRAND_ACCENT = "#6366f1";

/**
 * Proton / neutron particle palette for the dense cluster. Alternating light
 * blue + slate reads as a layered nuclear body (not monochrome).
 */
export const PROTON_COLOR = "#bfdbfe";
export const NEUTRON_COLOR = "#94a3b8";

/** Number of particles in the dense cluster at the default quality tier. */
export const PARTICLE_COUNT_HIGH = 48;
/** Number of particles in the dense cluster at the low quality tier. */
export const PARTICLE_COUNT_LOW = 24;

/** The fraction of the core radius the particle cluster occupies. */
export const NUCLEUS_CLUSTER_RADIUS_FACTOR = 0.72;

/** The fraction of the cluster radius each individual particle occupies. */
export const NUCLEUS_PARTICLE_RADIUS_FACTOR = 0.22;

/* ------------------------------------------------------------------ */
/* Ring-atom nucleus (V4 — provider atoms are dense too, not spheres)  */
/* ------------------------------------------------------------------ */

/**
 * Particle count for a *ring atom* (provider/gpu) nucleus at high quality.
 * Deliberately lower than the hub's {@link PARTICLE_COUNT_HIGH}: an atom is a
 * smaller body, and the per-atom draw budget must stay flat across a fleet.
 */
export const ATOM_NUCLEUS_COUNT_HIGH = 12;
/** Particle count for a ring-atom nucleus at the low quality tier. */
export const ATOM_NUCLEUS_COUNT_LOW = 6;

/** Fixed world radius of one ring-atom nucleus particle. */
export const ATOM_NUCLEUS_PARTICLE_RADIUS = 2.6;

/** The fraction of the atom core radius the atom cluster occupies. */
export const ATOM_NUCLEUS_CLUSTER_RADIUS_FACTOR = 0.78;

/**
 * The dense, deterministic nucleus cluster for a *ring atom* (V4).
 *
 * Same Fibonacci-sphere placement as the hub's {@link nucleusParticleField},
 * but the palette is honest per the telemetry matrix: each particle takes
 * the next **observed** model color, cycling (`colors[i % colors.length]`).
 * When no models are observed (`colors` empty), the cluster falls back to the
 * neutral proton/neutron alternation — a ring atom with no mapped model
 * renders as a neutral nuclear body, never a fabricated model composition.
 *
 * Pure: same `count` / `radius` / `colors` → same positions + colors.
 *
 * @param count   particle count (the quality tier decides 6 vs 12); clamped to 0.
 * @param radius  cluster radius in world units.
 * @param colors  observed in-flight model colors (may be empty → neutral).
 */
export function atomNucleusParticleField(
  count: number,
  radius: number,
  colors: string[]
): NucleusParticle[] {
  const n = Math.max(0, Math.floor(count));
  const hasColors = colors.length > 0;
  return Array.from({ length: n }, (_, i) => ({
    position: fibonacciSpherePosition(i, n, radius),
    color: hasColors ? colors[i % colors.length] : i % 2 === 0 ? PROTON_COLOR : NEUTRON_COLOR,
  }));
}

/** One particle in the nucleus cluster: its world position + color. */
export interface NucleusParticle {
  position: Vec3;
  color: string;
}

/**
 * A single particle's position on the Fibonacci sphere (golden-angle spiral)
 * — deterministic, no randomness. Evenly distributes one point per index on a
 * unit sphere, then scales to `radius`. Pure: same `index` / `count` /
 * `radius` → same position.
 */
function fibonacciSpherePosition(index: number, count: number, radius: number): Vec3 {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  // A single point has no spiral span — park it at the north pole so the
  // helper stays NaN-free for every integer count >= 1 (callers clamp to >= 0).
  const denom = count > 1 ? count - 1 : 1;
  const y = 1 - (index / denom) * 2; // -1 → 1
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = goldenAngle * index;
  return [r * Math.cos(theta) * radius, y * radius, r * Math.sin(theta) * radius];
}

/**
 * The nucleus's dense, deterministic particle cluster (OR-ATOM-003, V4).
 *
 * `count` particles are placed on a Fibonacci sphere (golden-angle spiral)
 * scaled to the cluster radius, with alternating proton / neutron colors so
 * the body reads as layered rather than monochrome. Pure: the same
 * `count` / `radius` always produces the same positions and colors (no
 * randomness, no wall clock), so the nucleus looks identical on every render
 * and in tests.
 *
 * @param count      number of particles (the quality tier decides 24 vs 48);
 *                   clamped to 0 or more (0 → empty cluster).
 * @param radius     cluster radius in world units (the caller passes
 *                   `NUCLEUS_RADIUS * NUCLEUS_CLUSTER_RADIUS_FACTOR`).
 * @returns one {@link NucleusParticle} per index, in spiral order (index 0
 *          at the "north pole", the last at the "south pole").
 */
export function nucleusParticleField(count: number, radius: number): NucleusParticle[] {
  const n = Math.max(0, Math.floor(count));
  return Array.from({ length: n }, (_, i) => ({
    position: fibonacciSpherePosition(i, n, radius),
    color: i % 2 === 0 ? PROTON_COLOR : NEUTRON_COLOR,
  }));
}

/* ------------------------------------------------------------------ */
/* Electron cloud shell configuration (per-orbit static geometry)     */
/* ------------------------------------------------------------------ */

/**
 * A single shell's static geometry configuration (the component memoizes one
 * per shell and reads it every frame for the electron advance).
 */
export interface ElectronShellConfig {
  /** Tilt around the world X axis (radians). */
  tiltX: number;
  /** Tilt around the world Z axis (radians) — additional tilt variety. */
  tiltZ: number;
  /** Speed multiplier (outer shells orbit slightly slower than inner). */
  speedFactor: number;
  /** Major-axis radius (world units). */
  rx: number;
  /** Minor-axis radius (world units) — `rx * ellipticity`. */
  rz: number;
  /** Minor/major ratio (squashes the circular torus into an elliptical line). */
  ellipticity: number;
  /** Static initial electron positions (phase 0), on the shell's ellipse. */
  electrons: Vec3[];
}

/**
 * Per-shell tilt (X-axis radians). Deterministic, distinct per shell index so
 * no two shells share a plane — the cloud reads as a 3D orbital system.
 */
export const SHELL_TILTS_X = [0.5, -0.28, 0.95] as const;
/** Per-shell Z-rotation (radians) — additional tilt variety. */
export const SHELL_TILTS_Z = [0.24, 0.6, -0.4] as const;
/** Per-shell speed multiplier (outer shells orbit slightly slower). */
export const SHELL_SPEED_FACTOR = [1.0, 0.72, 0.5] as const;
/**
 * Per-shell major-axis radius multiplier (V5 layered depth). The innermost
 * shell sits just outside the atom core, the outermost is the widest orbit.
 */
export const SHELL_RADIUS_FACTOR = [0.74, 1.0, 1.28] as const;
/**
 * Per-shell ellipticity (minor/major axis ratio). Each orbit is a distinct
 * ellipse — the "multi-axis elliptical orbital planes" the spec asks for.
 */
export const SHELL_ELLIPTICITY = [0.68, 0.52, 0.42] as const;

/**
 * The electron cloud's per-shell static geometry (OR-ATOM-003, V5).
 *
 * `shellCount` shells (clamped to 1–3) each get a distinct tilt, a
 * shell-index-scaled major radius, a per-shell ellipticity, and
 * `max(2, floor(electronCount / shellCount))` electrons evenly phase-offset
 * around the shell's ellipse (index 0 starts at angle 0; each shell adds a
 * 0.6-rad phase stagger so the shells don't read as one ring). Pure: same
 * `radius` / `electronCount` / `shellCount` → same configuration, every time.
 *
 * @param radius        the atom's orbital major-axis radius (world units) —
 *                      scaled per shell by {@link SHELL_RADIUS_FACTOR}.
 * @param electronCount the total electron budget across all shells.
 * @param shellCount    number of orbital shells (clamped to ≥1, ≤3).
 */
export function electronShellConfig(
  radius: number,
  electronCount: number,
  shellCount: number
): ElectronShellConfig[] {
  const count = Math.min(3, Math.max(1, Math.floor(shellCount)));
  const perShell = Math.max(2, Math.floor(electronCount / count));
  return Array.from({ length: count }, (_, s) => {
    const tiltX = SHELL_TILTS_X[s] ?? 0.5;
    const tiltZ = SHELL_TILTS_Z[s] ?? 0.24;
    const speedFactor = SHELL_SPEED_FACTOR[s] ?? 0.5;
    const ellipticity = SHELL_ELLIPTICITY[s] ?? 0.6;
    const rx = radius * (SHELL_RADIUS_FACTOR[s] ?? 1);
    const rz = rx * ellipticity;
    const electrons = Array.from({ length: perShell }, (_, i) => {
      const angle = (i / perShell) * Math.PI * 2 + s * 0.6;
      return [Math.cos(angle) * rx, 0, Math.sin(angle) * rz] as Vec3;
    });
    return { tiltX, tiltZ, speedFactor, rx, rz, ellipticity, electrons };
  });
}
