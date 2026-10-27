/**
 * Pure electron-cloud shell math for the Atomic scene (OR-ATOM-007).
 *
 * No `three`, no DOM, no `Math.random`, no clock. Replaces the single coplanar
 * electron ring with 2–3 **non-coplanar orbital shells** per atom, each with a
 * deterministic tilt/polar orientation, radius multiplier, electron count and
 * speed multiplier derived from a seed (FNV-1a over a stable id, matching the
 * pattern pinned in `visualEncoding.ts`).
 *
 * Determinism contract: the same `seed` always yields the same shells — the
 * scene must not depend on array order or wall-clock time for geometry.
 */

/** FNV-1a 32-bit — same construction as `fnv1a` in `visualEncoding.ts`. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** One orbital shell: a tilted great-circle of electrons around an atom. */
export interface CloudShell {
  /** Euler tilt applied to the shell group (radians), deterministic per seed. */
  tilt: [number, number, number];
  /**
   * Great-circle radius multiplier relative to the atom's base cloud radius
   * (shells nest at different depths: ~1.0 / ~1.22 / ~1.45).
   */
  radiusMultiplier: number;
  /** Electron count on this shell (5 / 7 / 9 for shells 0/1/2). */
  electronCount: number;
  /**
   * Shell spin speed multiplier (1.0 / 0.82 / 0.63) applied on top of the
   * per-atom `spin.value` so inner shells lead and outer trails.
   */
  speedMultiplier: number;
  /**
   * Constant per-shell phase offset (radians) so the shells do not start
   * aligned — deterministic per seed, stable across re-renders.
   */
  phaseOffset: number;
}

/** Radius multipliers (inner → outer); the spec's 1.0 / 1.22 / 1.45 nesting. */
export const SHELL_RADIUS_MULTIPLIERS = [1.0, 1.22, 1.45] as const;
/**
 * Electron counts per shell (4 / 6 / 8). The spec suggests 5/7/9 as an
 * example; 4/6/8 keeps the per-atom total at 18 sprites so the worst-case
 * scene (38 ring atoms) stays under the ~700 total-sprite budget
 * (web-quality-performance: bounded sprite count).
 */
export const SHELL_ELECTRON_COUNTS = [4, 6, 8] as const;
/** Speed multipliers per shell (1.0 / 0.82 / 0.63). */
export const SHELL_SPEED_MULTIPLIERS = [1.0, 0.82, 0.63] as const;
/** Number of shells per atom. */
export const SHELL_COUNT = 3;

/**
 * Deterministic per-shell orientation + timing parameters from a seed.
 *
 * The orientation is a 3-axis tilt drawn from the hash bits (each axis gets a
 * different bit slice so the three shells of one atom fan out into distinct
 * planes; the outer shells are tilted further from the ecliptic than the
 * inner one, keeping the innermost shell near the base ring). All values are
 * bounded so no shell can leave the atom's local envelope (no layout impact).
 */
export function cloudShells(seed: number, count = SHELL_COUNT): CloudShell[] {
  const n = Math.max(1, Math.min(SHELL_COUNT, count));
  const shells: CloudShell[] = [];
  for (let i = 0; i < n; i += 1) {
    // Per-shell hash slice: mix the seed with the shell index.
    const s = fnv1a(`${seed}:${i}`);
    const bit = (shift: number): number => (s >>> shift) & 0xffff;
    // Map 16 bits into radians in [0, 2π).
    const angle = (shift: number): number => (bit(shift) / 0x10000) * Math.PI * 2;
    const depth = i / (n - 1 || 1); // 0 (inner) .. 1 (outer)
    const tiltA = angle(0) * (0.25 + 0.75 * depth);
    const tiltB = angle(12) * (0.25 + 0.75 * depth);
    const tiltC = angle(24) * (0.2 + 0.3 * depth);
    shells.push({
      tilt: [tiltA, tiltB, tiltC],
      radiusMultiplier: SHELL_RADIUS_MULTIPLIERS[Math.min(i, SHELL_RADIUS_MULTIPLIERS.length - 1)],
      electronCount: SHELL_ELECTRON_COUNTS[Math.min(i, SHELL_ELECTRON_COUNTS.length - 1)],
      speedMultiplier: SHELL_SPEED_MULTIPLIERS[Math.min(i, SHELL_SPEED_MULTIPLIERS.length - 1)],
      phaseOffset: angle(4 + 32),
    });
  }
  return shells;
}

/**
 * Distribute a total electron budget across `shellCount` shells using the
 * 007 per-shell ratio (4 : 6 : 8 — inner shells denser) while capping the
 * *total* at `total`. This is the bridge between the 007 fixed shell
 * geometry and the release's quality-scaled `cloudParticles` budget
 * (`QUALITY_BUDGETS[quality].cloudParticles`): same deterministic shell
 * structure, but the electron count follows the quality tier so the per-atom
 * draw-call budget stays flat.
 *
 * The fixed ratio is inherently deterministic, so `_seed` is a no-op today —
 * it is kept for positional API symmetry with `cloudShells(seed, …)` (and as
 * the reserved hook for future per-shell jitter). Pure: same inputs → same
 * outputs. `total ≤ 0` → all zeros; each shell ≥ 1 when the budget allows,
 * so no empty shell at `low` quality.
 */
export function distributeElectrons(_seed: number, shellCount: number, total: number): number[] {
  const n = Math.max(1, Math.min(SHELL_COUNT, shellCount));
  const t = Math.max(0, total);
  if (t === 0) return Array.from({ length: n }, () => 0);
  const ratio = SHELL_ELECTRON_COUNTS.slice(0, n);
  const ratioSum = ratio.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  let used = 0;
  for (let i = 0; i < n; i += 1) {
    let count = i < n - 1 ? Math.round((t * ratio[i]) / ratioSum) : t - used;
    count = Math.max(0, Math.min(count, t - used));
    out.push(count);
    used += count;
    if (used >= t) break;
  }
  return out;
}
