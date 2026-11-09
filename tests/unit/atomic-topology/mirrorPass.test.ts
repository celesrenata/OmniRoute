import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MIRROR_SCALE,
  resolveMirrorScale,
  MIRROR_ADD_LAYER,
  MIRROR_OVER_LAYER,
  createMirrorPass,
  mirrorLayerOf,
  mirrorTargetSize,
} from "../../../src/plugins/atomic-topology/scene/rt/mirrorPass";
import { Group, Mesh, MeshBasicNodeMaterial, PlaneGeometry } from "three/webgpu";

// Profile phase (directive 41 experiment): the reduced-resolution floor reflection.

test("mirrorLayerOf: only the two mirror mesh kinds move offscreen, each to its own layer", () => {
  assert.equal(mirrorLayerOf("impostorMirror"), MIRROR_OVER_LAYER);
  assert.equal(mirrorLayerOf("strandMirror"), MIRROR_ADD_LAYER);
  assert.notEqual(MIRROR_OVER_LAYER, MIRROR_ADD_LAYER);
  for (const n of ["impostor", "strands", "sparkles", "wires", "atomDepth", "", "board-ic"]) {
    assert.equal(mirrorLayerOf(n), null, n);
  }
});

test("mirrorTargetSize: scales the drawing buffer, clamps the scale, never below 1 px", () => {
  assert.deepEqual(mirrorTargetSize(3200, 2000, 0.5), [1600, 1000]);
  assert.deepEqual(mirrorTargetSize(3196, 1996, 0.5), [1598, 998]);
  assert.deepEqual(mirrorTargetSize(3200, 2000, 2), [3200, 2000]);
  assert.deepEqual(mirrorTargetSize(1, 1, 0.01), [1, 1]);
});

test("createMirrorPass: composites over (order 2) and additive (order 3), no depth", () => {
  const pass = createMirrorPass(0.5);
  try {
    assert.equal(pass.objects.length, 2);
    const [over, add] = pass.objects;
    assert.equal(over.renderOrder, 2);
    assert.equal(add.renderOrder, 3);
    for (const q of pass.objects) {
      const m = q.material as MeshBasicNodeMaterial;
      assert.equal(m.depthTest, false);
      assert.equal(m.depthWrite, false);
      assert.equal(q.frustumCulled, false);
    }
    const root = new Group();
    const names = ["impostorMirror", "strandMirror", "impostor", "strands"];
    const meshes = names.map((n) => {
      const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicNodeMaterial());
      mesh.name = n;
      root.add(mesh);
      return mesh;
    });
    pass.assignLayers(root);
    assert.equal(meshes[0].layers.isEnabled(MIRROR_OVER_LAYER), true);
    assert.equal(meshes[0].layers.isEnabled(0), false);
    assert.equal(meshes[1].layers.isEnabled(MIRROR_ADD_LAYER), true);
    assert.equal(meshes[1].layers.isEnabled(0), false);
    assert.equal(meshes[2].layers.isEnabled(0), true);
    assert.equal(meshes[3].layers.isEnabled(0), true);
  } finally {
    pass.dispose();
  }
});

test("resolveMirrorScale: half-res by default; dev override ?mirrorres=1 = full-res inline", () => {
  assert.equal(DEFAULT_MIRROR_SCALE, 0.5);
  assert.equal(resolveMirrorScale(null, false), 0.5);
  assert.equal(resolveMirrorScale("", false), 0.5);
  assert.equal(resolveMirrorScale("1", false), null);
  assert.equal(resolveMirrorScale("2", false), null);
  assert.equal(resolveMirrorScale("0.35", false), 0.35);
  assert.equal(resolveMirrorScale("0.01", false), 0.1);
  assert.equal(resolveMirrorScale("abc", false), 0.5);
  assert.equal(resolveMirrorScale("0", false), 0.5);
  // Production ignores the dev override.
  assert.equal(resolveMirrorScale("1", true), 0.5);
  assert.equal(resolveMirrorScale(null, true), 0.5);
});
