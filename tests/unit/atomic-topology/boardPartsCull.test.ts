import test from "node:test";
import assert from "node:assert/strict";
import { createBoardParts } from "../../../src/plugins/atomic-topology/scene/shaders/boardParts";
import type { BoardExtent } from "../../../src/plugins/atomic-topology/scene/boardComponents";
import type { InstancedMesh } from "three/webgpu";

// Directive 19 (profile phase): board parts / contact shadows outside the frustum are not submitted.
const EXT: BoardExtent = { wallX: 1000, ceilY: 780, nearZ: 2200, farZ: -1100, floorY: -66 };
/** Column-major perspective projection looking down -Z from the origin. */
function perspective(fovDeg: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  return [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ];
}
/** View x projection for a camera at (x, y, z) looking down -Z (pure translation view). */
function viewProj(x: number, y: number, z: number, fov = 20): number[] {
  const p = perspective(fov, 1.6, 10, 8000);
  // P * T(-pos): only the translation column changes.
  const m = [...p];
  m[12] = p[0] * -x;
  m[13] = p[5] * -y;
  m[14] = p[10] * -z + p[14];
  m[15] = p[11] * -z;
  return m;
}
function counts(parts: ReturnType<typeof createBoardParts>): number[] {
  return parts.objects.map((o) => (o as InstancedMesh).count);
}

test("cull(null) keeps every instance; a narrow view draws fewer; null restores the full set", () => {
  const parts = createBoardParts();
  parts.setLayout(EXT, []);
  const full = counts(parts);
  assert.ok(full.reduce((a, b) => a + b, 0) > 100, "layout produced instances");
  assert.equal(
    parts.cull(null),
    full.slice(1).reduce((a, b) => a + b, 0)
  );
  assert.deepEqual(counts(parts), full);
  // Narrow close view toward the far wall: most of the board is outside the frustum.
  const narrow = parts.cull(viewProj(0, 60, 400, 12));
  const drawn = counts(parts);
  assert.ok(narrow < full.slice(1).reduce((a, b) => a + b, 0) * 0.6, "culls most instances");
  assert.ok(drawn[0] < full[0], "contact-shadow decals are culled too");
  // Restoring brings back exactly the original counts.
  parts.cull(null);
  assert.deepEqual(counts(parts), full);
  parts.dispose();
});

test("cull keeps visible instances intact: matrices of the kept set are a subset of the source", () => {
  const parts = createBoardParts();
  parts.setLayout(EXT, []);
  const meshes = parts.objects.slice(1) as InstancedMesh[];
  const key = (m: InstancedMesh, i: number) =>
    Array.from((m.instanceMatrix.array as Float32Array).subarray(i * 16, i * 16 + 16)).join(",");
  const source = meshes.map((m) => new Set(Array.from({ length: m.count }, (_, i) => key(m, i))));
  parts.cull(viewProj(0, 60, 400, 12));
  meshes.forEach((m, k) => {
    for (let i = 0; i < m.count; i += 1) assert.ok(source[k].has(key(m, i)), `mesh ${k} #${i}`);
  });
  parts.dispose();
});

test("cull is idempotent for an unchanged view (no re-upload)", () => {
  const parts = createBoardParts();
  parts.setLayout(EXT, []);
  const vp = viewProj(0, 60, 400, 12);
  parts.cull(vp);
  const mesh = parts.objects[1] as InstancedMesh;
  const v0 = mesh.instanceMatrix.version;
  parts.cull(vp);
  assert.equal(mesh.instanceMatrix.version, v0);
  parts.dispose();
});

test("a view that contains the whole board draws every part", () => {
  const parts = createBoardParts();
  parts.setLayout(EXT, []);
  const total = parts.cull(null);
  const wide = parts.cull(viewProj(0, 400, 3200, 120));
  assert.ok(wide >= total * 0.9, `wide view keeps nearly everything (${wide}/${total})`);
  parts.dispose();
});
