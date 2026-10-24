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
 * Widths: the collision box uses the live DOM measurement when the host
 * overlay could read it (`measuredWidth`), else {@link estimateChipWidth} —
 * a conservative, CSS-matched estimate (same padding / border / swatch /
 * gaps / font sizes / letter-spacing as `.atomic-labels__row` in
 * `src/app/globals.css`). A conservative (never-too-small) estimate is the
 * point: underestimation is exactly what let `hub`/`arc-embed` and
 * `vllm`/`llama-cpp` overlap on screen without being flagged (OR-ATOM-002).
 *
 * The per-frame rAF loop in `overlays/AtomicLabels.tsx` projects every atom
 * to a chip rect, hands the rects here, and hides the ids that come back
 * `hidden`. Nothing is mutated — the same inputs always give the same
 * visibility (a stable order is required so large fleets are deterministic).
 */

/** Collision padding (CSS px) so labels that *touch* still read as colliding. */
const PAD = 4;
/** Projected chip height (CSS px) — pill height + padding. */
export const LABEL_HEIGHT = 24;
/** Vertical offset of the chip from its projected anchor (CSS px; negative = up). */
export const LABEL_OFFSET_Y = -28;

/**
 * Chip geometry — mirrors the `.atomic-labels__row` presentation in
 * `src/app/globals.css` (the "Atomic topology scene" block). Keep in sync
 * with that CSS: the collision estimate must *over-cover* the rendered
 * chip, so every value below is a conservative bound on what the browser
 * actually draws.
 */
export const CHIP_GEOMETRY = {
  /** `.atomic-labels__row` — `padding: 2px 8px`. */
  paddingX: 8,
  /** `.atomic-labels__row` — `border: 1px solid …`. */
  borderX: 1,
  /** `.atomic-labels__swatch` — `width: 8px`. */
  swatchWidth: 8,
  /** `.atomic-labels__row` — `gap: 6px` (two gaps: swatch↔text, text↔state). */
  gapCount: 2,
  gap: 6,
  /** `.atomic-labels__row` — `font-size: 11px`. */
  fontSize: 11,
  /**
   * Average glyph width at 11px for the app's system font, as a ratio of
   * font size. Deliberately above the visual average (~0.5em) so wide
   * glyphs (m/w/punctuation) and font-substitution drift are covered.
   */
  labelCharWidthRatio: 0.58,
  /** `.atomic-labels__state` — `font-size: 9px`. */
  stateFontSize: 9,
  /** Average uppercase glyph width at 9px, as a ratio of font size. */
  stateCharWidthRatio: 0.62,
  /** `.atomic-labels__state` — `letter-spacing: 0.06em`. */
  stateLetterSpacingRatio: 0.06,
  /** `.atomic-labels__row` — `max-width: 180px` (content box; border adds 2px). */
  maxWidthContent: 180,
} as const;

/** Smallest chip box the collision resolver ever uses (CSS px). */
export const CHIP_MIN_WIDTH = 56;
/** Largest chip box: the CSS `max-width` cap plus one border pixel each side. */
export const CHIP_MAX_WIDTH = CHIP_GEOMETRY.maxWidthContent + 2 * CHIP_GEOMETRY.borderX;

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
    // A focused label is the top of the priority order (Infinity): it is never
    // hidden, but it still *occupies* space, so any label that overlaps the
    // selection yields to it instead. (Previously the focused label was
    // skipped from placement entirely, so lower-priority labels did not
    // occlude to the selection — the selection could still be visually covered
    // by chips that "won" their own collisions.)
    let collides = false;
    if (r.priority !== LABEL_PRIORITY_TIERS.focused) {
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
 * Estimate the rendered width of one label chip in CSS px, from the same
 * inputs the CSS lays out (label text + state word + fixed chrome).
 *
 * Conservative by design: the estimate must never come out *smaller* than
 * the rendered chip — an under-estimate is exactly the OR-ATOM-002 bug
 * (chips that visibly overlapped did not count as colliding). Wide glyphs,
 * the uppercase state word, and the full chrome push the estimate up; the
 * result is clamped to `[CHIP_MIN_WIDTH, CHIP_MAX_WIDTH]`, the upper bound
 * matching the CSS `max-width: 180px` (content) + border.
 */
export function estimateChipWidth(label: string, state: string): number {
  const g = CHIP_GEOMETRY;
  const labelWidth = label.length * g.fontSize * g.labelCharWidthRatio;
  const stateWidth =
    state.length * g.stateFontSize * g.stateCharWidthRatio +
    Math.max(0, state.length - 1) * g.stateFontSize * g.stateLetterSpacingRatio;
  const content =
    2 * g.paddingX + 2 * g.borderX + g.swatchWidth + g.gapCount * g.gap + labelWidth + stateWidth;
  return Math.max(CHIP_MIN_WIDTH, Math.min(CHIP_MAX_WIDTH, content));
}

/**
 * Resolve the chip width for one label: the live DOM measurement when the
 * host could read it (the overlay measures each chip once per snapshot —
 * see `overlays/AtomicLabels.tsx`), otherwise the conservative
 * {@link estimateChipWidth}. Always clamped to `[CHIP_MIN_WIDTH,
 * CHIP_MAX_WIDTH]`, so a stale or zero measurement can never under-cover
 * the rendered chip.
 */
export function resolveChipWidth(label: string, state: string, measuredWidth?: number): number {
  const measured =
    measuredWidth != null && Number.isFinite(measuredWidth) && measuredWidth > 0
      ? measuredWidth
      : estimateChipWidth(label, state);
  return Math.max(CHIP_MIN_WIDTH, Math.min(CHIP_MAX_WIDTH, measured));
}

/**
 * Project a label chip's bounding box in viewport CSS-pixel space.
 *
 * The chip is anchored at the projected point, offset upward by
 * {@link LABEL_OFFSET_Y}; the width is the live DOM measurement when the
 * host provides one (`measuredWidth`), else the conservative
 * {@link estimateChipWidth}. The result is clamped to the viewport so a
 * chip spilling off-screen does not count as a collision with on-screen
 * neighbours.
 */
export function labelRect(opts: {
  id: string;
  label: string;
  /** Visual state word rendered in the chip (e.g. "idle") — part of the width. */
  state: string;
  x: number;
  y: number;
  priority: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Live `getBoundingClientRect()` width (CSS px), when measured by the host. */
  measuredWidth?: number;
}): LabelRect {
  const width = resolveChipWidth(opts.label, opts.state, opts.measuredWidth);
  const height = LABEL_HEIGHT;
  // Anchor the chip at the projected point, offset up; clamp to the viewport.
  const left = Math.max(0, Math.min(opts.viewportWidth - width, opts.x));
  const top = Math.max(0, Math.min(opts.viewportHeight - height, opts.y + LABEL_OFFSET_Y));
  return { id: opts.id, left, top, width, height, priority: opts.priority };
}
