/**
 * Plasma strand field (TSL, Gate A r6; batched across atoms in Gate B C7a): the
 * electron cloud's filaments as real geometry. Thousands of hairline ribbons
 * (baked once in `strandField.ts`, shared by every atom) burst radially from the
 * nucleus in petal bundles; the vertex stage curls, breathes and sizes them in
 * SCREEN space (0.5-1.5 px cores, tapered ends) and the fragment stage gives each
 * an HDR emissive core graded violet/magenta at the root to cyan at the tip. A
 * second mesh of camera-facing quads adds the fine sparkly rim fringe and
 * pink/orange motes.
 *
 * ONE instanced draw renders the strands of EVERY atom: instance `i` reads atom
 * row `i` from the shared data textures (`rt/atomData.ts`). Per frame the CPU
 * writes one row per atom into a typed array and uploads once; there is no
 * per-strand and no per-object CPU work.
 */
import {
  Fn,
  attribute,
  cameraPosition,
  cos,
  cross,
  dot,
  exp,
  float,
  int,
  length,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  step,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
} from "three/webgpu";
import { bakeSparkles, bakeStrands, SPARKLE_COUNT, STRAND_COUNT } from "../strandField";
import { rankOrder, STRAND_BUCKETS } from "../rt/atomLayout";

/** Per-instance atom row of a bucketed strand/sparkle draw. */
const ROW_ATTRIBUTE = "aRow";
import { atomFields, type AtomData } from "../rt/atomData";
import { floorY } from "../rt/sharedUniforms";
import { sphereVisibility } from "./raySphere";

/** Base (non-instanced) geometries; buckets are views sharing these attributes. */
let strandBase: {
  attrs: Record<string, BufferAttribute>;
  index: BufferAttribute;
  perStrand: number;
  count: number;
} | null = null;
let sparkleBase: {
  attrs: Record<string, BufferAttribute>;
  index: BufferAttribute;
  perStrand: number;
  count: number;
} | null = null;

/**
 * Re-order the index buffer so strands are listed by ascending activation rank.
 * The shader lights a strand iff rank <= active, so the lit set is always an
 * index PREFIX: a draw range over the first q*N strands draws every lit strand
 * and skips the vertex work of the unlit ones (vertex data is unchanged).
 */
function rankSortedIndex(index: Uint32Array, ranks: number[], perStrand: number): Uint32Array {
  const order = rankOrder(ranks);
  const out = new Uint32Array(index.length);
  order.forEach((s, k) =>
    out.set(index.subarray(s * perStrand, (s + 1) * perStrand), k * perStrand)
  );
  return out;
}

function getStrandBase() {
  if (!strandBase) {
    const b = bakeStrands();
    const per = (b.index.length / STRAND_COUNT) | 0;
    const vps = b.vertexCount / STRAND_COUNT;
    const ranks = Array.from({ length: STRAND_COUNT }, (_, i) => b.param[i * vps * 4 + 2]);
    strandBase = {
      attrs: {
        position: new BufferAttribute(b.dir, 3),
        aShape: new BufferAttribute(b.shape, 4),
        aParam: new BufferAttribute(b.param, 4),
      },
      index: new BufferAttribute(rankSortedIndex(b.index, ranks, per), 1),
      perStrand: per,
      count: STRAND_COUNT,
    };
  }
  return strandBase;
}

function getSparkleBase() {
  if (!sparkleBase) {
    const b = bakeSparkles();
    const ranks = Array.from({ length: SPARKLE_COUNT }, (_, i) => b.corner[i * 4 * 3 + 2]);
    sparkleBase = {
      attrs: {
        position: new BufferAttribute(b.dir, 3),
        aShape: new BufferAttribute(b.shape, 4),
        aCorner: new BufferAttribute(b.corner, 3),
      },
      index: new BufferAttribute(rankSortedIndex(b.index, ranks, 6), 1),
      perStrand: 6,
      count: SPARKLE_COUNT,
    };
  }
  return sparkleBase;
}

/** One draw bucket: a geometry view over the first `fraction` of the rank-sorted strands. */
function bucketGeometry(
  base: NonNullable<typeof strandBase>,
  fraction: number,
  capacity: number
): { geometry: InstancedBufferGeometry; rows: InstancedBufferAttribute } {
  const g = new InstancedBufferGeometry();
  for (const [k, v] of Object.entries(base.attrs)) g.setAttribute(k, v);
  g.setIndex(base.index);
  g.setDrawRange(0, Math.ceil(base.count * fraction) * base.perStrand);
  const rows = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  rows.setUsage(DynamicDrawUsage);
  g.setAttribute(ROW_ATTRIBUTE, rows);
  g.instanceCount = 0;
  return { geometry: g, rows };
}

