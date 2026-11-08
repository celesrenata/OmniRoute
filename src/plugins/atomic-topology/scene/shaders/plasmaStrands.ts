/**
 * Plasma strand field (TSL, Gate A r6): the electron cloud's filaments as real
 * geometry. Thousands of hairline ribbons (baked once in `strandField.ts`,
 * shared by every atom) burst radially from the nucleus in petal bundles; the
 * vertex stage curls, breathes and sizes them in SCREEN space (0.5-1.5 px
 * cores, tapered ends) and the fragment stage gives each an HDR emissive core
 * graded violet/magenta at the root to cyan at the tip. A second mesh of
 * camera-facing quads adds the fine sparkly rim fringe and pink/orange motes.
 *
 * Per frame the CPU only writes a few uniforms per atom (time, energy,
 * camera basis, radius); there is no per-strand CPU work.
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
  uniform,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Matrix3,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from "three/webgpu";
import { bakeSparkles, bakeStrands } from "../strandField";
import { sphereVisibility } from "./raySphere";

export interface StrandUniforms {
  time: ReturnType<typeof uniform>;
  /** Atom centre (world). */
  center: ReturnType<typeof uniform>;
  /** Cloud radius (world units). */
  cloudR: ReturnType<typeof uniform>;
  /** Nucleus radius as a fraction of the cloud radius (strand roots). */
  rootR: ReturnType<typeof uniform>;
  /** World size of one device pixel at unit distance: 2 tan(fov/2) / heightPx. */
  pxScale: ReturnType<typeof uniform>;
  /** x excitation, y saturation, z brightness */
  energy: ReturnType<typeof uniform>;
  /** Fraction of strands lit (idle = fewer). */
  active: ReturnType<typeof uniform>;
  /** Strand reach multiplier (idle = shorter). */
  reach: ReturnType<typeof uniform>;
  orient: ReturnType<typeof uniform>;
  inner: ReturnType<typeof uniform>;
  rim: ReturnType<typeof uniform>;
  root: ReturnType<typeof uniform>;
  camRight: ReturnType<typeof uniform>;
  camUp: ReturnType<typeof uniform>;
  occluderRadius: ReturnType<typeof uniform>;
  floorY: ReturnType<typeof uniform>;
  /** Decorative differential-swirl angle (rad). Never encodes throughput. */
  swirl: ReturnType<typeof uniform>;
  /** 1 = strand lifecycle/flicker live, 0 = static still-rich frame (reduced motion). */
  lifeOn: ReturnType<typeof uniform>;
  /** 0 = close range, 1 = default distance and beyond: lifts density/width/gain so the cloud stays filled. */
  far: ReturnType<typeof uniform>;
}

export function createStrandUniforms(): StrandUniforms {
  return {
    time: uniform(0),
    center: uniform(new Vector3()),
    cloudR: uniform(52),
    rootR: uniform(0.12),
    pxScale: uniform(0.0003),
    energy: uniform(new Vector3(1, 1, 1)),
    active: uniform(1),
    reach: uniform(1),
    orient: uniform(new Matrix3()),
    inner: uniform(new Vector3(0.55, 0.15, 1)),
    rim: uniform(new Vector3(0.1, 0.85, 1)),
    root: uniform(new Vector3(1, 0.4, 0.85)),
    camRight: uniform(new Vector3(1, 0, 0)),
    camUp: uniform(new Vector3(0, 1, 0)),
    occluderRadius: uniform(10),
    floorY: uniform(-62),
    swirl: uniform(0),
    lifeOn: uniform(1),
    far: uniform(0),
    crowd: uniform(1),
  };
}

let sharedStrands: BufferGeometry | null = null;
let sharedSparkles: BufferGeometry | null = null;

/** Shared strand ribbon geometry (GPU buffers re-created after dispose()). */
export function getStrandGeometry(): BufferGeometry {
  if (!sharedStrands) {
    const b = bakeStrands();
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(b.dir, 3));
    g.setAttribute("aShape", new BufferAttribute(b.shape, 4));
    g.setAttribute("aParam", new BufferAttribute(b.param, 4));
    g.setIndex(new BufferAttribute(b.index, 1));
    sharedStrands = g;
  }
  return sharedStrands;
}

/** Shared sparkle quad geometry. */
export function getSparkleGeometry(): BufferGeometry {
  if (!sharedSparkles) {
    const b = bakeSparkles();
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(b.dir, 3));
    g.setAttribute("aShape", new BufferAttribute(b.shape, 4));
    g.setAttribute("aCorner", new BufferAttribute(b.corner, 3));
    g.setIndex(new BufferAttribute(b.index, 1));
    sharedSparkles = g;
  }
  return sharedSparkles;
}

