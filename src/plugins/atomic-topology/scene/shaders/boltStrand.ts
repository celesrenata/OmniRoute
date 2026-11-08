/**
 * Emissive procedural lightning (TSL): camera-facing ribbons built from the
 * seeded fractal geometry in `boltGeometry.ts`. Geometry lives in a unit bolt
 * space (start (0,0,0) -> end (0,0,1)); per-bolt uniforms A/B place and scale
 * it in world space, so endpoints are always exactly A and B.
 */
import {
  Fn,
  attribute,
  cameraPosition,
  cross,
  exp,
  float,
  length,
  max,
  mix,
  normalize,
  positionWorld,
  select,
  varying,
  vec3,
  vec4,
  uniform,
} from "three/tsl";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from "three/webgpu";
import { buildBolt, type Bolt } from "../boltGeometry";
import { sphereVisibility } from "./raySphere";

export interface BoltUniforms {
  a: ReturnType<typeof uniform>;
  b: ReturnType<typeof uniform>;
  intensity: ReturnType<typeof uniform>;
  occluderCenter: ReturnType<typeof uniform>;
  occluderRadius: ReturnType<typeof uniform>;
}

/** Ribbon geometry (4 vertices per segment) for a bolt in unit bolt space. */
export function boltRibbonGeometry(bolt: Bolt): BufferGeometry {
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
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aOther", new BufferAttribute(other, 3));
  g.setAttribute("aSide", new BufferAttribute(side, 1));
  g.setAttribute("aGen", new BufferAttribute(gen, 1));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

export function createBoltUniforms(): BoltUniforms {
  return {
    a: uniform(new Vector3()),
    b: uniform(new Vector3(0, 0, 1)),
    intensity: uniform(0),
    occluderCenter: uniform(new Vector3()),
    occluderRadius: uniform(10),
  };
}

/** Build core + halo ribbon materials for a bolt's uniforms. */
export function createBoltMaterial(
  u: BoltUniforms,
  opts: {
    halo: boolean;
    color: [number, number, number];
    width: number;
    /** Core width as a fraction of the halo width; > 0 embeds the core in the halo. */
    coreRatio?: number;
  }
): MeshBasicNodeMaterial {
  const A = u.a as any;
  const B = u.b as any;
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
  const width = gw.mul(opts.width);
  const material = new MeshBasicNodeMaterial();
  material.positionNode = P.add(perp.mul(aSide.mul(width)));
  const sideV = varying(aSide);
  const genV = varying(aGen);
  material.fragmentNode = Fn(() => {
    const hot = vec3(...opts.color);
    // Halo ribbons also carry the hot core in their centre (one draw per bolt
    // instead of two overlapping additive ribbons: half the bolt overdraw).
    const s2 = sideV.mul(sideV);
    const coreW = opts.coreRatio ?? 0;
    const haloTerm = hot.mul(exp(s2.mul(-2.2)));
    const coreTerm =
      coreW > 0
        ? mix(hot, vec3(1, 1, 1), 0.3).mul(exp(s2.mul(-1.2 / (coreW * coreW))).mul(2.6 / 2.8))
        : vec3(0);
    const core = opts.halo
      ? haloTerm.add(coreTerm)
      : mix(hot, vec3(1, 1, 1), 0.3).mul(exp(s2.mul(-1.2)));
    const falloff = float(1).div(genV.add(1).mul(0.6).add(0.4));
    const vis = sphereVisibility(
      cameraPosition,
      positionWorld,
      u.occluderCenter as any,
      u.occluderRadius as any
    );
    const k = falloff
      .mul(u.intensity as any)
      .mul(vis)
      .mul(opts.halo ? 2.8 : 2.6);
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

export function createBoltVariants(seed: number, count: number): BufferGeometry[] {
  return Array.from({ length: count }, (_, i) =>
    boltRibbonGeometry(
      buildBolt([0, 0, 0], [0, 0, 1], { seed: seed + i * 7919, levels: 5, branchDepth: 2 })
    )
  );
}

export { Mesh };