export const strandGeometryDisposable = {
  dispose: () => {
    strandBase = null;
    sparkleBase = null;
  },
};

/** Grade a colour toward grey by saturation (idle fades toward grey). */
const grade = (c: any, sat: any) => {
  const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return pow(max(mix(vec3(l), c, sat), 0.0001), vec3(1.55));
};

function finish(m: MeshBasicNodeMaterial): MeshBasicNodeMaterial {
  m.transparent = true;
  m.blending = AdditiveBlending;
  m.depthWrite = false;
  m.depthTest = false;
  m.side = 2; // DoubleSide
  return m;
}

/**
 * Strand ribbons for every atom. `mirror` renders the floor reflection
 * (geometry reflected about the floor plane, dimmer).
 */
export function createStrandMaterial(data: AtomData, mirror = false): MeshBasicNodeMaterial {
  const U = atomFields(data, int(attribute(ROW_ATTRIBUTE, "float").add(0.5)), false);
  const time = U.phase;
  const exc = U.excitation;
  const sat = U.saturation;
  const bri = U.brightness;
  const shape = attribute("aShape", "vec4");
  const prm = attribute("aParam", "vec4");
  const d = normalize(U.orientMul(attribute("position", "vec3")));
  const len = shape.x;
  const curl = shape.y;
  const wob = shape.z;
  const fl = shape.w;
  const t = prm.x;
  const side = prm.y;
  const rank = prm.z;
  const widthBase = prm.w;
  const upRef = select(d.y.abs().lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0));
  const e1 = normalize(cross(d, upRef));
  const e2 = cross(d, e1);
  const root = U.rootR;
  // Staggered lifecycle (born -> full -> fades), deterministic from the baked
  // per-strand phase; reach/brightness breathe with it, tips stay on the envelope.
  const lifeRate = fl.mul(1.7).fract().mul(0.06).add(0.035);
  const life = time.mul(lifeRate).add(rank.mul(7.3)).fract();
  const grow = smoothstep(0, 0.28, life).mul(float(1).sub(smoothstep(0.72, 1, life)));
  const gm = mix(float(1), grow, U.lifeOn);
  const reach = len
    .mul(U.reach)
    .mul(sin(time.mul(0.55).add(fl)).mul(0.05).add(0.95))
    .mul(gm.mul(0.1).add(0.9));
  // Counter-rotating layers with differential swirl (inner faster than outer).
  const layer = select(fl.lessThan(3.1), float(1), float(-0.65));
  const swirlAt = (tt: any) => U.swirl.mul(layer).mul(float(1.3).sub(tt.mul(0.9)));
  const curve = (tt: any) => {
    const r = root.add(reach.sub(root).mul(tt));
    const bend = curl.mul(tt.mul(tt)).mul(0.5);
    const w1 = sin(
      tt
        .mul(wob)
        .add(time.mul(wob.mul(0.16).add(0.35)))
        .add(fl)
    )
      .mul(0.04)
      .mul(tt);
    const w2 = sin(tt.mul(wob.mul(0.7)).add(fl.mul(1.3)).add(time.mul(0.3)))
      .mul(0.03)
      .mul(tt);
    // Curl bends the direction, but the radius stays r: tips lie on a closed
    // spherical envelope (no fray past the silhouette).
    const bent = normalize(
      d
        .mul(r)
        .add(e1.mul(bend.add(w1)))
        .add(e2.mul(w2))
    ).mul(r);
    const a = swirlAt(tt);
    const c = cos(a);
    const sn = sin(a);
    return vec3(bent.x.mul(c).add(bent.z.mul(sn)), bent.y, bent.z.mul(c).sub(bent.x.mul(sn)));
  };
  const cloudR = U.cloudR;
  const p0 = curve(t).mul(cloudR);
  const p1 = curve(t.add(0.02)).mul(cloudR);
  const tangent = normalize(p1.sub(p0));
  const center = U.center;
  const fy = floorY as any;
  // Mirror: reflect the strand about the floor plane (atom-local coordinates).
  const pL = mirror ? vec3(p0.x, fy.sub(center.y).mul(2).sub(p0.y), p0.z) : p0;
  const tanL = mirror ? vec3(tangent.x, tangent.y.negate(), tangent.z) : tangent;
  const camL = cameraPosition.sub(center);
  const toCam = camL.sub(pL);
  const dist = length(toCam);
  const perp = normalize(cross(tanL, toCam.div(dist)));
  // Hairline in screen space, tapered at both ends.
  const taper = smoothstep(0, 0.1, t).mul(pow(float(1).sub(t), 0.55));
  const widthPx = widthBase.mul(taper.mul(0.8).add(0.2));
  const farV = U.far;
  const drawPx = max(widthPx, farV.mul(0.85).add(1.05));
  const lit = step(rank, U.active);
  const pxWorld = dist.mul(U.pxScale);
  const material = new MeshBasicNodeMaterial();
  // World-space position (the draw has an identity model matrix).
  material.positionNode = center.add(
    pL.add(perp.mul(side.mul(0.5).mul(drawPx).mul(pxWorld).mul(lit)))
  );
  // Energy-conserving thin lines: sub-pixel strands are drawn 1 px wide, dimmer.
  const coverV = varying(widthPx.div(drawPx).mul(lit));
  const gmV = varying(gm);
  const tV = varying(t);
  const sideV = varying(side);
  const flV = varying(fl);
  const frontV = varying(dot(normalize(pL), normalize(camL)));
  material.fragmentNode = Fn(() => {
    const prof = exp(sideV.mul(sideV).mul(-1.8));
    const tip = smoothstep(0.3, 0.85, tV);
    const col0 = mix(U.strandInner, U.rim, tip);
    const col = mix(U.rootColor, col0, smoothstep(0.0, 0.22, tV));
    // Slow per-strand flicker + travelling discharge pulses (brighter when excited).
    const flick = sin(time.mul(flV.mul(0.4).add(2.2)).add(flV.mul(7)))
      .mul(0.5)
      .add(0.5);
    const pulse = pow(
      sin(
        tV
          .mul(12)
          .sub(time.mul(flV.mul(0.3).add(2.4)))
          .add(flV.mul(3))
      )
        .mul(0.5)
        .add(0.5),
      10
    ).mul(exc.mul(1.6));
    // Roots converge on the nucleus: keep them dim so strands never wash the
    // gem (overlap there is ~100x), brightest mid-strand, fading at the tip.
    const fade = smoothstep(0.04, 0.45, tV)
      .mul(0.85)
      .add(0.15)
      .mul(float(1).sub(smoothstep(0.8, 1.0, tV).mul(0.25)));
    // Far half of the cloud sits behind the plasma body: dimmer (depth cue).
    const depth = smoothstep(-0.8, 0.6, frontV).mul(0.7).add(0.3);
    const vis = sphereVisibility(cameraPosition, positionWorld, center, U.occluderR);
    // Bright cyan tip cap: strand ends form the luminous silhouette of the cloud.
    const tipCap = smoothstep(0.84, 0.97, tV).mul(1.8).add(1);
    const k = float(0.2)
      .add(exc.mul(0.45))
      .mul(gmV.mul(0.8).add(0.2))
      .mul(tipCap)
      .mul(bri)
      .mul(U.far.mul(1.2).add(1))
      .mul(U.strandCrowd)
      .mul(flick.mul(0.55).add(0.45).add(pulse))
      .mul(fade)
      .mul(depth)
      .mul(coverV)
      .mul(prof)
      .mul(vis)
      .mul(mirror ? 0.28 : 1);
    return vec4(grade(col, sat).mul(k).mul(0.8), 1);
  })();
  return finish(material);
}

