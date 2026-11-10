/**
 * Batched energy links and discharges (TSL, Gate B C2 + directive 22). Every
 * hub -> atom route link is one instance of each draw below; nothing is built
 * per frame beyond one ranged uniform upload.
 *
 *   ribbon  : the always-visible LIVING FILAMENT. A thin white-hot core braided
 *     with three counter-moving plasma strands inside a faint corona, with a
 *     travelling shimmer and gentle noise warp (frozen under reduced motion).
 *     Active proven links add packet heads with comet trails and short
 *     micro-arcs crawling along the filament. After a strike the filament keeps
 *     a decaying residual-ionisation afterglow in the strike colour.
 *   bolt    : stepped-leader / dielectric-breakdown channels (`leaderBolt.ts`)
 *     with multi-generation thinning branches, revealed by the advancing leader
 *     tip, then a return stroke and decaying re-strikes along a subtly MUTATED
 *     channel. White-hot core, coloured corona, soft volumetric glow in screen
 *     space; HDR into bloom. Failure = violent red, completion = crisp
 *     cyan/green. Collapsed to zero area (and not drawn) unless a strike is live.
 *   flare   : attachment flash + ionisation ring at both endpoint shells.
 *   sparks  : ballistic streak sparks thrown off both endpoints at each stroke.
 *   floor   : the strike's light cast onto the circuit-board floor.
 *
 * The strike timeline (`strikeTimeline.ts`) is shared with the CPU gate, and a
 * strike is only ever booked from an event edge (honesty gates unchanged).
 * Per-link data lives in one renderGroup uniform buffer (LINK_FIELDS vec4 per
 * link). Imports `three` only via three/webgpu.
 */
