import test from "node:test";
import assert from "node:assert/strict";
import {
  DOF_FULL_K,
  DOF_SHARP_K,
  dofCoc,
} from "../../../src/plugins/atomic-topology/scene/rt/rendererFactory";

// Operator directive 32: blur is a function of CAMERA depth only, sharp near field.
test("dofCoc: sharp from the camera out to the focus range", () => {
  const focus = 600;
  for (const d of [0, 1, 50, 300, 599, focus, focus * DOF_SHARP_K]) {
    assert.equal(dofCoc(d, focus), 0, `depth ${d} must be sharp`);
  }
});

test("dofCoc: ramps smoothly and monotonically beyond the focus range", () => {
  const focus = 600;
  let prev = 0;
  for (let d = focus * DOF_SHARP_K; d <= focus * DOF_FULL_K * 1.5; d += 10) {
    const c = dofCoc(d, focus);
    assert.ok(c >= prev - 1e-12, `non-decreasing at ${d}`);
    prev = c;
  }
  assert.ok(dofCoc(focus * DOF_FULL_K, focus) > 0);
  assert.equal(dofCoc(focus * DOF_FULL_K, focus), dofCoc(focus * 10, focus));
});

test("dofCoc: follows the focus depth (focus view moves the sharp range)", () => {
  const far = 1400;
  assert.ok(dofCoc(far, 400) > 0, "far content blurs when focused near");
  assert.equal(dofCoc(far, 1400), 0, "same depth is sharp when it is the focus");
});