/** Sparkle fringe + embedded motes for every atom. */
export function createSparkleMaterial(data: AtomData): MeshBasicNodeMaterial {
  const U = atomFields(data, int(attribute(ROW_ATTRIBUTE, "float").add(0.5)), false);
  const time = U.phase;
  const exc = U.excitation;
  const sat = U.saturation;
  const bri = U.brightness;
  const shape = attribute("aShape", "vec4");
  const corner = attribute("aCorner", "vec3");
  const d = normalize(U.orientMul(attribute("position", "vec3")));
  const center = U.center;
  const sa = U.swirl.mul(float(1.3).sub(shape.x.mul(0.9)));
  const sc = cos(sa);
  const ss = sin(sa);
  const pr = d.mul(shape.x).mul(U.reach).mul(U.cloudR);
  const pL = vec3(pr.x.mul(sc).add(pr.z.mul(ss)), pr.y, pr.z.mul(sc).sub(pr.x.mul(ss)));
  const dist = length(cameraPosition.sub(center).sub(pL));
  const lit = step(corner.z, U.sparkleActive);
  const sizeWorld = shape.y.mul(dist).mul(U.pxScale).mul(lit);
  const material = new MeshBasicNodeMaterial();
  material.positionNode = center
    .add(pL)
    .add(U.camRight.mul(corner.x.mul(sizeWorld)))
    .add(U.camUp.mul(corner.y.mul(sizeWorld)));
  const cV = varying(corner.xy);
  const twV = varying(shape.z);
  const kindV = varying(shape.w);
  material.fragmentNode = Fn(() => {
    const r2 = dot(cV, cV);
    const dot0 = exp(r2.mul(-5.5));
    const tw = pow(
      sin(time.mul(twV.mul(0.5).add(1.6)).add(twV.mul(9)))
        .mul(0.5)
        .add(0.5),
      3
    );
    // Motes alternate hot pink / orange; the rim fringe stays cyan.
    const moteCol = mix(vec3(1.0, 0.35, 0.65), vec3(1.0, 0.55, 0.2), twV.mul(3).fract());
    const col = mix(U.rim, moteCol, kindV);
    const vis = sphereVisibility(cameraPosition, positionWorld, center, U.occluderR);
    const k = dot0
      .mul(tw.mul(0.8).add(0.2))
      .mul(float(0.6).add(exc.mul(1.4)))
      .mul(bri)
      .mul(vis)
      .mul(mix(float(5.5), float(16), kindV))
      .mul(U.far.mul(0.5).add(0.8))
      .mul(U.sparkleGain);
    return vec4(grade(col, sat).mul(k), 1);
  })();
  return finish(material);
}