import {
  Fn,
  attribute,
  buffer,
  cameraPosition,
  clamp,
  cross,
  dot,
  exp,
  float,
  floor,
  fract,
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
  sqrt,
  step,
  varying,
  vec2,
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
import { buildLeaderBolt } from "../leaderBolt";
import { STRIKE_PROFILES } from "../strikeTimeline";
import { envTime, floorY, pxScale } from "../rt/sharedUniforms";

/** vec4 entries per link in the link uniform buffer. */
export const LINK_FIELDS = 8;
export const LINK_SEGMENTS = 96;
export const LINK_BOLT_VARIANTS = 6;
/** Sparks thrown per endpoint per strike. */
export const LINK_SPARKS = 14;

export const LINK_FIELD = {
  A_CORE: 0, // A.xyz (hub end), core width px
  C_HALO: 1, // control.xyz, halo width px
  B_BASE: 2, // B.xyz (atom end), steady base intensity
  COLOR_WOBBLE: 3, // lane rgb, wobble amplitude (fraction of length)
  HEADS: 4, // packet head fractions h0, h1, h2 (< 0 = none), head intensity
  FLASH_BOLT: 5, // flash position, flash intensity, (unused), (unused)
  STRIKE: 6, // strike age s (< 0 none), kind (+1 failure, +2 completion, negative = soft tint only), intensity, seed
  STRIKE2: 7, // hub shell radius, atom shell radius, link hash, 0
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

const hash11 = (x: any) => fract(sin(x.mul(12.9898)).mul(43758.5453));
const FAIL = STRIKE_PROFILES.failure;
const COMP = STRIKE_PROFILES.completion;
const TAU = Math.PI * 2;

/** Per-instance strike inputs shared by every layer's materials. */
function strikeInputs(data: LinkData, link: any) {
  const S = field(data, link, LINK_FIELD.STRIKE);
  const S2 = field(data, link, LINK_FIELD.STRIKE2);
  const kind = S.y;
  const isFail = kind.abs().lessThan(1.5);
  const hard = kind.greaterThan(0.5);
  const soft = kind.lessThan(-0.5);
  return { S, S2, age: S.x, kind, K: S.z, seed: S.w, isFail, hard, soft };
}

/** Leader duration for a kind. */
const leaderOf = (isFail: any) => select(isFail, float(FAIL.leaderS), float(COMP.leaderS));

/** Sum of decaying return strokes at `age` (0 before the leader completes). */
const strokeEnv = (age: any, isFail: any) => {
  const leader = leaderOf(isFail);
  const decay = select(isFail, float(FAIL.strokeDecay), float(COMP.strokeDecay));
  let e: any = float(0);
  for (let i = 0; i < 4; i += 1) {
    const off = select(
      isFail,
      float(FAIL.strokeOffsets[i] ?? 99),
      float(COMP.strokeOffsets[i] ?? 99)
    );
    const amp = select(isFail, float(FAIL.strokeAmps[i] ?? 0), float(COMP.strokeAmps[i] ?? 0));
    const t = age.sub(leader).sub(off);
    e = e.add(select(t.greaterThanEqual(0), amp.mul(exp(t.mul(decay).negate())), float(0)));
  }
  return e;
};

/** Number of strokes already fired (drives the subtle channel mutation). */
const strokesFired = (age: any, isFail: any) => {
  const leader = leaderOf(isFail);
  let n: any = float(0);
  for (let i = 0; i < 4; i += 1) {
    const off = select(
      isFail,
      float(FAIL.strokeOffsets[i] ?? 99),
      float(COMP.strokeOffsets[i] ?? 99)
    );
    n = n.add(step(leader.add(off), age));
  }
  return n;
};

/** Smooth residual-ionisation afterglow (never strobes). */
const glowOf = (age: any, isFail: any) => {
  const leader = leaderOf(isFail);
  const tau = select(isFail, float(FAIL.glowTauS), float(COMP.glowTauS));
  return clamp(age.div(leader), 0, 1).mul(exp(max(age.sub(leader), 0).div(tau).negate()));
};

const STRIKE_FAIL_CORONA = vec3(1.0, 0.1, 0.07);
const STRIKE_FAIL_CORE = vec3(1.0, 0.9, 0.85);
const STRIKE_OK_CORONA = vec3(0.08, 0.95, 0.72);
const STRIKE_OK_CORE = vec3(0.88, 1.0, 1.0);

export function createLinkRibbonMaterial(data: LinkData): MeshBasicNodeMaterial {
  const link = int(instanceIndex);
  const f0 = field(data, link, LINK_FIELD.A_CORE);
  const f1 = field(data, link, LINK_FIELD.C_HALO);
  const f2 = field(data, link, LINK_FIELD.B_BASE);
  const f3 = field(data, link, LINK_FIELD.COLOR_WOBBLE);
  const f4 = field(data, link, LINK_FIELD.HEADS);
  const f5 = field(data, link, LINK_FIELD.FLASH_BOLT);
  const st = strikeInputs(data, link);
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
  // Plasma warp: three travelling sines (zero at both endpoints; frozen when
  // the shared env time is frozen) so the filament writhes gently, never rigidly.
  const time = envTime as any;
  const ends = smoothstep(0, 0.12, t).mul(smoothstep(1, 0.88, t));
  const wob = sin(t.mul(23).sub(time.mul(1.7)))
    .mul(0.5)
    .add(sin(t.mul(57).add(time.mul(2.3))).mul(0.32))
    .add(sin(t.mul(131).sub(time.mul(3.1)).add(f2.x.mul(0.01))).mul(0.18))
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
  const ageV = varying(st.age);
  const kindV = varying(st.kind);
  const KV = varying(st.K);
  const seedV = varying(f2.x.add(f2.y).mul(0.013).add(float(instanceIndex).mul(1.7)));
  material.fragmentNode = Fn(() => {
    const s = sideV;
    const as = s.abs();
    const lane = f3.xyz;
    const base = f2.w;
    const tm = time;
    // Thin white-hot core + faint corona.
    const core = exp(as.div(max(coreFrac, 0.02)).pow(2).negate());
    const corona = exp(as.mul(as).mul(-4.2)).mul(0.22);
    // Three braided plasma strands that converge at both endpoints.
    const conv = smoothstep(0.0, 0.1, tV)
      .mul(smoothstep(1.0, 0.9, tV))
      .mul(0.46);
    const braid = (k: number, sp: number, ph: number) => {
      const off = sin(tV.mul(k).add(tm.mul(sp)).add(ph).add(seedV)).mul(conv);
      return exp(s.sub(off).div(0.085).pow(2).negate());
    };
    const strands = braid(71, 1.3, 0)
      .add(braid(113, -1.9, 2.1))
      .add(braid(167, 2.7, 4.3));
    // Travelling shimmer (cheap noise): the filament breathes unevenly.
    const shimmer = float(0.7)
      .add(sin(tV.mul(190).sub(tm.mul(7)).add(seedV.mul(3))).mul(0.18))
      .add(sin(tV.mul(47).add(tm.mul(2.1)).add(seedV)).mul(0.12));
    // Packet heads with comet tails (proven links only; CPU scheduler).
    const packet = (h: any) => {
      const on = h.greaterThanEqual(0);
      const d = tV.sub(h);
      const head = exp(d.div(0.011).pow(2).negate());
      const bloom = exp(d.div(0.03).pow(2).negate()).mul(0.4);
      const tail = select(d.lessThan(0), exp(d.div(0.07)), float(0)).mul(0.5);
      return select(on, head.add(bloom).add(tail), float(0));
    };
    const pk = packet(f4.x).add(packet(f4.y)).add(packet(f4.z)).mul(f4.w);
    // Micro-arcs crawling along an active filament (short, jittery, bright).
    const act = step(0, max(max(f4.x, f4.y), f4.z));
    let arcs: any = float(0);
    for (let k = 0; k < 3; k += 1) {
      const m = fract(
        tm
          .mul(0.31 + 0.13 * k)
          .add(seedV.mul(0.37))
          .add(k * 0.37)
      );
      const prof = exp(tV.sub(m).div(0.02).pow(2).negate());
      const jit = sin(
        tV
          .mul(430)
          .add(tm.mul(61))
          .add(k * 2.3)
      ).mul(0.62);
      arcs = arcs.add(prof.mul(exp(s.sub(jit).div(0.1).pow(2).negate())));
    }
    arcs = arcs.mul(act).mul(f4.w);
    // Completion impulse (cyan-green) travelling toward the hub.
    const fl = exp(tV.sub(f5.x).div(0.03).pow(2).negate()).mul(f5.y);
    // Strike ionisation: hard strikes light the filament with each stroke and a
    // decaying residual glow; soft (reduced-motion) strikes are a steady tint.
    const sAge = ageV;
    const strikeCol = select(st.isFail, STRIKE_FAIL_CORONA, STRIKE_OK_CORONA);
    const strikeHot = select(st.isFail, STRIKE_FAIL_CORE, STRIKE_OK_CORE);
    const live = kindV.abs().greaterThan(0.5).and(sAge.greaterThanEqual(0));
    const glowK = select(live, glowOf(sAge, st.isFail), float(0)).mul(KV);
    const strokeK = select(
      kindV.greaterThan(0.5).and(sAge.greaterThanEqual(0)),
      strokeEnv(sAge, st.isFail),
      float(0)
    ).mul(KV);
    const hot = mix(lane, vec3(1, 1, 1), 0.72);
    const body = core.mul(1.15).add(strands.mul(0.5)).add(corona);
    const col = hot
      .mul(body)
      .mul(shimmer)
      .mul(base.mul(1.25).add(pk.mul(3.2)))
      .add(lane.mul(strands.mul(0.55).add(corona.mul(1.6))).mul(base.add(pk.mul(1.8))))
      .add(hot.mul(arcs).mul(3.4))
      .add(
        vec3(0.12, 0.92, 0.72)
          .mul(core.mul(2.5).add(corona.mul(5)))
          .mul(fl)
      )
      .add(strikeCol.mul(core.mul(1.4).add(strands.mul(0.7)).add(corona.mul(3))).mul(glowK))
      .add(strikeHot.mul(core).mul(strokeK).mul(2.6));
    return vec4(col, 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = 2;
  return material;
}

/**
 * All strike channel variants merged into one geometry (unit space, tagged by
 * `aVar`): stepped-leader channels with `aGen` (branch generation) and
 * `aBirth` (when the advancing leader tip reaches the segment).
 */
export function linkBoltGeometry(count = LINK_BOLT_VARIANTS): InstancedBufferGeometry {
  const segs: {
    a: number[];
    b: number[];
    gen: number;
    birth: number;
    v: number;
  }[] = [];
  for (let v = 0; v < count; v += 1) {
    const bolt = buildLeaderBolt({
      seed: 0x11e7 + v * 104729,
      step: 0.036 + (v % 3) * 0.006,
      eta: 2.2 + (v % 4) * 0.5,
      persistence: 0.3 + (v % 3) * 0.1,
      branchDepth: 3,
      maxSegments: 300,
    });
    for (const sg of bolt.segments) {
      segs.push({ a: sg.a, b: sg.b, gen: sg.generation, birth: sg.birth, v });
    }
  }
  const n = segs.length;
  const pos = new Float32Array(n * 4 * 3);
  const other = new Float32Array(n * 4 * 3);
  const side = new Float32Array(n * 4);
  const gen = new Float32Array(n * 4);
  const birth = new Float32Array(n * 4);
  const vv = new Float32Array(n * 4);
  const idx = new Uint32Array(n * 6);
  segs.forEach((sg, i) => {
    const verts: [number[], number[], number][] = [
      [sg.a, sg.b, -1],
      [sg.a, sg.b, 1],
      [sg.b, sg.a, -1],
      [sg.b, sg.a, 1],
    ];
    verts.forEach(([p, o, sd], k) => {
      const q = i * 4 + k;
      pos.set(p, q * 3);
      other.set(o, q * 3);
      side[q] = sd;
      gen[q] = sg.gen;
      birth[q] = sg.birth;
      vv[q] = sg.v;
    });
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6);
  });
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aOther", new BufferAttribute(other, 3));
  g.setAttribute("aSide", new BufferAttribute(side, 1));
  g.setAttribute("aGen", new BufferAttribute(gen, 1));
  g.setAttribute("aBirth", new BufferAttribute(birth, 1));
  g.setAttribute("aVar", new BufferAttribute(vv, 1));
  g.setIndex(new BufferAttribute(idx, 1));
  g.instanceCount = 0;
  return g;
}

export function createLinkBoltMaterial(data: LinkData): MeshBasicNodeMaterial {
  const link = int(instanceIndex);
  const A = field(data, link, LINK_FIELD.A_CORE).xyz;
  const B = field(data, link, LINK_FIELD.B_BASE).xyz;
  const st = strikeInputs(data, link);
  const axis = normalize(B.sub(A));
  const L = length(B.sub(A));
  const upRef = select(axis.y.abs().lessThan(0.95), vec3(0, 1, 0), vec3(1, 0, 0));
  const ex = normalize(cross(axis, upRef));
  const ey = cross(axis, ex);
  // Subtle channel mutation between strokes: a position-keyed lateral warp whose
  // phase steps with each re-strike (same input position -> same offset, so the
  // channel stays connected). Endpoints are pinned.
  const mp = st.seed.add(strokesFired(st.age, st.isFail).mul(0.37));
  const disp = (p: any) => {
    const dx = sin(dot(p, vec3(31.7, 17.3, 43.1)).add(mp.mul(3.1)));
    const dy = sin(dot(p, vec3(13.9, 41.3, 23.7)).add(mp.mul(5.3)));
    const e = smoothstep(0.0, 0.05, p.z).mul(smoothstep(1.0, 0.95, p.z));
    return vec3(dx, dy, 0).mul(e.mul(0.016));
  };
  const toWorld = (p: any) => {
    const q = p.add(disp(p));
    return A.add(ex.mul(q.x.mul(L)))
      .add(ey.mul(q.y.mul(L)))
      .add(axis.mul(q.z.mul(L)));
  };
  const P = toWorld(attribute("position", "vec3"));
  const Q = toWorld(attribute("aOther", "vec3"));
  const aSide = attribute("aSide", "float");
  const aGen = attribute("aGen", "float");
  const aBirth = attribute("aBirth", "float");
  const aVar = attribute("aVar", "float");
  const dir = normalize(Q.sub(P));
  const toCam = cameraPosition.sub(P);
  const perp = normalize(cross(dir, toCam));
  const baseW = select(st.isFail, float(11), float(7));
  const widthPx = baseW.div(aGen.add(1).pow(0.9)).add(3);
  const widthWorld = widthPx.mul(length(toCam)).mul(pxScale as any);
  const variant = st.seed.mod(float(LINK_BOLT_VARIANTS));
  // Completion discharges are crisper: only the main channel and first branches.
  const genOk = select(st.isFail, float(1), aGen.lessThan(2).select(float(1), float(0)));
  const shown = st.hard
    .and(st.age.greaterThanEqual(0))
    .and(st.K.greaterThan(0.001))
    .and(aVar.sub(variant).abs().lessThan(0.5))
    .and(genOk.greaterThan(0.5));
  const material = new MeshBasicNodeMaterial();
  material.positionNode = select(shown, P.add(perp.mul(aSide.mul(widthWorld))), A);
  const sideV = varying(aSide);
  const genV = varying(aGen);
  const birthV = varying(aBirth);
  const ageV = varying(st.age);
  const KV = varying(st.K);
  const failV = varying(select(st.isFail, float(1), float(0)));
  const seedV = varying(st.seed);
  material.fragmentNode = Fn(() => {
    const isFail = failV.greaterThan(0.5);
    const leader = leaderOf(isFail);
    const s2 = sideV.mul(sideV);
    // Leader progress reveals segments by birth; the tip glows.
    const lp = clamp(ageV.div(leader), 0, 1);
    const vis = step(birthV, lp);
    const tip = exp(lp.sub(birthV).div(0.05).pow(2).negate()).mul(step(lp, 0.999));
    const post = max(ageV.sub(leader), 0);
    const env = strokeEnv(ageV, isFail).mul(exp(post.mul(genV).mul(2.4).negate()));
    const cc = select(
      ageV.greaterThan(leader),
      float(0.2).mul(exp(post.mul(1.5).negate())),
      float(0)
    );
    const pre = select(ageV.lessThan(leader), float(0.24), float(0));
    const flick = float(0.68).add(
      hash11(
        birthV
          .mul(91.7)
          .add(floor(ageV.mul(48)))
          .add(seedV)
      ).mul(0.32)
    );
    const thin = float(1).div(genV.mul(0.75).add(1));
    const I = vis
      .mul(env.add(cc).add(pre).add(tip.mul(1.5)))
      .mul(flick)
      .mul(thin)
      .mul(KV);
    const corona = select(isFail, STRIKE_FAIL_CORONA, STRIKE_OK_CORONA);
    const hotCol = select(isFail, STRIKE_FAIL_CORE, STRIKE_OK_CORE);
    // White-hot core, coloured corona, soft volumetric glow.
    const coreP = exp(s2.mul(-34));
    const coronaP = exp(s2.mul(-5.5));
    const glowP = exp(sideV.abs().mul(-2.2)).mul(0.22);
    const col = hotCol
      .mul(coreP)
      .mul(I)
      .mul(6.0)
      .add(corona.mul(coronaP).mul(I).mul(2.6))
      .add(corona.mul(glowP).mul(I).mul(1.0));
    return vec4(col, 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = 2;
  return material;
}

/** Billboard quads at both endpoints: attachment flash + ionisation ring at the shells. */
export function linkFlareGeometry(): InstancedBufferGeometry {
  const pos = new Float32Array(8 * 3);
  const end = new Float32Array(8);
  const corner = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  const idx = new Uint32Array(12);
  for (let e = 0; e < 2; e += 1) {
    corner.forEach((c, k) => {
      pos.set([c[0], c[1], 0], (e * 4 + k) * 3);
      end[e * 4 + k] = e;
    });
    const b = e * 4;
    idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], e * 6);
  }
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aEnd", new BufferAttribute(end, 1));
  g.setIndex(new BufferAttribute(idx, 1));
  g.instanceCount = 0;
  return g;
}

export function createLinkFlareMaterial(data: LinkData): MeshBasicNodeMaterial {
  const link = int(instanceIndex);
  const A = field(data, link, LINK_FIELD.A_CORE).xyz;
  const B = field(data, link, LINK_FIELD.B_BASE).xyz;
  const st = strikeInputs(data, link);
  const corner = attribute("position", "vec3");
  const aEnd = attribute("aEnd", "float");
  const center = mix(A, B, aEnd);
  const radius = mix(st.S2.x, st.S2.y, aEnd).mul(1.35);
  const toCam = normalize(cameraPosition.sub(center));
  const right = normalize(cross(vec3(0, 1, 0), toCam));
  const upv = cross(toCam, right);
  const live = st.hard.and(st.age.greaterThanEqual(0)).and(st.K.greaterThan(0.001));
  const size = select(live, radius, float(0));
  const material = new MeshBasicNodeMaterial();
  material.positionNode = center
    .add(right.mul(corner.x.mul(size)))
    .add(upv.mul(corner.y.mul(size)));
  const uvV = varying(vec2(corner.x, corner.y));
  const ageV = varying(st.age);
  const KV = varying(st.K);
  const failV = varying(select(st.isFail, float(1), float(0)));
  const endV = varying(aEnd);
  material.fragmentNode = Fn(() => {
    const isFail = failV.greaterThan(0.5);
    const r = length(uvV);
    const leader = leaderOf(isFail);
    // Attachment: the hub end ignites when the leader leaves, the atom end when
    // it arrives; both flash on every stroke and fade into a short ionisation bloom.
    const arrive = select(
      endV.greaterThan(0.5),
      smoothstep(leader.mul(0.7), leader, ageV),
      float(1)
    );
    const env = strokeEnv(ageV, isFail).add(
      exp(max(ageV.sub(leader), 0).mul(2.6).negate())
        .mul(step(leader, ageV))
        .mul(0.5)
    );
    const lead = select(
      ageV.lessThan(leader),
      float(0.45).mul(smoothstep(0, 0.02, ageV)),
      float(0)
    );
    const E = env
      .add(lead)
      .mul(arrive)
      .mul(KV)
      .mul(select(endV.greaterThan(0.5), float(1), float(0.55)));
    const coreP = exp(r.mul(r).mul(-42)).mul(7);
    const haloP = exp(r.mul(r).mul(-5)).mul(0.9);
    const ringP = exp(r.sub(0.64).div(0.075).pow(2).negate()).mul(0.9);
    const corona = select(isFail, STRIKE_FAIL_CORONA, STRIKE_OK_CORONA);
    const hotCol = select(isFail, STRIKE_FAIL_CORE, STRIKE_OK_CORE);
    const col = hotCol
      .mul(coreP)
      .add(corona.mul(haloP.add(ringP)))
      .mul(E)
      .mul(smoothstep(1.0, 0.8, r));
    return vec4(col, 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = 2;
  return material;
}

/** Spark streaks: LINK_SPARKS per endpoint, two corners (tail/head) x two sides. */
export function linkSparkGeometry(): InstancedBufferGeometry {
  const total = LINK_SPARKS * 2;
  const pos = new Float32Array(total * 4 * 3);
  const corner = new Float32Array(total * 4 * 2);
  const id = new Float32Array(total * 4);
  const idx = new Uint32Array(total * 6);
  for (let i = 0; i < total; i += 1) {
    const cs = [
      [0, -1],
      [0, 1],
      [1, -1],
      [1, 1],
    ];
    cs.forEach((c, k) => {
      const q = i * 4 + k;
      corner.set(c, q * 2);
      id[q] = i;
    });
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6);
  }
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aCorner", new BufferAttribute(corner, 2));
  g.setAttribute("aSpark", new BufferAttribute(id, 1));
  g.setIndex(new BufferAttribute(idx, 1));
  g.instanceCount = 0;
  return g;
}

const SPARK_LIFE = 0.55;

export function createLinkSparkMaterial(data: LinkData): MeshBasicNodeMaterial {
  const link = int(instanceIndex);
  const A = field(data, link, LINK_FIELD.A_CORE).xyz;
  const B = field(data, link, LINK_FIELD.B_BASE).xyz;
  const st = strikeInputs(data, link);
  const corner = attribute("aCorner", "vec2");
  const aSpark = attribute("aSpark", "float");
  const atom = step(float(LINK_SPARKS), aSpark);
  const j = aSpark.sub(atom.mul(LINK_SPARKS));
  const sd = st.seed.mul(0.071);
  const h1 = hash11(j.mul(7.13).add(atom.mul(3.1)).add(sd));
  const h2 = hash11(j.mul(3.77).add(atom.mul(5.9)).add(sd).add(1.7));
  const h3 = hash11(j.mul(5.31).add(atom.mul(1.3)).add(sd).add(4.1));
  const h4 = hash11(j.mul(9.17).add(atom.mul(2.7)).add(sd).add(8.3));
  // Each spark is released by one of the strokes (4 for failure, 2 for completion).
  const nStrokes = select(st.isFail, float(4), float(2));
  const strokeI = floor(h2.mul(nStrokes));
  const leader = leaderOf(st.isFail);
  let offs: any = float(0);
  for (let i = 0; i < 4; i += 1) {
    const o = select(
      st.isFail,
      float(FAIL.strokeOffsets[i] ?? 0),
      float(COMP.strokeOffsets[i] ?? 0)
    );
    offs = offs.add(o.mul(step(float(i), strokeI).mul(step(strokeI, float(i)))));
  }
  const sAge = st.age.sub(leader).sub(offs);
  const z = h1.mul(2).sub(1);
  const ang = h3.mul(TAU);
  const sr = sqrt(max(float(1).sub(z.mul(z)), 0));
  const rd = vec3(sr.mul(ang.cos()), sr.mul(ang.sin()), z);
  const center = mix(A, B, atom);
  const shell = mix(st.S2.x, st.S2.y, atom);
  const speed = float(150).add(h4.mul(300));
  const gravity = vec3(0, -260, 0);
  const posAt = (a: any) => {
    const tt = max(a, 0);
    return center
      .add(rd.mul(shell.mul(0.9)))
      .add(rd.mul(speed.mul(tt)))
      .add(gravity.mul(tt.mul(tt).mul(0.5)));
  };
  const head = posAt(sAge);
  const tail = posAt(sAge.sub(0.045));
  const vel = normalize(head.sub(tail).add(vec3(0, 1e-4, 0)));
  const toCam = cameraPosition.sub(head);
  const perp = normalize(cross(vel, toCam));
  const widthWorld = float(2.4)
    .mul(length(toCam))
    .mul(pxScale as any);
  const alive = st.hard
    .and(st.K.greaterThan(0.001))
    .and(sAge.greaterThan(0))
    .and(sAge.lessThan(SPARK_LIFE));
  const material = new MeshBasicNodeMaterial();
  material.positionNode = select(
    alive,
    mix(tail, head, corner.x).add(perp.mul(corner.y.mul(widthWorld))),
    A
  );
  const sAgeV = varying(sAge);
  const cxV = varying(corner.x);
  const KV = varying(st.K);
  const failV = varying(select(st.isFail, float(1), float(0)));
  material.fragmentNode = Fn(() => {
    const isFail = failV.greaterThan(0.5);
    const fade = exp(sAgeV.mul(-4.5)).mul(float(0.3).add(cxV.mul(0.7)));
    const corona = select(isFail, STRIKE_FAIL_CORONA, STRIKE_OK_CORONA);
    const hotCol = select(isFail, STRIKE_FAIL_CORE, STRIKE_OK_CORE);
    const c = mix(corona, hotCol, exp(sAgeV.mul(-9)));
    return vec4(c.mul(fade).mul(KV).mul(4.2), 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = 2;
  return material;
}

/** The strike's light cast onto the circuit-board floor beneath the channel (and a pool at the atom). */
export function createLinkFloorMaterial(data: LinkData): MeshBasicNodeMaterial {
  const link = int(instanceIndex);
  const A = field(data, link, LINK_FIELD.A_CORE).xyz;
  const C = field(data, link, LINK_FIELD.C_HALO).xyz;
  const B = field(data, link, LINK_FIELD.B_BASE).xyz;
  const st = strikeInputs(data, link);
  const aw = attribute("aLink", "vec2");
  const t = aw.x;
  const side = aw.y;
  const P0 = bez(A, C, B, t);
  const fy = floorY as any;
  const onFloor = vec3(P0.x, fy.add(0.8), P0.z);
  const tn = bezD(A, C, B, t);
  const tf = normalize(vec3(tn.x, 0, tn.z).add(vec3(1e-4, 0, 0)));
  const sideDir = vec3(tf.z.negate(), 0, tf.x);
  const live = st.hard.and(st.age.greaterThanEqual(0)).and(st.K.greaterThan(0.001));
  const width = float(46).add(smoothstep(0.7, 1.0, t).mul(st.S2.y.mul(1.6)));
  const material = new MeshBasicNodeMaterial();
  material.positionNode = select(
    live,
    onFloor.add(sideDir.mul(side.mul(width))),
    vec3(A.x, fy, A.z)
  );
  const sideV = varying(side);
  const tV = varying(t);
  const ageV = varying(st.age);
  const KV = varying(st.K);
  const failV = varying(select(st.isFail, float(1), float(0)));
  material.fragmentNode = Fn(() => {
    const isFail = failV.greaterThan(0.5);
    const env = strokeEnv(ageV, isFail).mul(0.8).add(glowOf(ageV, isFail).mul(0.55));
    const g = exp(sideV.mul(sideV).mul(-3.2));
    const along = float(0.35).add(smoothstep(0.0, 1.0, tV).mul(0.65));
    const c = select(isFail, STRIKE_FAIL_CORONA, STRIKE_OK_CORONA);
    return vec4(c.mul(g).mul(along).mul(env).mul(KV).mul(0.32), 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = 2;
  return material;
}

export interface LinkLayer {
  data: LinkData;
  ribbon: Mesh;
  bolt: Mesh;
  /** Strike-only draws (flare / sparks / floor light); hidden unless a strike is live. */
  fx: Mesh[];
  /** Show the strike-only draws (bolt + fx). Idle links draw only the ribbon. */
  setStrikeVisible: (visible: boolean) => void;
  setCount: (n: number) => void;
  dispose: () => void;
}

export function createLinkLayer(capacity: number): LinkLayer {
  const data = createLinkData(capacity);
  const rg = linkRibbonGeometry();
  const bg = linkBoltGeometry();
  const fg = linkFlareGeometry();
  const sg = linkSparkGeometry();
  const flg = linkRibbonGeometry(24);
  const rm = createLinkRibbonMaterial(data);
  const bm = createLinkBoltMaterial(data);
  const fm = createLinkFlareMaterial(data);
  const sm = createLinkSparkMaterial(data);
  const flm = createLinkFloorMaterial(data);
  const ribbon = new Mesh(rg, rm);
  const bolt = new Mesh(bg, bm);
  const flare = new Mesh(fg, fm);
  const sparks = new Mesh(sg, sm);
  const floorLight = new Mesh(flg, flm);
  ribbon.name = "links";
  bolt.name = "linkBolts";
  flare.name = "linkFlares";
  sparks.name = "linkSparks";
  floorLight.name = "linkFloorLight";
  for (const m of [ribbon, bolt, flare, sparks, floorLight]) m.frustumCulled = false;
  ribbon.renderOrder = 6;
  floorLight.renderOrder = 2;
  bolt.renderOrder = 12;
  flare.renderOrder = 13;
  sparks.renderOrder = 14;
  const fx = [bolt, flare, sparks, floorLight];
  for (const m of fx) m.visible = false;
  return {
    data,
    ribbon,
    bolt,
    fx,
    setStrikeVisible(v) {
      for (const m of fx) m.visible = v;
    },
    setCount(n) {
      const k = Math.min(n, data.capacity);
      rg.instanceCount = k;
      bg.instanceCount = k;
      fg.instanceCount = k;
      sg.instanceCount = k;
      flg.instanceCount = k;
    },
    dispose() {
      for (const g of [rg, bg, fg, sg, flg]) g.dispose();
      for (const m of [rm, bm, fm, sm, flm]) m.dispose();
    },
  };
}
