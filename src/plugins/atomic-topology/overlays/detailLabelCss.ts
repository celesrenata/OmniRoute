/**
 * Label treatment while the opt-in detail view is open (operator directive 34.2).
 *
 * The inspected atom's DOM label would sit on top of its nucleus (and the panel
 * already names it), so it is hidden; the other labels fade back so the hero
 * shot reads cleanly. This is injected as a stylesheet scoped to the label
 * overlay, so the frozen `AtomicLabels.tsx` is untouched (its rAF loop only
 * writes inline visibility / transform / pointer-events, never display/opacity).
 */
/** Escape a value for use inside a double-quoted CSS attribute selector. */
export function cssAttrValue(raw: string): string {
  return raw.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\n\r\f]/g, " ");
}
/** Stylesheet text hiding `atomId`'s label and fading every other label. */
export function detailLabelCss(atomId: string): string {
  const id = cssAttrValue(atomId);
  return (
    `.atomic-labels [data-atom-id="${id}"]{display:none!important}` +
    `.atomic-labels .atomic-labels__row:not([data-atom-id="${id}"]){opacity:.4}`
  );
}
