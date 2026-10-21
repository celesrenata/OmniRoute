/**
 * Pure screen-space label collision / priority resolution for the projected
 * atom labels (OR-ATOM-002, V3).
 *
 * When many atoms share the screen (adjacent rings at a fixed camera distance)
 * their projected label chips overlap and obscure each other. This module
 * decides, deterministically and without `three` / DOM, which labels stay
 * visible: a **highest-priority label always wins a collision**, lower-priority
 * labels are hidden rather than pushed, and the focused atom never yields (a selection must not be obscured; the hub is the top of the ordinary tiers, so it wins every non-focused collision)
 * (selection must not be obscured; the hub is the scene's anchor). It is the
 * screen-space counterpart to the label *projection* in `projection.ts` —
 * pure, unit-testable, no clock / no Math.random.
 *
 * The per-frame rAF loop in `overlays/AtomicLabels.tsx` projects every atom to
 * a chip rect, hands the rects here, and hides the ids that come back
 * `hidden`. Nothing is mutated — the same inputs always give the same
 * visibility (a stable order is required so large fleets are deterministic).
 */

/** Collision padding (CSS px) so labels that *touch* still read as colliding. */
const PAD = 4;
/** Projected chip height (CSS px) — pill height + padding. */
export const LABEL_HEIGHT = 24;
/** Vertical offset of the chip from its projected anchor (CSS px; negative = up). */
export const LABEL_OFFSET_Y = -28;

/** One projected label chip (CSS-pixel space, origin = viewport top-left). */
export interface LabelRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Label priority tier ({@link LABEL_PRIORITY_TIERS}); higher wins a collision. */
  priority: number;
}

/** A resolved visibility decision for one label. */
export interface LabelVisibility {
  id: string;
  /** True when the label should be hidden (collision with a higher-priority chip). */
  hidden: boolean;
}

/**
 * Priority tiers (higher wins a collision). A focused atom is always visible
 * (`Infinity`) — selection must never be obscured. The hub (the scene's
 * anchor) is next, then error > active > last > healthy > idle, mirroring the
 * visual-state emphasis. Values are stable constants the tests pin.
 */
export const LABEL_PRIORITY_TIERS = {
  focused: Number.POSITIVE_INFINITY,
  hub: 100,
  error: 60,
  active: 50,
  last: 40,
  healthy: 30,
  idle: 20,
  default: 0,
} as const;

/**
 * Resolve which projected labels are visible, given a set of chip rects.
 *
 * Greedy, priority-ordered: labels are placed highest-priority first; a label
 * is hidden when its rect overlaps an *already placed* (higher-or-equal
 * priority) label's rect. Ties are broken deterministically (further-left,
 * then higher up, then by id) so the same inputs always give the same
 * visibility. The focused label is never hidden.
 *
 * @param rects the projected label chip rects (viewport CSS-pixel space).
 * @returns one {@link LabelVisibility} per input id, in input order.
 */
export function resolveLabelCollision(rects: ReadonlyArray<LabelRect>): LabelVisibility[] {
  // Deterministic placement order: highest priority first; ties broken by
  // left → top → id so a fixed screen layout is stable across frames.
  const order = rects
    .map((r) => ({ r }))
    .sort((a, b) => {
      if (a.r.priority !== b.r.priority) return b.r.priority - a.r.priority;
      if (a.r.left !== b.r.left) return a.r.left - b.r.left;
      if (a.r.top !== b.r.top) return a.r.top - b.r.top;
      return a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0;
    });

  const hiddenByCollision = new Set<string>();
  const placed: LabelRect[] = [];
  for (const { r } of order) {
    if (r.priority === LABEL_PRIORITY_TIERS.focused) continue; // focused is never hidden
    let collides = false;
    for (const p of placed) {
      if (
        r.left < p.left + p.width + PAD &&
        r.left + r.width + PAD > p.left &&
        r.top < p.top + p.height + PAD &&
        r.top + r.height + PAD > p.top
      ) {
        collides = true;
        break;
      }
    }
    if (collides) hiddenByCollision.add(r.id);
    else placed.push(r);
  }

  return rects.map((r) => ({
    id: r.id,
    hidden: hiddenByCollision.has(r.id),
  }));
}

/**
 * Estimate a projected label chip's bounding box in viewport CSS-pixel space.
 *
 * The chip is anchored at the projected point, offset upward by
 * {@link LABEL_OFFSET_Y}, and its width scales with the label text length.
 * This is an *estimate* (no DOM measure) — good enough for collision, and
 * deterministic (testable). The result is clamped to the viewport so a chip
 * spilling off-screen does not count as a collision with on-screen neighbours.
 */
export function labelRect(opts: {
  id: string;
  label: string;
  x: number;
  y: number;
  priority: number;
  viewportWidth: number;
  viewportHeight: number;
}): LabelRect {
  const width = Math.max(56, Math.min(190, 26 + opts.label.length * 6.5));
  const height = LABEL_HEIGHT;
  // Anchor the chip at the projected point, offset up; clamp to the viewport.
  const left = Math.max(0, Math.min(opts.viewportWidth - width, opts.x));
  const top = Math.max(0, Math.min(opts.viewportHeight - height, opts.y + LABEL_OFFSET_Y));
  return { id: opts.id, left, top, width, height, priority: opts.priority };
}
