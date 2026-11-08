/**
 * Batched camera-facing flare sprites (Gate B C7a): per atom an anamorphic
 * equatorial streak, a restrained pink-white core glow and a faint cyan
 * silhouette ring. Replaces three per-atom Sprite objects with two instanced
 * draws: `back` (glow + ring, drawn BEHIND the impostor so the gem stays crisp)
 * and `front` (the streak, over it).
 */
import {
  Fn,
  abs,
  exp,
  float,
  instanceIndex,
  int,
  length,
  positionLocal,
  select,
  smoothstep,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
} from "three/webgpu";
import { atomFields, type AtomData } from "../rt/atomData";

export type FlareLayerKind = "back" | "front";
/** Instances per atom: back = glow + ring, front = streak. */
export const FLARE_PER_ATOM: Record<FlareLayerKind, number> = { back: 2, front: 1 };

export function createFlareMaterial(data: AtomData, layer: FlareLayerKind): MeshBasicNodeMaterial {
  const per = FLARE_PER_ATOM[layer];
  const inst = int(instanceIndex);
  const row = inst.div(per);
  // back: kind 1 = glow, 2 = ring; front: kind 0 = streak.
  const kind = layer === "front" ? int(0) : inst.sub(row.mul(per)).add(1);
  const U = atomFields(data, row, false);
  const cr = U.cloudR;
  const isStreak = kind.equal(0);
  const isGlow = kind.equal(1);
  // Half extents (world units) per kind.
  const hx = select(isStreak, cr.mul(3), select(isGlow, cr.mul(0.31), U.reach.mul(cr).div(0.9)));
  const hy = select(isStreak, cr.mul(0.08), select(isGlow, cr.mul(0.31), U.reach.mul(cr).div(0.9)));
  const x = positionLocal.x;
  const y = positionLocal.y;
  const material = new MeshBasicNodeMaterial();
  material.positionNode = U.center.add(U.camRight.mul(x.mul(hx))).add(U.camUp.mul(y.mul(hy)));
  material.fragmentNode = Fn(() => {
    // uv, not positionLocal: positionLocal follows the overridden world positionNode.
    const q = uv().mul(2).sub(1);
    const p = vec3(q.x, q.y, 0);
    const ax = abs(p.x);
    // Streak: notch the centre so it never washes the nucleus.
    const notch = smoothstep(0.05, 0.17, ax).mul(0.9).add(0.1);
    const sCore = exp(p.y.div(0.08).pow(2).negate())
      .mul(exp(ax.mul(-2.6)))
      .mul(notch);
    const sWide = exp(p.y.div(0.38).pow(2).negate())
      .mul(exp(ax.mul(-5)))
      .mul(0.35)
      .mul(notch);
    const streak = vec3(0.2, 0.8, 1.0)
      .mul(sCore.add(sWide))
      .mul(float(1).sub(ax).max(0))
      .mul(U.streakK);
    // Glow: restrained pink-white inner glow (idea5 core flare).
    const r2 = p.x.mul(p.x).add(p.y.mul(p.y));
    const g = exp(r2.mul(-5))
      .mul(0.9)
      .add(exp(r2.mul(-26)).mul(1.5))
      .add(exp(r2.mul(-110)).mul(1.8));
    const glow = vec3(1.0, 0.5, 0.85).mul(g).mul(U.glowK);
    // Ring: faint cyan rim-light on the cloud outline (closed silhouette).
    const rr = length(p);
    const band = exp(rr.sub(0.9).div(0.014).pow(2).negate())
      .mul(0.1)
      .add(exp(rr.sub(0.9).div(0.07).pow(2).negate()).mul(0.03));
    const ring = vec3(0.1, 0.85, 1.0).mul(band).mul(U.ringK);
    const col = select(isStreak, streak, select(isGlow, glow, ring));
    return vec4(col, 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = 2;
  return material;
}

export interface FlareLayer {
  mesh: Mesh;
  material: MeshBasicNodeMaterial;
  setCount: (atoms: number) => void;
}

export function createFlareLayer(data: AtomData, layer: FlareLayerKind): FlareLayer {
  const plane = new PlaneGeometry(2, 2);
  const geometry = new InstancedBufferGeometry();
  geometry.index = plane.index;
  geometry.setAttribute("position", plane.getAttribute("position"));
  geometry.setAttribute("uv", plane.getAttribute("uv"));
  geometry.instanceCount = 0;
  const material = createFlareMaterial(data, layer);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = layer === "front" ? 13 : 7;
  return {
    mesh,
    material,
    setCount: (atoms: number) => {
      geometry.instanceCount = atoms * FLARE_PER_ATOM[layer];
    },
  };
}
