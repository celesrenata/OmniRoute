/**
 * Bounded shader parameters for the raytraced atom (Gate A). Pure, three-free.
 * Every value that reaches a GPU uniform passes through {@link clampShaderParams}
 * so NaN/Infinity/out-of-range inputs can never produce a degenerate shader.
 */

/** Atom world footprint: matches the production ATOM_RADIUS. */
export const ATOM_WORLD_RADIUS = 22;
/** Production electron-cloud radius (ATOM_RADIUS + 16). */
export const CLOUD_BASE_RADIUS = ATOM_WORLD_RADIUS + 16;
/** Outermost shell factor of the production cloud (`SHELL_RADIUS_MULTIPLIERS` max). */
export const CLOUD_OUTER_SHELL_FACTOR = 1.45;
/** Cloud bounding-sphere radius: never exceeds the production envelope. */
export const CLOUD_BOUND_RADIUS = CLOUD_BASE_RADIUS * CLOUD_OUTER_SHELL_FACTOR - 3;

export const MAX_NUCLEONS = 64;
export const MAX_ORBITALS = 3;
export const MAX_WIRES = 8;
export const MIN_MARCH_STEPS = 48;
export const MAX_MARCH_STEPS = 192;
export const MAX_EXPOSURE = 4;
export const MAX_BOLT_DEPTH = 5;
export const MAX_BOLT_VERTICES = 600;

/** Raw, unbounded inputs (may be NaN/Infinity from callers). */
export interface RawShaderParams {
  marchSteps: number;
  exposure: number;
  excitation: number;
  saturation: number;
  brightness: number;
  cloudRadiusMul: number;
  nucleonCount: number;
  orbitalWeights: readonly number[];
  phase: number;
}

export interface ShaderParams {
  marchSteps: number;
  exposure: number;
  excitation: number;
  saturation: number;
  brightness: number;
  cloudRadius: number;
  nucleonCount: number;
  orbitalWeights: [number, number, number];
  phase: number;
}

function bound(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/** Clamp every shader parameter to its documented range (total function). */
export function clampShaderParams(raw: RawShaderParams): ShaderParams {
  const w = raw.orbitalWeights;
  const weights: [number, number, number] = [
    bound(w[0] ?? 0, 0, 1, 0),
    bound(w[1] ?? 0, 0, 1, 0),
    bound(w[2] ?? 0, 0, 1, 0),
  ];
  const sum = weights[0] + weights[1] + weights[2];
  const norm: [number, number, number] =
    sum > 1e-6 ? [weights[0] / sum, weights[1] / sum, weights[2] / sum] : [1, 0, 0];
  return {
    marchSteps: Math.round(bound(raw.marchSteps, MIN_MARCH_STEPS, MAX_MARCH_STEPS, 96)),
    exposure: bound(raw.exposure, 0.1, MAX_EXPOSURE, 1),
    excitation: bound(raw.excitation, 0, 1, 0.12),
    saturation: bound(raw.saturation, 0, 1, 0.35),
    brightness: bound(raw.brightness, 0, 1, 0.35),
    cloudRadius: bound(raw.cloudRadiusMul, 0.5, 1, 0.8) * CLOUD_BOUND_RADIUS,
    nucleonCount: Math.round(bound(raw.nucleonCount, 1, MAX_NUCLEONS, 1)),
    orbitalWeights: norm,
    phase: Number.isFinite(raw.phase) ? raw.phase % 10000 : 0,
  };
}
