import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NOISE_SIZE,
  bakeNoiseVoxels,
  createAtomUniforms,
  getNoiseTexture,
  noiseTextureDisposable,
} from "../../../src/plugins/atomic-topology/scene/shaders/atomImpostor";
import { MAX_WIRES } from "../../../src/plugins/atomic-topology/scene/shaderParams";
import { orbitWires } from "../../../src/plugins/atomic-topology/scene/orbitalDensity";
import {
  advanceAnimationPhase,
  energyFromActivity,
} from "../../../src/plugins/atomic-topology/scene/energyState";
import { modelColor } from "../../../src/plugins/atomic-topology/visualEncoding";

describe("baked filament noise volume", () => {
  it("is deterministic, full-size RGBA8 and not degenerate", () => {
    const a = bakeNoiseVoxels();
    const b = bakeNoiseVoxels();
    assert.equal(a.length, NOISE_SIZE ** 3 * 4);
    assert.deepEqual(a, b);
    let min = 255;
    let max = 0;
    let sum = 0;
    for (const v of a) {
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    assert.ok(min < 8 && max > 247, "uses the full byte range");
    assert.ok(Math.abs(sum / a.length - 127.5) < 3, "mean is centred so ridges are unbiased");
  });

  it("is shared and survives dispose() (GPU copy is re-created on demand)", () => {
    const t = getNoiseTexture();
    assert.equal(getNoiseTexture(), t);
    noiseTextureDisposable.dispose();
    assert.equal(getNoiseTexture(), t);
    assert.equal((t.image as { width: number }).width, NOISE_SIZE);
  });
});

describe("denser orbital wires", () => {
  it("clamps to MAX_WIRES and stays inside the cloud envelope", () => {
    assert.ok(MAX_WIRES >= 14);
    assert.equal(orbitWires(7, 99).length, MAX_WIRES);
    for (const w of orbitWires(7, MAX_WIRES)) {
      assert.ok(w.a > 0 && w.b > 0 && w.b < w.a);
    }
  });
});

describe("demo lane palette", () => {
  const hue = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b);
    const d = mx - Math.min(r, g, b);
    if (d === 0) return 0;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  it("3-model bench ids hash to well-separated production colours", () => {
    const hs = ["qwen3.5-35b", "llama-3.3-70b", "kimi-k2"].map((m) => hue(modelColor(m)));
    for (let i = 0; i < 3; i += 1) {
      for (let j = i + 1; j < 3; j += 1) {
        const d = Math.abs(hs[i] - hs[j]);
        assert.ok(Math.min(d, 360 - d) > 50, `hues ${hs[i]} / ${hs[j]} too close`);
      }
    }
  });
});

describe("reduced motion", () => {
  it("holds the animation phase and zeroes speed", () => {
    assert.equal(advanceAnimationPhase(3, 0.1, 1, true), 3);
    assert.equal(energyFromActivity(1, true, true).speedMul, 0);
  });
});
describe("absorbing plasma medium", () => {
  it("defaults to a positive, bounded extinction so the cloud occludes the room", () => {
    const k = (createAtomUniforms().mediumK as unknown as { value: number }).value;
    assert.ok(k > 0 && k < 1, `mediumK ${k} out of range`);
  });
});
