/**
 * Detail-view label mask (operator directive 39.1).
 *
 * While the detail view is open, a NEIGHBOUR's label must not draw over the inspected
 * atom's silhouette or the detail panel. The frozen label layer (`AtomicLabels.tsx`,
 * `labelCollision`, `projection`) is untouched: the host measures the label rows,
 * picks the ones that overlap, and hides them with a scoped stylesheet keyed by
 * `data-atom-id` (opacity transition, restored on exit by removing the stylesheet).
 *
 * Pure geometry, canvas CSS px.
 */
import { cssAttrValue } from "./detailLabelCss";

export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Projected silhouette of the focused atom (centre + radius, px). */
export interface MaskCircle {
  x: number;
  y: number;
  r: number;
}
export interface MaskLabel {
  id: string;
  rect: MaskRect;
}
/** Extra px around the silhouette / panel a label must clear. */
export const DETAIL_MASK_MARGIN_PX = 12;
/** A masked label returns only once it clears the margin by this much more (no flicker). */
export const DETAIL_MASK_HYSTERESIS_PX = 10;

/** Whether `rect` (grown by `margin`) touches the circle. */
export function rectHitsCircle(rect: MaskRect, c: MaskCircle, margin: number): boolean {
  const nx = Math.max(rect.x, Math.min(c.x, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(c.y, rect.y + rect.h));
  const r = c.r + margin;
  return (nx - c.x) ** 2 + (ny - c.y) ** 2 <= r * r;
}
/** Whether two rects overlap once `a` is grown by `margin`. */
export function rectHitsRect(a: MaskRect, b: MaskRect, margin: number): boolean {
  return (
    a.x - margin < b.x + b.w &&
    a.x + a.w + margin > b.x &&
    a.y - margin < b.y + b.h &&
    a.y + a.h + margin > b.y
  );
}
/**
 * Ids of the non-focused labels to hide. A label already hidden (`prev`) stays hidden
 * until it clears by margin + hysteresis. Zero-size rects (not laid out) are ignored.
 */
export function detailLabelMask(
  labels: readonly MaskLabel[],
  focusId: string,
  silhouette: MaskCircle | null,
  panels: readonly MaskRect[],
  prev: ReadonlySet<string> = new Set(),
  margin: number = DETAIL_MASK_MARGIN_PX,
  hysteresis: number = DETAIL_MASK_HYSTERESIS_PX
): Set<string> {
  const out = new Set<string>();
  for (const l of labels) {
    if (l.id === focusId || l.rect.w <= 0 || l.rect.h <= 0) continue;
    const m = prev.has(l.id) ? margin + hysteresis : margin;
    const hit =
      (silhouette !== null && rectHitsCircle(l.rect, silhouette, m)) ||
      panels.some((p) => rectHitsRect(l.rect, p, m));
    if (hit) out.add(l.id);
  }
  return out;
}
/** Stylesheet fading out the masked label rows (sorted ids: stable text, cheap diff). */
export function detailLabelMaskCss(ids: Iterable<string>): string {
  const sorted = [...ids].sort();
  if (sorted.length === 0) return "";
  const sel = sorted.map((id) => `.atomic-labels [data-atom-id="${cssAttrValue(id)}"]`).join(",");
  return `${sel}{opacity:0!important;pointer-events:none!important}`;
}
