import test from "node:test";
import assert from "node:assert/strict";
import {
  BOKEH_TRIM_DEFAULT,
  resolveBokehTrim,
} from "../../../src/plugins/atomic-topology/scene/shaders/motes";

// Profile phase: the directive 33 bokeh trim is a visible change, so it is gated until signed off.
test("bokeh trim is OFF by default (approved look unchanged until the operator signs off)", () => {
  assert.equal(BOKEH_TRIM_DEFAULT, false);
  assert.equal(resolveBokehTrim(null, false), false);
  assert.equal(resolveBokehTrim("", false), false);
  assert.equal(resolveBokehTrim(null, true), false);
});

test("bokeh trim: dev builds can A/B it; production always uses the default", () => {
  assert.equal(resolveBokehTrim("1", false), true);
  assert.equal(resolveBokehTrim("0", false), false);
  assert.equal(resolveBokehTrim("yes", false), false);
  assert.equal(resolveBokehTrim("1", true), BOKEH_TRIM_DEFAULT);
});
