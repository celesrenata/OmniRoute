/**
 * Visibility savings (OR-ATOM-010 directive 19). Pure and three-free so it is
 * unit-testable: frustum-plane extraction from a view-projection matrix, a
 * conservative sphere test, and the projected-size march-step scale.
 *
 * Everything here is CONSERVATIVE: it only ever drops work that cannot touch a
 * pixel, or trims sampling for atoms that are tiny on screen. No look change.
 */

/** Six normalised planes (a,b,c,d) x 6, inside when dot(n, p) + d >= 0. */
export type FrustumPlanes = Float32Array;

export function createFrustumPlanes(): FrustumPlanes {
  return new Float32Array(24);
}

/**
 * Gribb-Hartmann plane extraction from a column-major view-projection matrix.
 * The near plane uses the OpenGL form (z >= -w), which is looser than WebGPU's
 * (z >= 0), so the test stays conservative on both backends.
 */
export function extractFrustumPlanes(
  m: ArrayLike<number>,
  out: FrustumPlanes = createFrustumPlanes()
): FrustumPlanes {
  const row = (i: number): [number, number, number, number] => [
    m[i],
    m[i + 4],
    m[i + 8],
    m[i + 12],
  ];
  const r0 = row(0);
  const r1 = row(1);
  const r2 = row(2);
  const r3 = row(3);
  const combos: [number[], number[], number][] = [
    [r3, r0, 1], // left   = r3 + r0
    [r3, r0, -1], // right  = r3 - r0
    [r3, r1, 1], // bottom = r3 + r1
    [r3, r1, -1], // top    = r3 - r1
    [r3, r2, 1], // near   = r3 + r2
    [r3, r2, -1], // far    = r3 - r2
  ];
  combos.forEach(([a, b, sign], i) => {
    let x = a[0] + sign * b[0];
    let y = a[1] + sign * b[1];
    let z = a[2] + sign * b[2];
    let w = a[3] + sign * b[3];
    const l = Math.hypot(x, y, z) || 1;
    x /= l;
    y /= l;
    z /= l;
    w /= l;
    out[i * 4] = x;
    out[i * 4 + 1] = y;
    out[i * 4 + 2] = z;
    out[i * 4 + 3] = w;
  });
  return out;
}

/** True when the sphere may touch the frustum (false only when fully outside one plane). */
export function sphereVisible(
  planes: FrustumPlanes,
  cx: number,
  cy: number,
  cz: number,
  radius: number
): boolean {
  if (![cx, cy, cz, radius].every(Number.isFinite)) return true; // never cull on bad data
  for (let i = 0; i < 6; i += 1) {
    const d =
      planes[i * 4] * cx + planes[i * 4 + 1] * cy + planes[i * 4 + 2] * cz + planes[i * 4 + 3];
    if (d < -radius) return false;
  }
  return true;
}

/** Projected radius (device px) at which the full march step count is used. */
export const FULL_STEPS_RADIUS_PX = 110;
/** Below this projected radius the step count bottoms out at {@link MIN_STEP_FRACTION}. */
export const MIN_STEPS_RADIUS_PX = 40;
export const MIN_STEP_FRACTION = 0.65;

/**
 * Ray-march steps scaled with the atom's projected radius: full count at the
 * default-view size and above, smoothly down to a floor for tiny atoms (their
 * few pixels cannot resolve the extra samples). Never below 16, never above
 * `maxSteps`.
 */
export function marchStepsFor(maxSteps: number, radiusPx: number): number {
  if (!Number.isFinite(radiusPx) || radiusPx >= FULL_STEPS_RADIUS_PX) return maxSteps;
  const k = Math.min(
    1,
    Math.max(0, (radiusPx - MIN_STEPS_RADIUS_PX) / (FULL_STEPS_RADIUS_PX - MIN_STEPS_RADIUS_PX))
  );
  const f = MIN_STEP_FRACTION + (1 - MIN_STEP_FRACTION) * k;
  return Math.max(16, Math.min(maxSteps, Math.round(maxSteps * f)));
}

/** Cloud diameter (device px) below which the small-atom LOD is fully on. */
export const SMALL_LOD_NEAR = 340;
/** Cross-fade span (device px) from the small LOD to the full ray-traced atom. */
export const SMALL_LOD_SPAN = 300;

/** Small-atom LOD weight: 1 for small clouds, smooth cross-fade to 0 (full atom) as they grow. */
export function smallAtomLod(diameterPx: number): number {
  const t = Math.min(1, Math.max(0, (diameterPx - SMALL_LOD_NEAR) / SMALL_LOD_SPAN));
  return 1 - t * t * (3 - 2 * t);
}
