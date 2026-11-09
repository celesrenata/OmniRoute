import test from "node:test";
import assert from "node:assert/strict";

import {
  NUCLEUS_GLASS_FACTOR,
  NUCLEUS_GLASS_IOR,
  maxRefractedImageFraction,
} from "../../../src/plugins/atomic-topology/scene/glassOptics.ts";

test("the old 1.32 glass magnified outer nucleons up to the silhouette (the notch)", () => {
  assert.ok(maxRefractedImageFraction(NUCLEUS_GLASS_FACTOR, 1.32) >= 0.999);
});

test("the nucleus glass keeps every nucleon image strictly inside the shell", () => {
  for (const rho of [0.12, 0.22, 0.32]) {
    const f = maxRefractedImageFraction(NUCLEUS_GLASS_FACTOR, NUCLEUS_GLASS_IOR, 1, rho);
    assert.ok(f < 0.97, `rho ${rho}: image reaches ${f.toFixed(3)} of the glass radius`);
  }
});

test("the glass still refracts (a lens, not a plain window)", () => {
  assert.ok(NUCLEUS_GLASS_IOR > 1);
});
