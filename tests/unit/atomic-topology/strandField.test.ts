import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SPARKLE_COUNT,
  STRAND_COUNT,
  STRAND_PETALS,
  STRAND_SEGMENTS,
  activeStrandFraction,
  bakeSparkles,
  bakeStrands,
  petalAxes,
} from "../../../src/plugins/atomic-topology/scene/strandField";

describe("plasma strand field bake", () => {
  it("is deterministic and sized for thousands of hairline strands", () => {
    const a = bakeStrands();
    const b = bakeStrands();
    assert.ok(STRAND_COUNT >= 2000);
    assert.equal(a.vertexCount, STRAND_COUNT * (STRAND_SEGMENTS + 1) * 2);
    assert.equal(a.index.length, STRAND_COUNT * STRAND_SEGMENTS * 6);
    assert.deepEqual(a.dir, b.dir);
    assert.deepEqual(a.param, b.param);
    let maxIndex = 0;
    for (const i of a.index) maxIndex = Math.max(maxIndex, i);
    assert.ok(maxIndex < a.vertexCount);
  });

  it("emits unit radial directions, hairline widths and tapered t in [0,1]", () => {
    const s = bakeStrands(200, 8);
    for (let v = 0; v < s.vertexCount; v += 1) {
      const len = Math.hypot(s.dir[v * 3], s.dir[v * 3 + 1], s.dir[v * 3 + 2]);
      assert.ok(Math.abs(len - 1) < 1e-5);
      const t = s.param[v * 4];
      const side = s.param[v * 4 + 1];
      const width = s.param[v * 4 + 3];
      assert.ok(t >= 0 && t <= 1);
      assert.ok(side === -1 || side === 1);
      assert.ok(width >= 0.5 && width <= 1.95, `width ${width}`);
    }
  });

  it("clusters strands into petal bundles with voids between them", () => {
    const s = bakeStrands();
    const axes = petalAxes();
    assert.equal(axes.length, STRAND_PETALS);
    let inBundle = 0;
    const perStrand = (STRAND_SEGMENTS + 1) * 2;
    for (let k = 0; k < STRAND_COUNT; k += 1) {
      const v = k * perStrand;
      const d = [s.dir[v * 3], s.dir[v * 3 + 1], s.dir[v * 3 + 2]];
      const best = Math.max(...axes.map((a) => a[0] * d[0] + a[1] * d[1] + a[2] * d[2]));
      if (best > 0.9) inBundle += 1;
    }
    // Most strands sit tightly in a petal (a uniform field would put ~13 * 5% there).
    assert.ok(inBundle / STRAND_COUNT > 0.55, `bundle fraction ${inBundle / STRAND_COUNT}`);
  });

  it("bakes deterministic sparkle quads", () => {
    const a = bakeSparkles();
    assert.equal(a.vertexCount, SPARKLE_COUNT * 4);
    assert.deepEqual(a.shape, bakeSparkles().shape);
  });

  it("lights fewer strands in the idle (lower energy) state, never none", () => {
    const idle = activeStrandFraction(0.05, 0.35);
    const excited = activeStrandFraction(1, 1);
    assert.ok(idle > 0.2 && idle < excited);
    assert.equal(excited, 1);
    assert.equal(activeStrandFraction(Number.NaN, Number.POSITIVE_INFINITY), 0.3);
  });
});
