/**
 * Camera containment for the enclosed circuit-board container (operator
 * directive 15, a narrow exception to the camera freeze): the camera may orbit,
 * zoom and pan but can never pass through or outside the container's walls,
 * floor or ceiling. Pure and three-free so it is unit-testable.
 *
 * The constraint is SOFT: inside `band` of a wall the offset is compressed
 * exponentially, so the camera eases toward the wall and approaches (never
 * reaches) the inner limit, with no hard snapping. Positions already well
 * inside are returned unchanged, so the default pose / fit / focus feel is
 * untouched whenever the container encloses it.
 */
export interface ContainerBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Gap between the camera and a wall at the limit (world units). */
export const WALL_CLEARANCE = 60;
/** Width of the soft compression band before the limit (world units). */
export const SOFT_BAND = 260;

/** Mutable bounds shared between the scene host (writer) and the clamp (reader). */
export const containerBounds: { value: ContainerBounds | null } = { value: null };

/** Soft-compress one axis value into (lo, hi - clearance). Monotonic, C1 at the band edge. */
export function softClampAxis(
  v: number,
  lo: number,
  hi: number,
  band: number = SOFT_BAND,
  clearance: number = WALL_CLEARANCE
): number {
  if (!Number.isFinite(v)) return v;
  const maxV = hi - clearance;
  const minV = lo + clearance;
  if (!(maxV > minV)) return (lo + hi) / 2;
  const b = Math.min(band, (maxV - minV) / 2);
  const upStart = maxV - b;
  const dnStart = minV + b;
  if (v > upStart) return upStart + b * (1 - Math.exp(-(v - upStart) / b));
  if (v < dnStart) return dnStart - b * (1 - Math.exp(-(dnStart - v) / b));
  return v;
}

/** Soft-clamp a camera position into the container. Returns a new tuple. */
export function softClampToBounds(
  pos: readonly [number, number, number],
  bounds: ContainerBounds
): [number, number, number] {
  return [
    softClampAxis(pos[0], bounds.min[0], bounds.max[0]),
    softClampAxis(pos[1], bounds.min[1], bounds.max[1]),
    softClampAxis(pos[2], bounds.min[2], bounds.max[2]),
  ];
}
