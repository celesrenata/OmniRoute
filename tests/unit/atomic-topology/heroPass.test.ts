import test from "node:test";
import assert from "node:assert/strict";
import {
  HERO_MASK,
  HERO_Q,
  HERO_Q2,
  packHeroCloud,
  unpackHeroCloud,
} from "../../../src/plugins/atomic-topology/scene/rt/heroUniforms";
import {
  HERO_CLOUD_LAYER,
  HERO_STRAND_LAYER,
  DEFAULT_HERO_SCALE,
  createHeroPass,
  resolveHeroScale,
  resolveHeroStrands,
} from "../../../src/plugins/atomic-topology/scene/rt/heroPass";
import {
  MIRROR_ADD_LAYER,
  MIRROR_OVER_LAYER,
} from "../../../src/plugins/atomic-topology/scene/rt/mirrorPass";

// Directive 44.2: reduced-resolution hero translucency (dev flag, off by default).

test("resolveHeroScale: cloud-only 0.5 by default and in production; ?herores=1 = off", () => {
  assert.equal(DEFAULT_HERO_SCALE, 0.5);
  assert.equal(resolveHeroScale(null, false), 0.5);
  assert.equal(resolveHeroScale("", false), 0.5);
  assert.equal(resolveHeroScale("abc", false), 0.5);
  assert.equal(resolveHeroScale("0", false), 0.5);
  assert.equal(resolveHeroScale("1", false), null);
  assert.equal(resolveHeroScale("2", false), null);
  assert.equal(resolveHeroScale("0.6", false), 0.6);
  assert.equal(resolveHeroScale("0.1", false), 0.25);
  assert.equal(resolveHeroScale("1", true), 0.5);
  assert.equal(resolveHeroScale(null, true), 0.5);
});

test("resolveHeroStrands: hairline strands stay full res unless the dev flag ?herostrands=1", () => {
  assert.equal(resolveHeroStrands(null, false), false);
  assert.equal(resolveHeroStrands("0", false), false);
  assert.equal(resolveHeroStrands("1", false), true);
  assert.equal(resolveHeroStrands("1", true), false);
});

test("packHeroCloud: the packed value is exact in fp32 and round-trips within 1/2047", () => {
  assert.ok(HERO_MASK + HERO_Q * HERO_Q2 + HERO_Q < 2 ** 24);
  for (const hit of [false, true]) {
    for (const a of [0, 0.001, 0.25, 0.5, 0.731, 0.999, 1]) {
      for (const b of [0, 0.1, 0.5, 0.97, 1]) {
        const p = packHeroCloud(a, b, hit);
        assert.equal(Math.fround(p), p, "exact in fp32");
        const u = unpackHeroCloud(p);
        assert.equal(u.nucleusHit, hit);
        assert.ok(Math.abs(u.opacity - a) <= 0.5 / HERO_Q + 1e-9, `opacity ${a}`);
        assert.ok(Math.abs(u.opacityBg - b) <= 0.5 / HERO_Q + 1e-9, `opacityBg ${b}`);
      }
    }
  }
  // Cleared target (0) decodes to "no cloud": full transmittance, no nucleus.
  assert.deepEqual(unpackHeroCloud(0), { opacity: 0, opacityBg: 0, nucleusHit: false });
  // Out-of-range inputs clamp.
  assert.deepEqual(unpackHeroCloud(packHeroCloud(-1, 2, false)), {
    opacity: 0,
    opacityBg: 1,
    nucleusHit: false,
  });
});

test("hero layers are distinct from the main and mirror layers", () => {
  const layers = new Set([
    0,
    MIRROR_OVER_LAYER,
    MIRROR_ADD_LAYER,
    HERO_CLOUD_LAYER,
    HERO_STRAND_LAYER,
  ]);
  assert.equal(layers.size, 5);
});

test("createHeroPass: additive strand composite at the strands' order; none in cloud-only mode", () => {
  const p = createHeroPass(0.5, true);
  try {
    assert.equal(p.scale, 0.5);
    assert.equal(p.strands, true);
    assert.equal(p.objects.length, 1);
    const q = p.objects[0];
    assert.equal(q.renderOrder, 9);
    assert.equal(q.frustumCulled, false);
    const m = q.material as { depthTest: boolean; depthWrite: boolean; transparent: boolean };
    assert.equal(m.depthTest, false);
    assert.equal(m.depthWrite, false);
    assert.equal(m.transparent, true);
  } finally {
    p.dispose();
  }
  const c = createHeroPass(0.5);
  try {
    assert.equal(c.strands, false);
    assert.equal(c.objects.length, 0);
  } finally {
    c.dispose();
  }
});

test("strand field: the hero row leaves the bucket draws and is drawn once by the hero meshes", async () => {
  const { createStrandField } =
    await import("../../../src/plugins/atomic-topology/scene/shaders/plasmaStrands");
  const { createAtomData } = await import("../../../src/plugins/atomic-topology/scene/rt/atomData");
  const field = createStrandField(createAtomData(4), 4);
  const hero = field.meshes.find((m) => m.name === "heroStrands")!;
  const heroMirrors = field.meshes.filter((m) => m.name === "strandMirror");
  assert.ok(hero);
  assert.equal(hero.layers.isEnabled(HERO_STRAND_LAYER), true);
  assert.equal(hero.layers.isEnabled(0), false);
  const strandMeshes = field.meshes.filter((m) => m.name === "strands");
  const drawn = () =>
    strandMeshes.reduce((n, m) => n + (m.geometry as { instanceCount: number }).instanceCount, 0);
  // No hero: every visible row in the buckets, hero meshes off (unchanged default path).
  field.setBuckets([3, 3, 1, -1]);
  assert.equal(drawn(), 3);
  assert.equal(hero.visible, false);
  assert.equal((hero.geometry as { instanceCount: number }).instanceCount, 0);
  // Hero row 1: drawn by the hero meshes only (low-res + its floor reflection).
  field.setBuckets([3, 3, 1, -1], 1);
  assert.equal(drawn(), 2);
  assert.equal(hero.visible, true);
  assert.equal((hero.geometry as { instanceCount: number }).instanceCount, 1);
  assert.equal(
    heroMirrors.some((m) => m.geometry === hero.geometry && m.visible),
    true
  );
  // A culled hero row is not drawn anywhere.
  field.setBuckets([3, 3, 1, -1], 3);
  assert.equal(drawn(), 3);
  assert.equal(hero.visible, false);
  // Back to no hero.
  field.setBuckets([3, 3, 1, -1], -1);
  assert.equal(drawn(), 3);
  assert.equal(hero.visible, false);
});
