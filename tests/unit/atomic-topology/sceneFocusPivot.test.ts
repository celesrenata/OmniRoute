/**
 * Atomic topology — orbit pivot + link tube radius (OR-ATOM-002, V2/V4).
 *
 * Pure, three-free behavior:
 *   - `resolveOrbitTarget` (V2): the orbit pivot the camera must revolve
 *     around — the focused atom when one is focused, else the nucleus at the
 *     origin; non-finite coordinates clamp to 0 (never corrupt the pivot).
 *   - `linkTubeRadius` (V4): the pure stroke-width → tube-radius mapping,
 *     preserving the visual-state emphasis order (idle < last/healthy <
 *     error < active) while clamped to a readable band.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveOrbitTarget } from "@/plugins/atomic-topology/scene/sceneContext";
import {
  linkTubeRadius,
  LINK_TUBE_MIN_RADIUS,
  LINK_TUBE_MAX_RADIUS,
  VISUAL_STATE_STYLE,
} from "@/plugins/atomic-topology/visualEncoding";

/* ------------------------------------------------------------------ */
/* resolveOrbitTarget (V2)                                             */
/* ------------------------------------------------------------------ */

test("resolveOrbitTarget: null focus → the nucleus at the origin", () => {
  assert.deepEqual(resolveOrbitTarget(null), [0, 0, 0]);
});

test("resolveOrbitTarget: a focused atom → the orbit pivot is that atom", () => {
  assert.deepEqual(resolveOrbitTarget({ x: 100, y: -200, z: 300 }), [100, -200, 300]);
});

test("resolveOrbitTarget: deterministic — same focus → same pivot", () => {
  const a = resolveOrbitTarget({ x: 42, y: 7, z: -3 });
  const b = resolveOrbitTarget({ x: 42, y: 7, z: -3 });
  assert.deepEqual(a, b);
});

test("resolveOrbitTarget: non-finite coordinates clamp to 0, never corrupt", () => {
  assert.deepEqual(resolveOrbitTarget({ x: Number.NaN, y: Number.POSITIVE_INFINITY, z: 5 }), [
    0, 0, 5,
  ]);
  assert.deepEqual(
    resolveOrbitTarget({ x: Number.NEGATIVE_INFINITY, y: Number.NaN, z: Number.NaN }),
    [0, 0, 0]
  );
});

test("resolveOrbitTarget: finite zero is a real position (not clamped)", () => {
  assert.deepEqual(resolveOrbitTarget({ x: 0, y: 0, z: 0 }), [0, 0, 0]);
});

/* ------------------------------------------------------------------ */
/* linkTubeRadius (V4)                                                 */
/* ------------------------------------------------------------------ */

test("linkTubeRadius: maps the per-state stroke widths to distinct radii", () => {
  const widths = Object.fromEntries(
    Object.entries(VISUAL_STATE_STYLE).map(([state, s]) => [state, s.width])
  ) as Record<string, number>;
  assert.equal(linkTubeRadius(widths.idle), 3);
  assert.equal(linkTubeRadius(widths.last), 4.5);
  assert.equal(linkTubeRadius(widths.healthy), 4.5);
  assert.equal(linkTubeRadius(widths.error), 6);
  assert.equal(linkTubeRadius(widths.active), 7.5);

  // The emphasis order is preserved (idle < last/healthy < error < active).
  assert.ok(linkTubeRadius(widths.idle) < linkTubeRadius(widths.healthy));
  assert.ok(linkTubeRadius(widths.healthy) < linkTubeRadius(widths.error));
  assert.ok(linkTubeRadius(widths.error) < linkTubeRadius(widths.active));
});

test("linkTubeRadius: idle routes read as filaments, not pipes", () => {
  // The screenshot bug: links read as "wide opaque pipes". The idle radius
  // must be a thin filament — well under the old constant 6.
  assert.ok(linkTubeRadius(VISUAL_STATE_STYLE.idle.width) < 4);
  for (const style of Object.values(VISUAL_STATE_STYLE)) {
    const r = linkTubeRadius(style.width);
    assert.ok(r >= LINK_TUBE_MIN_RADIUS && r <= LINK_TUBE_MAX_RADIUS);
  }
});

test("linkTubeRadius: clamps to the sane band", () => {
  assert.equal(linkTubeRadius(0), LINK_TUBE_MIN_RADIUS);
  assert.equal(linkTubeRadius(-3), LINK_TUBE_MIN_RADIUS, "negative clamps to the minimum");
  assert.equal(linkTubeRadius(1e9), LINK_TUBE_MAX_RADIUS, "huge clamps to the maximum");
  assert.equal(linkTubeRadius(Number.NaN), LINK_TUBE_MIN_RADIUS, "non-finite → minimum");
  assert.equal(linkTubeRadius(Number.POSITIVE_INFINITY), LINK_TUBE_MIN_RADIUS, "non-finite -> minimum (never a pipe)");
});

test("linkTubeRadius: deterministic + monotonic non-decreasing in width", () => {
  assert.deepEqual(linkTubeRadius(2.5), linkTubeRadius(2.5));
  for (let w = 0; w <= 10; w += 0.5) {
    assert.ok(linkTubeRadius(w) <= linkTubeRadius(w + 0.5), `monotonic at ${w}`);
  }
});
