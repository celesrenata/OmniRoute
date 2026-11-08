/**
 * Batched energy links (TSL, Gate B C2): every hub -> atom route link is one
 * instance of a single screen-space plasma ribbon draw, plus one instance of a
 * single fractal-lightning draw for failure discharges.
 *
 *   ribbon: quadratic Bezier A -> C -> B evaluated in the vertex stage, a
 *     white-hot core inside a lane-hued halo, a gentle plasma wobble (frozen
 *     under reduced motion), up to three travelling packet heads with comet
 *     tails (proven links only; positions come from the pure `filament.ts`
 *     scheduler on the CPU), and the teal completion impulse.
 *   bolt: seeded midpoint-displacement fractal (`boltGeometry.ts`) with
 *     branches, laid along A -> B, white-hot core + red halo, collapsed to zero
 *     area unless the link is in a failure discharge.
 *
 * Per-link data lives in one renderGroup uniform buffer (LINK_FIELDS vec4 per
 * link, one ranged upload per frame). Imports `three` only via three/webgpu.
 */
import {
  Fn,
  attribute,
  buffer,
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
  renderGroup,
  select,
  sin,
  smoothstep,
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
import { buildBolt } from "../boltGeometry";
import { envTime, pxScale } from "../rt/sharedUniforms";

/** vec4 entries per link in the link uniform buffer. */
export const LINK_FIELDS = 6;
export const LINK_SEGMENTS = 96;
export const LINK_BOLT_VARIANTS = 4;

export const LINK_FIELD = {
  A_CORE: 0, // A.xyz (hub end), core width px
  C_HALO: 1, // control.xyz, halo width px
  B_BASE: 2, // B.xyz (atom end), steady base intensity
  COLOR_WOBBLE: 3, // lane rgb, wobble amplitude (fraction of length)
  HEADS: 4, // packet head fractions h0, h1, h2 (< 0 = none), head intensity
  FLASH_BOLT: 5, // flash position, flash intensity, bolt intensity, bolt variant
} as const;

export interface LinkData {
  capacity: number;
  arr: Float32Array;
  node: any;
}

export function createLinkData(capacity: number): LinkData {
  const cap = Math.max(1, Math.floor(capacity));
  const arr = new Float32Array(cap * LINK_FIELDS * 4);
  return {
    capacity: cap,
    arr,
    node: buffer(arr, "vec4", cap * LINK_FIELDS).setGroup(renderGroup),
  };
}

/** Links per layer that fit the backend's uniform-block limit (bytes). */
export function linkCapacityFor(maxUniformBlockBytes: number): number {
  return Math.max(1, Math.min(256, Math.floor(maxUniformBlockBytes / 16 / LINK_FIELDS)));
}

const field = (data: LinkData, link: any, k: number) =>
  data.node.element(int(link).mul(LINK_FIELDS).add(k));

/** Quadratic Bezier and its derivative at t. */
const bez = (A: any, C: any, B: any, t: any) => {
  const u = float(1).sub(t);
  return A.mul(u.mul(u))
    .add(C.mul(u.mul(t).mul(2)))
    .add(B.mul(t.mul(t)));
};
const bezD = (A: any, C: any, B: any, t: any) =>
  C.sub(A)
    .mul(float(1).sub(t).mul(2))
    .add(B.sub(C).mul(t.mul(2)));

/** Canonical ribbon strip: x = t along the link, y = side (-1 | 1). */
export function linkRibbonGeometry(segments = LINK_SEGMENTS): InstancedBufferGeometry {
  const n = segments;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const prm = new Float32Array((n + 1) * 2 * 2);
  const idx = new Uint32Array(n * 6);
  for (let i = 0; i <= n; i += 1) {
    prm.set([i / n, -1], i * 4);
    prm.set([i / n, 1], i * 4 + 2);
  }
  for (let i = 0; i < n; i += 1) {
    const a = i * 2;
    idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aLink", new BufferAttribute(prm, 2));
  g.setIndex(new BufferAttribute(idx, 1));
  g.instanceCount = 0;
  return g;
}

export function createLinkRibbonMaterial(data: LinkData): MeshBasicNodeMaterial {
  const link = int(instanceIndex);
  const f0 = field(data, link, LINK_FIELD.A_CORE);
  const f1 = field(data, link, LINK_FIELD.C_HALO);
  const f2 = field(data, link, LINK_FIELD.B_BASE);
  const f3 = field(data, link, LINK_FIELD.COLOR_WOBBLE);
  const f4 = field(data, link, LINK_FIELD.HEADS);
  const f5 = field(data, link, LINK_FIELD.FLASH_BOLT);
  const A = f0.xyz;
  const C = f1.xyz;
  const B = f2.xyz;
  const aw = attribute("aLink", "vec2");
  const t = aw.x;
  const side = aw.y;
  const P0 = bez(A, C, B, t);
  const tan = normalize(bezD(A, C, B, t));
  const toCam = cameraPosition.sub(P0);
  const dist = length(toCam);
  const perp = normalize(cross(tan, toCam.div(dist)));
  const L = length(B.sub(A));
  // Plasma wobble: two slow travelling sines, zero at both endpoints (the
  // endpoints never move), frozen when the shared env time is frozen.
  const time = envTime as any;
  const ends = smoothstep(0, 0.12, t).mul(smoothstep(1, 0.88, t));
  const wob = sin(t.mul(23).sub(time.mul(1.7)))
    .mul(0.6)
    .add(sin(t.mul(57).add(time.mul(2.3))).mul(0.4))
    .mul(f3.w)
    .mul(L)
    .mul(ends);
  const up = normalize(cross(perp, tan));
  const P = P0.add(up.mul(wob));
  const haloPx = f1.w;
  const widthWorld = haloPx.mul(dist).mul(pxScale as any);
  const material = new MeshBasicNodeMaterial();
  material.positionNode = P.add(perp.mul(side.mul(0.5).mul(widthWorld)));
  const sideV = varying(side);
  const tV = varying(t);
  const coreFrac = varying(f0.w.div(max(haloPx, 1)));
  material.fragmentNode = Fn(() => {
    const s = sideV.abs();
    const core = exp(s.div(max(coreFrac, 0.02)).pow(2).negate());
    const halo = exp(s.mul(s).mul(-3.2)).mul(0.35);
    const lane = f3.xyz;
    const base = f2.w;
    // Packet heads with comet tails (tail trails behind the head toward the hub).
    const packet = (h: any) => {
      const on = h.greaterThanEqual(0);
      const d = tV.sub(h);
      const head = exp(d.div(0.012).pow(2).negate());
      const tail = select(d.lessThan(0), exp(d.div(0.06)), float(0)).mul(0.55);
      return select(on, head.add(tail), float(0));
    };
    const pk = packet(f4.x).add(packet(f4.y)).add(packet(f4.z)).mul(f4.w);
    // Completion impulse (teal) travelling toward the hub.
    const fl = exp(tV.sub(f5.x).div(0.03).pow(2).negate()).mul(f5.y);
    const hot = mix(lane, vec3(1, 1, 1), 0.72);
    const col = hot
      .mul(core)
      .mul(base.mul(1.4).add(pk.mul(3)))
      .add(lane.mul(halo).mul(base.add(pk.mul(2.2))))
      .add(
        vec3(0.18, 0.83, 0.75)
          .mul(core.mul(2.5).add(halo.mul(2)))
          .mul(fl)
      );
    return vec4(col, 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = 2;
  return material;
}

/** All link bolt variants merged into one geometry (unit space, `aVar` tag). */
export function linkBoltGeometry(count = LINK_BOLT_VARIANTS): InstancedBufferGeometry {
  const segs: { a: number[]; b: number[]; gen: number; v: number }[] = [];
  for (let v = 0; v < count; v += 1) {
    const bolt = buildBolt([0, 0, 0], [0, 0, 1], {
      seed: 0x11e7 + v * 104729,
      levels: 5,
      branchDepth: 2,
      roughness: 0.07,
    });
    for (const s of bolt.segments) segs.push({ a: s.a, b: s.b, gen: s.generation, v });
  }
  const n = segs.length;
  const pos = new Float32Array(n * 4 * 3);
  const other = new Float32Array(n * 4 * 3);
  const side = new Float32Array(n * 4);
  const gen = new Float32Array(n * 4);
  const vv = new Float32Array(n * 4);
  const idx = new Uint32Array(n * 6);
  segs.forEach((s, i) => {
    const verts: [number[], number[], number][] = [
      [s.a, s.b, -1],
      [s.a, s.b, 1],
      [s.b, s.a, -1],
      [s.b, s.a, 1],
    ];
    verts.forEach(([p, o, sd], k) => {
      const q = i * 4 + k;
      pos.set(p, q * 3);
      other.set(o, q * 3);
      side[q] = sd;
      gen[q] = s.gen;
      vv[q] = s.v;
    });
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6);
  });
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aOther", new BufferAttribute(other, 3));
  g.setAttribute("aSide", new BufferAttribute(side, 1));
  g.setAttribute("aGen", new BufferAttribute(gen, 1));
  g.setAttribute("aVar", new BufferAttribute(vv, 1));
  g.setIndex(new BufferAttribute(idx, 1));
  g.instanceCount = 0;
  return g;
}

export function createLinkBoltMaterial(data: LinkData): MeshBasicNodeMaterial {
  const link = int(instanceIndex);
  const A = field(data, link, LINK_FIELD.A_CORE).xyz;
  const B = field(data, link, LINK_FIELD.B_BASE).xyz;
  const f5 = field(data, link, LINK_FIELD.FLASH_BOLT);
  const axis = normalize(B.sub(A));
  const L = length(B.sub(A));
  const upRef = select(axis.y.abs().lessThan(0.95), vec3(0, 1, 0), vec3(1, 0, 0));
  const ex = normalize(cross(axis, upRef));
  const ey = cross(axis, ex);
  const toWorld = (p: any) =>
    A.add(ex.mul(p.x.mul(L)))
      .add(ey.mul(p.y.mul(L)))
      .add(axis.mul(p.z.mul(L)));
  const P = toWorld(attribute("position", "vec3"));
  const Q = toWorld(attribute("aOther", "vec3"));
  const aSide = attribute("aSide", "float");
  const aGen = attribute("aGen", "float");
  const aVar = attribute("aVar", "float");
  const dir = normalize(Q.sub(P));
  const toCam = cameraPosition.sub(P);
  const perp = normalize(cross(dir, toCam));
  const widthPx = float(6).div(aGen.add(1).pow(0.5)).add(1.6);
  const widthWorld = widthPx.mul(length(toCam)).mul(pxScale as any);
  const shown = f5.z.greaterThan(0.001).and(aVar.sub(f5.w).abs().lessThan(0.5));
  const material = new MeshBasicNodeMaterial();
  material.positionNode = select(shown, P.add(perp.mul(aSide.mul(widthWorld))), A);
  const sideV = varying(aSide);
  const genV = varying(aGen);
  material.fragmentNode = Fn(() => {
    const s2 = sideV.mul(sideV);
    const red = vec3(1.0, 0.16, 0.12);
    const col = mix(red, vec3(1, 0.85, 0.8), 0.12)
      .mul(exp(s2.mul(-9)).mul(1.6))
      .add(red.mul(exp(s2.mul(-2.2))));
    const falloff = float(1).div(genV.mul(0.7).add(1));
    return vec4(col.mul(falloff).mul(f5.z).mul(3.6), 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = 2;
  return material;
}

export interface LinkLayer {
  data: LinkData;
  ribbon: Mesh;
  bolt: Mesh;
  setCount: (n: number) => void;
  dispose: () => void;
}

export function createLinkLayer(capacity: number): LinkLayer {
  const data = createLinkData(capacity);
  const rg = linkRibbonGeometry();
  const bg = linkBoltGeometry();
  const rm = createLinkRibbonMaterial(data);
  const bm = createLinkBoltMaterial(data);
  const ribbon = new Mesh(rg, rm);
  const bolt = new Mesh(bg, bm);
  ribbon.name = "links";
  bolt.name = "linkBolts";
  for (const m of [ribbon, bolt]) {
    m.frustumCulled = false;
    m.renderOrder = 6;
  }
  bolt.renderOrder = 12;
  return {
    data,
    ribbon,
    bolt,
    setCount(n) {
      const k = Math.min(n, data.capacity);
      rg.instanceCount = k;
      bg.instanceCount = k;
    },
    dispose() {
      rg.dispose();
      bg.dispose();
      rm.dispose();
      bm.dispose();
    },
  };
}
