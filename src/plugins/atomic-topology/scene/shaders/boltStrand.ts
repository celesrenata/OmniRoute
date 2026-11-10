/**
 * Emissive procedural lightning (TSL): camera-facing ribbons built from the
 * seeded fractal geometry in `boltGeometry.ts`. Geometry lives in a unit bolt
 * space (start (0,0,0) -> end (0,0,1)); per-bolt endpoints A/B place and scale
 * it in world space, so endpoints are always exactly A and B.
 *
 * Batched (Gate B C7a): ONE instanced draw for every bolt slot of every atom
 * (instance `i` = slot `i % 8` of atom row `floor(i / 8)`). The geometry holds
 * all canonical variants back to back (`aVar`); a slot shows only the variant
 * its data texel selects and collapses to zero area when it is not firing. The
 * instance count is fixed per configuration, so a discharge never touches a
 * GPU buffer besides the per-frame atom data texture (re-listing instances
 * per variant caused ~40 ms stalls every flicker on the M5 Max).
 */
import {
  Fn,
  attribute,
  cameraPosition,
  cross,
  exp,
  float,
  instanceIndex,
  int,
  length,
  max,
  mix,
  normalize,
  positionWorld,
  select,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  BufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
} from "three/webgpu";
import { buildBolt, type Bolt } from "../boltGeometry";
import { atomFields, type AtomData } from "../rt/atomData";
import { BOLT_SLOTS_PER_ATOM, BOLT_VARIANT_COUNT } from "../rt/atomLayout";
import { sphereVisibility } from "./raySphere";

/** Halo width (world units) and the embedded white-hot core fraction. */
const BOLT_WIDTH = 0.17;
const BOLT_CORE_RATIO = 0.3;

/** Ribbon geometry (4 vertices per segment) for a bolt in unit bolt space. */
export function boltRibbonGeometry(bolt: Bolt, variant = 0): InstancedBufferGeometry {
  const segs = [...bolt.segments, ...bolt.sparks.map((s) => ({ ...s, generation: 9 }))];
  const n = segs.length;
  const pos = new Float32Array(n * 4 * 3);
  const other = new Float32Array(n * 4 * 3);
  const side = new Float32Array(n * 4);
  const gen = new Float32Array(n * 4);
  const idx = new Uint32Array(n * 6);
  for (let i = 0; i < n; i += 1) {
    const s = segs[i];
    const verts: [number[], number[], number][] = [
      [s.a, s.b, -1],
      [s.a, s.b, 1],
      [s.b, s.a, -1],
      [s.b, s.a, 1],
    ];
    verts.forEach(([p, o, sd], k) => {
      const v = i * 4 + k;
      pos.set(p, v * 3);
      other.set(o, v * 3);
      side[v] = sd;
      gen[v] = s.generation;
    });
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6);
  }
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aOther", new BufferAttribute(other, 3));
  g.setAttribute("aSide", new BufferAttribute(side, 1));
  g.setAttribute("aGen", new BufferAttribute(gen, 1));
  g.setAttribute("aVar", new BufferAttribute(new Float32Array(n * 4).fill(variant), 1));
  g.setIndex(new BufferAttribute(idx, 1));
  g.instanceCount = 0;
  return g;
}

