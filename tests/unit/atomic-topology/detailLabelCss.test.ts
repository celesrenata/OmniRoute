/**
 * Step 11 revision (directive 34.2/34.3): label treatment + shared activity vocabulary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  cssAttrValue,
  detailLabelCss,
} from "../../../src/plugins/atomic-topology/overlays/detailLabelCss.ts";
import {
  activityLine,
  deviceVisualStateInput,
} from "../../../src/plugins/atomic-topology/overlays/activityVocabulary.ts";
import { resolveVisualState } from "../../../src/plugins/atomic-topology/visualEncoding.ts";
test("the focused label is hidden and others fade; ids are escaped", () => {
  const css = detailLabelCss("gpu:h:g1");
  assert.match(css, /\[data-atom-id="gpu:h:g1"\]\{display:none!important\}/);
  assert.match(css, /:not\(\[data-atom-id="gpu:h:g1"\]\)\{opacity:/);
  assert.equal(cssAttrValue('a"b\\c'), 'a\\"b\\\\c');
  assert.ok(!detailLabelCss('x"]{}*{').includes('x"]{}'));
});
test("device atom chip state and activity text agree for every tier", () => {
  for (const tier of [0, 1, 2, 3] as const) {
    const state = resolveVisualState(deviceVisualStateInput(tier)).state;
    const line = activityLine(state, tier, null, 0);
    assert.ok(line.startsWith(`${state} · `));
    if (tier === 3) {
      assert.equal(state, "active");
      assert.match(line, /active \(live or measured work\)/);
    } else {
      assert.notEqual(state, "active", "a non-active tier never reads 'active'");
    }
    if (tier === 1) assert.match(line, /^healthy · idle, no measured activity/);
    if (tier === 0) assert.match(line, /^idle · no data/);
  }
});