export interface StrandField {
  /** Every bucket mesh (strands, mirror strands, sparkles), for the scene graph. */
  meshes: Mesh[];
  materials: MeshBasicNodeMaterial[];
  geometries: InstancedBufferGeometry[];
  /**
   * Assign atom rows to buckets (bucket index per row). Uploads the per-bucket
   * row lists only when membership actually changed.
   */
  setBuckets: (bucketOfRow: readonly number[]) => void;
}

export function createStrandField(data: AtomData, capacity: number): StrandField {
  const strandMat = createStrandMaterial(data);
  const mirrorMat = createStrandMaterial(data, true);
  const sparkleMat = createSparkleMaterial(data);
  const sb = getStrandBase();
  const pb = getSparkleBase();
  const meshes: Mesh[] = [];
  const geometries: InstancedBufferGeometry[] = [];
  const buckets = STRAND_BUCKETS.map((f) => {
    const s = bucketGeometry(sb, f, capacity);
    const p = bucketGeometry(pb, f, capacity);
    geometries.push(s.geometry, p.geometry);
    const strands = new Mesh(s.geometry, strandMat);
    const mirror = new Mesh(s.geometry, mirrorMat);
    const sparkles = new Mesh(p.geometry, sparkleMat);
    for (const [m, order, name] of [
      [strands, 9, "strands"],
      [mirror, 3, "strandMirror"],
      [sparkles, 9, "sparkles"],
    ] as const) {
      m.frustumCulled = false;
      m.renderOrder = order;
      m.name = name;
      meshes.push(m);
    }
    return { s, p, last: "" };
  });
  const lists: number[][] = STRAND_BUCKETS.map(() => []);
  return {
    meshes,
    materials: [strandMat, mirrorMat, sparkleMat],
    geometries,
    setBuckets(bucketOfRow) {
      lists.forEach((l) => (l.length = 0));
      bucketOfRow.forEach((b, row) => lists[Math.min(Math.max(b, 0), lists.length - 1)].push(row));
      // Sparkles carry the closed cyan rim silhouette: never LOD'd, every row
      // draws the full rank-sorted sparkle set (bucket "1").
      const all = bucketOfRow.length;
      const last = buckets.length - 1;
      buckets.forEach((bk, i) => {
        const key = `${lists[i].join(",")}|${all}`;
        if (key === bk.last) return;
        bk.last = key;
        const s = bk.s;
        const sArr = s.rows.array as Float32Array;
        lists[i].forEach((r, k) => (sArr[k] = r));
        s.rows.needsUpdate = true;
        s.geometry.instanceCount = lists[i].length;
        const pArr = bk.p.rows.array as Float32Array;
        const pn = i === last ? all : 0;
        for (let k = 0; k < pn; k += 1) pArr[k] = k;
        bk.p.rows.needsUpdate = true;
        bk.p.geometry.instanceCount = pn;
      });
    },
  };
}
