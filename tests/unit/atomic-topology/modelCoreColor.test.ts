import test from "node:test";
import assert from "node:assert/strict";
import { modelCoreColor } from "../../../src/plugins/atomic-topology/scene/rt/atomBatch";
import { packNucleus } from "../../../src/plugins/atomic-topology/scene/nucleonPack";

// Gate B r7: the hot core / glow of an attributed atom carries its model colour.
test("modelCoreColor: saturated, max channel ~1, follows the nucleon tints", () => {
  const packed = packNucleus({ seed: 7, hub: false, observedModelIds: ["gpt-4o"] });
  const c = modelCoreColor(packed);
  assert.equal(c.length, 3);
  for (const v of c) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1.0001);
  assert.ok(Math.max(...c) > 0.9, "normalised to a bright max channel");
  // Dominant channel matches the mean nucleon tint's dominant channel.
  const mean = [0, 0, 0];
  for (let i = 0; i < packed.count; i += 1)
    for (let k = 0; k < 3; k += 1) mean[k] += packed.tints[i * 4 + k];
  assert.equal(c.indexOf(Math.max(...c)), mean.indexOf(Math.max(...mean)));
});

test("modelCoreColor: different models give distinguishable cores", () => {
  const a = modelCoreColor(packNucleus({ seed: 7, hub: false, observedModelIds: ["gpt-4o"] }));
  const b = modelCoreColor(
    packNucleus({ seed: 7, hub: false, observedModelIds: ["claude-sonnet-4"] })
  );
  const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  assert.ok(d > 0.1, `cores should differ, distance ${d.toFixed(3)}`);
});