export const strandGeometryDisposable = {
  dispose: () => {
    getStrandGeometry().dispose();
    getSparkleGeometry().dispose();
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
 * Strand ribbons for one atom. `mirror` renders the floor reflection (geometry
 * reflected about the floor plane, dimmer).
 */
export function createStrandMaterial(u: StrandUniforms, mirror = false): MeshBasicNodeMaterial {
  const time = u.time as any;
  const exc = (u.energy as any).x;
  const sat = (u.energy as any).y;
  const bri = (u.energy as any).z;
  const shape = attribute("aShape", "vec4");
  const prm = attribute("aParam", "vec4");
  const d = normalize((u.orient as any).mul(attribute("position", "vec3")));
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
  const root = u.rootR as any;
  // Staggered lifecycle (born -> full -> fades), deterministic from the baked
  // per-strand phase; reach/brightness breathe with it, tips stay on the envelope.
  const lifeRate = fl.mul(1.7).fract().mul(0.06).add(0.035);
  const life = time.mul(lifeRate).add(rank.mul(7.3)).fract();
  const grow = smoothstep(0, 0.28, life).mul(float(1).sub(smoothstep(0.72, 1, life)));
  const gm = mix(float(1), grow, u.lifeOn as any);
  const reach = len
    .mul(u.reach as any)
    .mul(sin(time.mul(0.55).add(fl)).mul(0.05).add(0.95))
    .mul(gm.mul(0.1).add(0.9));
  // Counter-rotating layers with differential swirl (inner faster than outer).
  const layer = select(fl.lessThan(3.1), float(1), float(-0.65));
  const swirlAt = (tt: any) => {
    const a = (u.swirl as any).mul(layer).mul(float(1.3).sub(tt.mul(0.9)));
    return a;
  };
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
  const cloudR = u.cloudR as any;
  const p0 = curve(t).mul(cloudR);
  const p1 = curve(t.add(0.02)).mul(cloudR);
  const tangent = normalize(p1.sub(p0));
  const center = u.center as any;
  const fy = u.floorY as any;
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
  const farV = u.far as any;
  const drawPx = max(widthPx, farV.mul(0.85).add(1.05));
  const lit = step(rank, u.active as any);
  const pxWorld = dist.mul(u.pxScale as any);
  const material = new MeshBasicNodeMaterial();
  material.positionNode = pL.add(perp.mul(side.mul(0.5).mul(drawPx).mul(pxWorld).mul(lit)));
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
    const col0 = mix(u.inner as any, u.rim as any, tip);
    const col = mix(u.root as any, col0, smoothstep(0.0, 0.22, tV));
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
    const vis = sphereVisibility(cameraPosition, positionWorld, center, u.occluderRadius as any);
    // Bright cyan tip cap: strand ends form the luminous silhouette of the cloud.
    const tipCap = smoothstep(0.84, 0.97, tV).mul(1.8).add(1);
    const k = float(0.2)
      .add(exc.mul(0.45))
      .mul(gmV.mul(0.8).add(0.2))
      .mul(tipCap)
      .mul(bri)
      .mul((u.far as any).mul(1.2).add(1))
      .mul(u.crowd as any)
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

/** Sparkle fringe + embedded motes for one atom. */
export function createSparkleMaterial(u: StrandUniforms): MeshBasicNodeMaterial {
  const time = u.time as any;
  const exc = (u.energy as any).x;
  const sat = (u.energy as any).y;
  const bri = (u.energy as any).z;
  const shape = attribute("aShape", "vec4");
  const corner = attribute("aCorner", "vec3");
  const d = normalize((u.orient as any).mul(attribute("position", "vec3")));
  const center = u.center as any;
  const sa = (u.swirl as any).mul(float(1.3).sub(shape.x.mul(0.9)));
  const sc = cos(sa);
  const ss = sin(sa);
  const pr = d
    .mul(shape.x)
    .mul(u.reach as any)
    .mul(u.cloudR as any);
  const pL = vec3(pr.x.mul(sc).add(pr.z.mul(ss)), pr.y, pr.z.mul(sc).sub(pr.x.mul(ss)));
  const dist = length(cameraPosition.sub(center).sub(pL));
  const lit = step(corner.z, u.active as any);
  const sizeWorld = shape.y
    .mul(dist)
    .mul(u.pxScale as any)
    .mul(lit);
  const material = new MeshBasicNodeMaterial();
  material.positionNode = pL
    .add((u.camRight as any).mul(corner.x.mul(sizeWorld)))
    .add((u.camUp as any).mul(corner.y.mul(sizeWorld)));
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
    const col = mix(u.rim as any, moteCol, kindV);
    const vis = sphereVisibility(cameraPosition, positionWorld, center, u.occluderRadius as any);
    const k = dot0
      .mul(tw.mul(0.8).add(0.2))
      .mul(float(0.6).add(exc.mul(1.4)))
      .mul(bri)
      .mul(vis)
      .mul(mix(float(5.5), float(16), kindV))
      .mul((u.far as any).mul(0.5).add(0.8))
      .mul((u.crowd as any).mul(u.crowd as any));
    return vec4(grade(col, sat).mul(k), 1);
  })();
  return finish(material);
}

export interface StrandField {
  strands: Mesh;
  mirror: Mesh;
  sparkles: Mesh;
  materials: MeshBasicNodeMaterial[];
}

export function createStrandField(u: StrandUniforms): StrandField {
  const geo = getStrandGeometry();
  const strandMat = createStrandMaterial(u);
  const mirrorMat = createStrandMaterial(u, true);
  const sparkleMat = createSparkleMaterial(u);
  const strands = new Mesh(geo, strandMat);
  const mirror = new Mesh(geo, mirrorMat);
  const sparkles = new Mesh(getSparkleGeometry(), sparkleMat);
  for (const [m, order] of [
    [strands, 9],
    [mirror, 3],
    [sparkles, 9],
  ] as const) {
    m.frustumCulled = false;
    m.renderOrder = order;
  }
  return { strands, mirror, sparkles, materials: [strandMat, mirrorMat, sparkleMat] };
}
