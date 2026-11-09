/**
 * Directive 39.1: neighbour labels over the hero atom / detail panel are masked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detailLabelMask,
  detailLabelMaskCss,
  rectHitsCircle,
  DETAIL_MASK_MARGIN_PX,
  DETAIL_MASK_HYSTERESIS_PX,
} from "../../../src/plugins/atomic-topology/overlays/detailLabelMask.ts";

const SIL = { x: 500, y: 400, r: 200 };
const PANEL = { x: 900, y: 40, w: 220, h: 300 };
const box = (x: number, y: number) => ({ x, y, w: 100, h: 20 });

test("labels over the silhouette or the panel are masked; the focused and clear ones are not", () => {
  const labels = [
    { id: "focus", rect: box(450, 390) },
    { id: "over-atom", rect: box(520, 300) },
    { id: "over-panel", rect: box(950, 100) },
    { id: "clear", rect: box(50, 50) },
    { id: "unlaid", rect: { x: 500, y: 400, w: 0, h: 0 } },
  ];
  const ids = detailLabelMask(labels, "focus", SIL, [PANEL]);
  assert.deepEqual([...ids].sort(), ["over-atom", "over-panel"]);
});

test("the silhouette test uses the closest point of the box plus the margin", () => {
  // Box just right of the circle: gap 5 px < margin -> hit; gap beyond margin -> clear.
  assert.ok(rectHitsCircle(box(705, 390), SIL, DETAIL_MASK_MARGIN_PX));
  assert.ok(!rectHitsCircle(box(700 + DETAIL_MASK_MARGIN_PX + 2, 390), SIL, DETAIL_MASK_MARGIN_PX));
});

test("hysteresis: a masked label returns only once it clears the larger margin", () => {
  const gap = DETAIL_MASK_MARGIN_PX + DETAIL_MASK_HYSTERESIS_PX / 2;
  const labels = [{ id: "n", rect: box(700 + gap, 390) }];
  assert.equal(detailLabelMask(labels, "f", SIL, []).size, 0, "fresh: outside the margin");
  assert.equal(detailLabelMask(labels, "f", SIL, [], new Set(["n"])).size, 1, "held while masked");
  const far = [
    { id: "n", rect: box(700 + DETAIL_MASK_MARGIN_PX + DETAIL_MASK_HYSTERESIS_PX + 2, 390) },
  ];
  assert.equal(detailLabelMask(far, "f", SIL, [], new Set(["n"])).size, 0);
});

test("no silhouette (behind the camera) still masks the panel area", () => {
  const ids = detailLabelMask([{ id: "p", rect: box(950, 100) }], "f", null, [PANEL]);
  assert.deepEqual([...ids], ["p"]);
});

test("mask css: stable order, escaped ids, empty set yields no rule", () => {
  assert.equal(detailLabelMaskCss([]), "");
  const css = detailLabelMaskCss(["b", 'a"x']);
  assert.ok(css.indexOf('[data-atom-id="a\\"x"]') < css.indexOf('[data-atom-id="b"]'));
  assert.match(css, /\{opacity:0!important;pointer-events:none!important\}$/);
  assert.equal(css, detailLabelMaskCss(['a"x', "b"]));
});
