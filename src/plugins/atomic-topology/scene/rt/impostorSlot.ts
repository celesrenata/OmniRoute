/**
 * Per-atom ray-traced impostor (+ mirrored floor reflection) for the batched
 * atom renderer. The impostor fragment is the expensive pass (nucleon ray
 * trace + cloud march), and it is fastest with SMALL per-object uniforms that
 * the GPU keeps in constant registers (a large indexed batch buffer measured
 * ~30 % slower at close range on the M5 Max). So the impostor stays two draws
 * per atom with its own uniform set, while every vertex-heavy layer (strands,
 * sparkles, wires, bolts, flares) is batched across atoms.
 *
 * Imports `three` only via `three/webgpu`.
 */
import { Matrix3, Mesh, PlaneGeometry, Vector3 } from "three/webgpu";
import { createAtomMaterial, createAtomUniforms, type AtomUniforms } from "../shaders/atomImpostor";
import { MAX_NUCLEONS } from "../shaderParams";
import type { RtRegistry } from "./rtRegistry";

type V4Array = { set: (x: number, y: number, z: number, w: number) => void }[];

export interface ImpostorStatic {
  hues: readonly (readonly [number, number, number])[];
  inner: readonly [number, number, number];
  rim: readonly [number, number, number];
  coreColor: readonly [number, number, number];
  axes: readonly (readonly [number, number, number])[];
  lobeKind: readonly [number, number, number];
  peaks: readonly [number, number, number];
  orient: Matrix3;
  tints: Float32Array;
  count: number;
  glassRadius: number;
}

export interface ImpostorDynamic {
  center: Vector3;
  camRight: Vector3;
  camUp: Vector3;
  quadHalf: number;
  cloudRadius: number;
  far: number;
  crowd: number;
  excitation: number;
  saturation: number;
  brightness: number;
  phase: number;
  mediumK: number;
  steps: number;
  weights: readonly [number, number, number];
  reach: number;
  coreColor: readonly [number, number, number];
  floorY: number;
  /** World-space nucleon centres (xyz, radius) packed as vec4. */
  nucleons: Float32Array;
  glassRadius: number;
  /** Small-atom LOD weight (0 full atom .. 1 bold small LOD). */
  lod: number;
}

export interface ImpostorSlot {
  mesh: Mesh;
  mirror: Mesh;
  setStatic: (s: ImpostorStatic) => void;
  update: (d: ImpostorDynamic) => void;
}

let sharedQuad: PlaneGeometry | null = null;

export function createImpostorSlot(registry: RtRegistry): ImpostorSlot {
  if (!sharedQuad) {
    sharedQuad = new PlaneGeometry(2, 2);
    const q = sharedQuad;
    registry.add({
      dispose: () => {
        q.dispose();
        if (sharedQuad === q) sharedQuad = null;
      },
    });
  }
  const u = createAtomUniforms();
  const mu = createAtomUniforms();
  const mat = createAtomMaterial(u);
  const mmat = createAtomMaterial(mu);
  registry.add(mat);
  registry.add(mmat);
  (mu.mirror as any).value = 1;
  const mesh = new Mesh(sharedQuad, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  const mirror = new Mesh(sharedQuad, mmat);
  mirror.frustumCulled = false;
  mirror.renderOrder = 2;
  const both: AtomUniforms[] = [u, mu];

  return {
    mesh,
    mirror,
    setStatic(s) {
      for (const x of both) {
        x.hues.forEach((h, i) =>
          (h.value as Vector3).set(...(s.hues[i] as [number, number, number]))
        );
        x.axes.forEach((a, i) =>
          (a.value as Vector3).set(...(s.axes[i] as [number, number, number]))
        );
        (x.inner.value as Vector3).set(...s.inner);
        (x.rim.value as Vector3).set(...s.rim);
        (x.coreColor.value as Vector3).set(...s.coreColor);
        (x.lobeKind.value as Vector3).set(...s.lobeKind);
        (x.peaks.value as Vector3).set(...s.peaks);
        (x.orient.value as Matrix3).copy(s.orient);
        (x.nucleonCount as any).value = s.count;
        (x.glassRadius as any).value = s.glassRadius;
        const tints = (x.nucleonTints as any).array as V4Array;
        for (let i = 0; i < MAX_NUCLEONS; i += 1) {
          tints[i].set(s.tints[i * 4], s.tints[i * 4 + 1], s.tints[i * 4 + 2], s.tints[i * 4 + 3]);
        }
      }
    },
    update(d) {
      for (let k = 0; k < 2; k += 1) {
        const x = both[k];
        (x.center.value as Vector3).copy(d.center);
        (x.camRight.value as Vector3).copy(d.camRight);
        (x.camUp.value as Vector3).copy(d.camUp);
        (x.quadHalf as any).value = d.quadHalf;
        (x.cloudRadius as any).value = d.cloudRadius;
        (x.glassRadius as any).value = d.glassRadius;
        (x.far as any).value = d.far;
        (x.lod as any).value = d.lod;
        (x.crowd as any).value = d.crowd;
        (x.energy.value as Vector3).set(d.excitation, d.saturation, d.brightness);
        (x.phase as any).value = d.phase;
        (x.mediumK as any).value = d.mediumK;
        (x.steps as any).value = k === 1 ? Math.max(32, Math.round(d.steps * 0.3)) : d.steps;
        (x.weights.value as Vector3).set(d.weights[0], d.weights[1], d.weights[2]);
        (x.reach as any).value = d.reach;
        (x.coreColor.value as Vector3).set(...d.coreColor);
        (x.floorY as any).value = d.floorY;
        const nuc = (x.nucleonCenters as any).array as V4Array;
        const n = (x.nucleonCount as any).value as number;
        for (let i = 0; i < n; i += 1) {
          nuc[i].set(
            d.nucleons[i * 4],
            d.nucleons[i * 4 + 1],
            d.nucleons[i * 4 + 2],
            d.nucleons[i * 4 + 3]
          );
        }
      }
      mesh.position.copy(d.center);
      mirror.position.set(d.center.x, 2 * d.floorY - d.center.y, d.center.z);
    },
  };
}