/** Build the batched halo+core ribbon material (colour/endpoints/intensity per instance). */
export function createBoltMaterial(data: AtomData): MeshBasicNodeMaterial {
  const ref = int(instanceIndex);
  const row = ref.div(BOLT_SLOTS_PER_ATOM);
  const slot = ref.sub(row.mul(BOLT_SLOTS_PER_ATOM));
  const U = atomFields(data, row, false);
  const t0 = U.bolt(slot, 0);
  const t1 = U.bolt(slot, 1);
  const t2 = U.bolt(slot, 2);
  const A = t0.xyz;
  const B = t1.xyz;
  const axis = normalize(B.sub(A));
  const L = length(B.sub(A));
  const upRef = select(axis.y.abs().lessThan(0.95), vec3(0, 1, 0), vec3(1, 0, 0));
  const ex = normalize(cross(axis, upRef));
  const ey = cross(axis, ex);
  const toWorld = (p: any) =>
    A.add(ex.mul(p.x.mul(L)))
      .add(ey.mul(p.y.mul(L)))
      .add(axis.mul(p.z.mul(L)));
  const aOther = attribute("aOther", "vec3");
  const aSide = attribute("aSide", "float");
  const aGen = attribute("aGen", "float");
  const P = toWorld(attribute("position", "vec3"));
  const Q = toWorld(aOther);
  const dir = normalize(Q.sub(P));
  const eye = normalize(cameraPosition.sub(P));
  const perp = normalize(cross(dir, eye));
  const isSpark = aGen.greaterThan(8.5);
  const gw = select(isSpark, float(0.55), float(1).div(aGen.add(1).pow(0.6)));
  const width = gw.mul(BOLT_WIDTH);
  // Show only the selected variant of a firing slot; everything else collapses.
  const aVar = attribute("aVar", "float");
  const shown = t0.w.greaterThan(0).and(aVar.sub(t1.w).abs().lessThan(0.5));
  const material = new MeshBasicNodeMaterial();
  material.positionNode = select(shown, P.add(perp.mul(aSide.mul(width))), A);
  const sideV = varying(aSide);
  const genV = varying(aGen);
  material.fragmentNode = Fn(() => {
    const hot = t2.xyz;
    // The halo ribbon also carries the hot core in its centre (one draw per bolt
    // instead of two overlapping additive ribbons: half the bolt overdraw).
    const s2 = sideV.mul(sideV);
    const haloTerm = hot.mul(exp(s2.mul(-2.2)));
    const coreTerm = mix(hot, vec3(1, 1, 1), 0.03).mul(
      exp(s2.mul(-1.2 / (BOLT_CORE_RATIO * BOLT_CORE_RATIO))).mul(2.0 / 2.8)
    );
    const core = haloTerm.add(coreTerm);
    const falloff = float(1).div(genV.add(1).mul(0.6).add(0.4));
    const vis = sphereVisibility(cameraPosition, positionWorld, U.center, U.occluderR);
    const k = falloff.mul(t0.w).mul(vis).mul(1.9);
    return vec4(core.mul(k), 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = 2; // DoubleSide
  void max;
  return material;
}

/** All canonical bolt variants merged into one geometry (tagged by `aVar`). */
export function createBoltGeometry(count = BOLT_VARIANT_COUNT): InstancedBufferGeometry {
  const parts = Array.from({ length: count }, (_, i) =>
    boltRibbonGeometry(
      buildBolt([0, 0, 0], [0, 0, 1], {
        seed: 0xb017 + i * 7919,
        levels: 5,
        branchDepth: 1,
        roughness: 0.14,
      }),
      i
    )
  );
  const names = ["position", "aOther", "aSide", "aGen", "aVar"];
  const out = new InstancedBufferGeometry();
  let vtx = 0;
  let idx = 0;
  for (const p of parts) {
    vtx += p.getAttribute("position").count;
    idx += p.index!.count;
  }
  for (const name of names) {
    const size = parts[0].getAttribute(name).itemSize;
    const arr = new Float32Array(vtx * size);
    let o = 0;
    for (const p of parts) {
      const a = p.getAttribute(name).array as Float32Array;
      arr.set(a, o);
      o += a.length;
    }
    out.setAttribute(name, new BufferAttribute(arr, size));
  }
  const index = new Uint32Array(idx);
  let io = 0;
  let base = 0;
  for (const p of parts) {
    const src = p.index!.array as Uint32Array;
    for (let i = 0; i < src.length; i += 1) index[io + i] = src[i] + base;
    io += src.length;
    base += p.getAttribute("position").count;
    p.dispose();
  }
  out.setIndex(new BufferAttribute(index, 1));
  out.instanceCount = 0;
  return out;
}

export interface BoltLayer {
  mesh: Mesh;
  material: MeshBasicNodeMaterial;
  geometry: InstancedBufferGeometry;
  setCount: (atoms: number) => void;
}

export function createBoltLayer(data: AtomData): BoltLayer {
  const material = createBoltMaterial(data);
  const geometry = createBoltGeometry();
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;
  return {
    mesh,
    material,
    geometry,
    setCount: (atoms: number) => {
      geometry.instanceCount = atoms * BOLT_SLOTS_PER_ATOM;
    },
  };
}

export { Mesh };
