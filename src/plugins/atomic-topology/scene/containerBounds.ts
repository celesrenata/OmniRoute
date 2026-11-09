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

/**
 * Detail-view relaxation (operator directive 34.1). The default soft band is
 * applied to the camera's own previous output every frame, so any pose inside
 * the band converges to its inner edge (the camera can never sit lower than
 * about 254 units above the floor-side limit). The opt-in detail view needs a
 * low, near eye-level shot, so while it is open the band and clearance shrink:
 * the camera still never reaches a wall, floor or ceiling, but a pose 70+ units
 * inside is left untouched. The default view never sets this flag.
 */
export const clampRelax: { detail: boolean } = { detail: false };
/** Band / clearance used while {@link clampRelax}`.detail` is set. */
export const DETAIL_SOFT_BAND = 40;
export const DETAIL_WALL_CLEARANCE = 30;
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
  bounds: ContainerBounds,
  relaxed: boolean = false
): [number, number, number] {
  const band = relaxed ? DETAIL_SOFT_BAND : SOFT_BAND;
  const clr = relaxed ? DETAIL_WALL_CLEARANCE : WALL_CLEARANCE;
  return [
    softClampAxis(pos[0], bounds.min[0], bounds.max[0], band, clr),
    softClampAxis(pos[1], bounds.min[1], bounds.max[1], band, clr),
    softClampAxis(pos[2], bounds.min[2], bounds.max[2], band, clr),
  ];
}
