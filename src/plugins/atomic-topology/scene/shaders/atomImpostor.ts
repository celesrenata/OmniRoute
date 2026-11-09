/**
 * Ray-traced atom impostor (TSL, runs on WebGPU and the WebGL2 backend).
 *
 * One camera-facing quad covers the cloud bounding sphere. The fragment shader
 * builds the world-space view ray and, per pixel:
 *   1. analytically intersects the glass shell, refracts into it;
 *   2. analytically intersects every nucleon sphere (up to 64), shades with
 *      PBR (Fresnel, rough/glossy specular, inner glow), one reflection bounce
 *      against the other nucleons (else the HDRI-style environment), Quilez
 *      analytic sphere ambient-occlusion and soft shadows from the neighbours;
 *   3. ray-marches a true volumetric electron cloud (orbital probability
 *      density |Y_lm|^2 x radial shells, domain-aligned radial plasma
 *      filaments + ridged thin plasma threads, animated), terminated
 *      analytically at the nucleus hit; output is premultiplied HDR.
 */
import {
  Break,
  Fn,
  If,
  Loop,
  atan,
  cameraPosition,
  cos,
  fract,
  sqrt,
  cross,
  dot,
  exp,
  float,
  int,
  interleavedGradientNoise,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  positionLocal,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  refract,
  saturate,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  step,
  uniform,
  uniformArray,
  texture3D,
  ceil,
  floor,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  Data3DTexture,
  LinearFilter,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  MeshBasicNodeMaterial,
  Matrix3,
  Vector3,
  Vector4,
  AdditiveBlending,
  CustomBlending,
} from "three/webgpu";
import { OneFactor, OneMinusSrcAlphaFactor, AddEquation, NoBlending } from "three/webgpu";
import { NUCLEUS_GLASS_IOR } from "../glassOptics";
import { MAX_NUCLEONS } from "../shaderParams";
import {
  HERO_MASK,
  HERO_Q,
  HERO_Q2,
  heroCloudTex,
  heroLowScale,
  heroLowSize,
} from "../rt/heroUniforms";
import { petalAxes } from "../strandField";
import { raySphere, sphereOcclusion, sphereSoftShadow } from "./raySphere";

void AdditiveBlending;

/** Key light direction (towards the light) and colour. */
const KEY_DIR = vec3(-0.45, 0.72, 0.52).normalize();
const KEY_COLOR = vec3(1.0, 0.86, 0.95);

/** Emission gain of the radial plasma petals in the cloud march (idea5 strand body). */
const FIL_GAIN = 0.55;
/** Emission gain of the defined cyan rim shell. */
const RIM_GAIN = 0.8;

/** Edge length (voxels) of the baked, tileable filament-noise volume. */
export const NOISE_SIZE = 64;

/** Deterministic mulberry32 stream (seeded; no Math.random). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Raw RGBA8 white-noise voxels; hardware trilinear filtering makes it value noise. */
export function bakeNoiseVoxels(size = NOISE_SIZE, seed = 0x0a70b1): Uint8Array {
  const rnd = mulberry(seed);
  const data = new Uint8Array(size * size * size * 4);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.floor(rnd() * 256);
  return data;
}

let sharedNoise: Data3DTexture | null = null;
/** Shared baked noise volume (re-uploaded automatically after a dispose()). */
export function getNoiseTexture(): Data3DTexture {
  if (!sharedNoise) {
    const t = new Data3DTexture(bakeNoiseVoxels(), NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
    t.format = RGBAFormat;
    t.type = UnsignedByteType;
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.wrapR = RepeatWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    sharedNoise = t;
  }
  return sharedNoise;
}

const noiseNode = texture3D(getNoiseTexture());

/** Signed baked noise in [-1, 1]; `ch` 0 = x, 1 = y. Explicit LOD (safe in divergent loops). */
const bakedNoise = (p: any, ch: 0 | 1) => {
  const v = noiseNode.sample(p.div(NOISE_SIZE)).level(0);
  return (ch === 0 ? v.x : v.y).mul(2).sub(1);
};
/** 4D stand-in: the 4th coordinate decorrelates along a fixed diagonal. */
const noise4 = (p: any, w: any, ch: 0 | 1 = 0) =>
  bakedNoise(p.add(vec3(0.73, 0.41, 0.57).mul(w)), ch);
void mx_noise_float;

/** Procedural neon studio environment (HDRI substitute), view-direction function. */
export const neonEnvironment = Fn(([dirIn, rough]: [any, any]) => {
  const d = normalize(dirIn);
  const y = d.y;
  const sharp = mix(float(160), float(4), rough);
  const base = mix(vec3(0.004, 0.006, 0.02), vec3(0.035, 0.022, 0.08), y.mul(0.5).add(0.5));
  const lobe = (l: any, col: any, k: number) =>
    pow(max(dot(d, normalize(l)), 0), sharp)
      .mul(col)
      .mul(k);
  const purple = lobe(vec3(-0.75, 0.35, 0.55), vec3(0.65, 0.18, 1.0), 3.2);
  const cyan = lobe(vec3(0.8, 0.2, 0.45), vec3(0.1, 0.8, 1.0), 3.0);
  const top = lobe(vec3(0.1, 1.0, 0.15), vec3(1.0, 0.95, 1.0), 2.6);
  const warm = lobe(vec3(0.15, -0.25, -0.95), vec3(1.0, 0.55, 0.2), 1.6);
  const green = lobe(vec3(0.3, 0.1, -0.9), vec3(0.2, 1.0, 0.45), 1.3);
  const key = lobe(KEY_DIR, KEY_COLOR, 4.0);
  // Vertical "server rack" light strips near the horizon band (reflection detail).
  const az = atan(d.x, d.z);
  const strips = smoothstep(0.82, 1.0, sin(az.mul(11)))
    .mul(smoothstep(0.55, 0.0, y.sub(0.08).abs()))
    .mul(vec3(0.15, 0.55, 0.9))
    .mul(float(1).sub(rough).mul(1.1).add(0.12));
  return base.add(purple).add(cyan).add(top).add(warm).add(green).add(key).add(strips);
});

/** Dispose handle for the shared baked-noise volume (GPU copy re-created on demand). */
export const noiseTextureDisposable = { dispose: () => getNoiseTexture().dispose() };

export interface AtomUniforms {
  center: ReturnType<typeof uniform>;
  camRight: ReturnType<typeof uniform>;
  camUp: ReturnType<typeof uniform>;
  quadHalf: ReturnType<typeof uniform>;
  cloudRadius: ReturnType<typeof uniform>;
  glassRadius: ReturnType<typeof uniform>;
  nucleonCount: ReturnType<typeof uniform>;
  nucleonCenters: ReturnType<typeof uniformArray>;
  nucleonTints: ReturnType<typeof uniformArray>;
  axes: ReturnType<typeof uniform>[];
  lobeKind: ReturnType<typeof uniform>;
  weights: ReturnType<typeof uniform>;
  peaks: ReturnType<typeof uniform>;
  hues: ReturnType<typeof uniform>[];
  coreColor: ReturnType<typeof uniform>;
  /** 0 = close, 1 = default distance and beyond (distance-aware cloud density). */
  far: ReturnType<typeof uniform>;
  /** Projected-size overdraw normaliser: 1 at the default view, <1 when small/crowded. */
  crowd: ReturnType<typeof uniform>;
  /** x excitation, y saturation, z brightness */
  energy: ReturnType<typeof uniform>;
  phase: ReturnType<typeof uniform>;
  steps: ReturnType<typeof uniform>;
  /** Extinction weight of the absorbing plasma medium (deep body, not haze). */
  mediumK: ReturnType<typeof uniform>;
  /** Petal-field orientation (shared with the strand field). */
  orient: ReturnType<typeof uniform>;
  /** Plasma reach (cloud-radius units): body edge follows the strands. */
  reach: ReturnType<typeof uniform>;
  stale: ReturnType<typeof uniform>;
  mirror: ReturnType<typeof uniform>;
  inner: ReturnType<typeof uniform>;
  rim: ReturnType<typeof uniform>;
  floorY: ReturnType<typeof uniform>;
  /** Small-atom LOD weight: 0 = full ray-traced atom, 1 = bold small-size LOD. */
  lod: ReturnType<typeof uniform>;
  /** Focus-view neighbour dim (1 = unchanged); applied by the small-atom LOD. */
  dim: ReturnType<typeof uniform>;
  /** 1 = this atom's cloud comes from the low-res hero pass (directive 44.2), 0 = marched here. */
  heroComposite: ReturnType<typeof uniform>;
}

/** Create the per-atom uniform set (all typed arrays preallocated, no per-frame allocation). */
export function createAtomUniforms(): AtomUniforms {
  const vec4s = Array.from({ length: MAX_NUCLEONS }, () => new Vector4(0, 0, 0, 0));
  const tints = Array.from({ length: MAX_NUCLEONS }, () => new Vector4(1, 1, 1, 0));
  return {
    center: uniform(new Vector3()),
    camRight: uniform(new Vector3(1, 0, 0)),
    camUp: uniform(new Vector3(0, 1, 0)),
    quadHalf: uniform(60),
    cloudRadius: uniform(52),
    glassRadius: uniform(22),
    nucleonCount: uniform(1, "int"),
    nucleonCenters: uniformArray(vec4s, "vec4"),
    nucleonTints: uniformArray(tints, "vec4"),
    axes: [
      uniform(new Vector3(0, 1, 0)),
      uniform(new Vector3(1, 0, 0)),
      uniform(new Vector3(0, 0, 1)),
    ],
    lobeKind: uniform(new Vector3(1, 1, 2)),
    weights: uniform(new Vector3(1, 0.7, 0.5)),
    peaks: uniform(new Vector3(0.5, 0.7, 0.85)),
    hues: [
      uniform(new Vector3(0.4, 0.2, 1)),
      uniform(new Vector3(0.1, 0.7, 1)),
      uniform(new Vector3(0.5, 0.2, 0.9)),
    ],
    coreColor: uniform(new Vector3(0.8, 0.6, 1)),
    far: uniform(0),
    crowd: uniform(1),
    energy: uniform(new Vector3(0.12, 0.35, 0.35)),
    phase: uniform(0),
    steps: uniform(96, "int"),
    mediumK: uniform(0.16),
    orient: uniform(new Matrix3()),
    reach: uniform(1),
    stale: uniform(0),
    mirror: uniform(0),
    inner: uniform(new Vector3(0.62, 0.22, 1)),
    rim: uniform(new Vector3(0.1, 0.85, 1)),
    floorY: uniform(-62),
    lod: uniform(0),
    dim: uniform(1),
    heroComposite: uniform(0),
  };
}

/**
 * Impostor material variants: "main" = the full atom (default); "cloudLow" = only the cloud
 * march of the hero atom, written packed into the low-res hero target (directive 44.2).
 */
export type AtomMaterialVariant = "main" | "cloudLow";

/** Build the impostor material for one atom from its uniforms. */
export function createAtomMaterial(
  u: AtomUniforms,
  variant: AtomMaterialVariant = "main"
): MeshBasicNodeMaterial {
  const nuc = u.nucleonCenters as any;
  const tint = u.nucleonTints as any;
  const count = u.nucleonCount as any;
  const center = u.center as any;
  const excitation = (u.energy as any).x;
  const saturation = (u.energy as any).y;
  const brightness = (u.energy as any).z;

  /** Ray-trace the nucleon ball. Returns vec4(rgb, tHit) with tHit < 0 on a miss. */
  const traceNucleus = Fn(([ro, rd]: [any, any]) => {
    const out = vec4(0, 0, 0, -1).toVar();
    const tBest = float(1e9).toVar();
    const iBest = int(-1).toVar();
    Loop(count, ({ i }: any) => {
      const c = nuc.element(i);
      const h = raySphere(ro, rd, c.xyz, c.w);
      If(h.x.greaterThan(0).and(h.x.lessThan(tBest)), () => {
        tBest.assign(h.x);
        iBest.assign(i);
      });
    });
    If(iBest.greaterThanEqual(0), () => {
      const c = nuc.element(iBest);
      const t4 = tint.element(iBest);
      const albedoRaw = t4.xyz;
      const albedoLuma = dot(albedoRaw, vec3(0.2126, 0.7152, 0.0722));
      const albedo = max(mix(vec3(albedoLuma), albedoRaw, 2.1), 0).mul(
        mix(float(1), saturation.mul(0.5).add(0.5), 1)
      );
      const isP = t4.w;
      const p = ro.add(rd.mul(tBest));
      const nSmooth = normalize(p.sub(c.xyz));
      // Smooth glossy sphere: exact analytic normal (no facet perturbation,
      // which produced the checkerboard / mirror-ball mosaic).
      const n = nSmooth;
      const occ = float(0).toVar();
      const sh = float(1).toVar();
      Loop(count, ({ i: j }: any) => {
        If(j.notEqual(iBest), () => {
          const cj = nuc.element(j);
          occ.addAssign(sphereOcclusion(p, n, cj.xyz, cj.w));
          sh.assign(min(sh, sphereSoftShadow(p.add(n.mul(0.05)), KEY_DIR, cj.xyz, cj.w, float(6))));
        });
      });
      const ao = saturate(float(1).sub(occ.mul(0.5))).max(0.12);
      const ndv = saturate(dot(n, rd.negate()));
      const fres = float(0.045).add(float(0.955).mul(pow(float(1).sub(ndv), 5)));
      const rough = mix(float(0.55), float(0.16), isP);
      const refl = reflect(rd, n);

      // One reflection bounce against the other nucleons, else the environment.
      const bounce = neonEnvironment(refl, rough).toVar();
      const tb = float(1e9).toVar();
      const ib = int(-1).toVar();
      const origin = p.add(n.mul(0.04));
      Loop(count, ({ i: j }: any) => {
        If(j.notEqual(iBest), () => {
          const cj = nuc.element(j);
          const h = raySphere(origin, refl, cj.xyz, cj.w);
          If(h.x.greaterThan(0).and(h.x.lessThan(tb)), () => {
            tb.assign(h.x);
            ib.assign(j);
          });
        });
      });
      If(ib.greaterThanEqual(0), () => {
        const cj = nuc.element(ib);
        const tj = tint.element(ib);
        const pj = origin.add(refl.mul(tb));
        const nj = normalize(pj.sub(cj.xyz));
        bounce.assign(
          tj.xyz
            .mul(neonEnvironment(nj, float(1)).mul(1.4).add(0.18))
            .mul(float(0.55).add(excitation))
        );
      });

      const keyLit = max(dot(n, KEY_DIR), 0).mul(sh);
      const diffuse = albedo.mul(
        neonEnvironment(n, float(1)).mul(1.7).mul(ao).add(KEY_COLOR.mul(keyLit).mul(0.7))
      );
      // Crystalline inner light: warm core glow + bright fresnel-edge scattering.
      const edge = pow(float(1).sub(ndv), 2.2);
      const glow = albedo
        .mul(float(0.25).add(edge.mul(0.55)))
        .mul(mix(float(0.45), float(1), isP))
        .mul(ao.mul(0.6).add(0.4))
        .mul(float(0.25).add(excitation.mul(0.45)));
      const specKey = pow(max(dot(refl, KEY_DIR), 0), mix(float(40), float(260), isP)).mul(
        isP.mul(0.8).add(0.2)
      );
      const color = diffuse
        .mul(0.55)
        .add(glow)
        .add(bounce.mul(fres.mul(1.1).add(0.06)).mul(ao.mul(0.5).add(0.5)))
        .add(KEY_COLOR.mul(specKey).mul(sh).mul(1.4));
      // Internal light: the gem is lit from a hot pink-white core inside the
      // cluster (strongest at the atom centre, through thin facet edges), so it
      // reads as one translucent crystal rather than separate glossy marbles.
      const ext = (u.glassRadius as any).div(1.14);
      const dc = length(p.sub(center)).div(ext);
      const coreLight = exp(dc.mul(dc).mul(-2.0));
      const crystal = mix(albedo, vec3(1.0, 0.3, 0.7), 0.12)
        .mul(coreLight.mul(1.1).add(edge.mul(0.5)))
        .mul(float(0.3).add(excitation.mul(0.9)));
      // Self-illumination in each ball's own model hue (energy-scaled: idle is
      // dim and greys via `saturation`, excited is bright). Hue-preserving, so
      // it never washes the balls to white.
      const emissive = albedo.mul(
        float(0.1)
          .add(excitation.mul(0.38))
          .mul(brightness)
          .mul(float(0.75).add(edge.mul(0.5)))
      );
      const color2 = color.add(crystal).add(emissive);
      const cl = dot(color2, vec3(0.2126, 0.7152, 0.0722));
      const vividRaw = max(mix(vec3(cl), color2, 2.5), 0).mul(0.6);
      // Hue-preserving soft curve: bright channels are scaled down together instead of
      // clipping toward white, so glowing balls stay deeply saturated.
      const vivid = vividRaw
        .div(max(vividRaw.x, max(vividRaw.y, vividRaw.z)).mul(0.5).add(1))
        .mul(1.25);
      out.assign(vec4(vivid, tBest));
    });
    return out;
  });

  /** Closest nucleon hit distance only (no shading); -1 on a miss. Same test as traceNucleus. */
  const nucleusHitT = Fn(([ro, rd]: [any, any]) => {
    const tBest = float(1e9).toVar();
    const hit = float(-1).toVar();
    Loop(count, ({ i }: any) => {
      const c = nuc.element(i);
      const h = raySphere(ro, rd, c.xyz, c.w);
      If(h.x.greaterThan(0).and(h.x.lessThan(tBest)), () => {
        tBest.assign(h.x);
        hit.assign(h.x);
      });
    });
    return hit;
  });

  /** Petal bundle axes (same canonical Fibonacci set as the strand field). */
  const petalAxesN = petalAxes().map(([x, y, z]) =>
    normalize((u.orient as any).mul(vec3(x, y, z)))
  );

  /**
   * Soft deep plasma body at normalised cloud point q (behind the strands).
   * The filaments themselves are real strand geometry (`plasmaStrands.ts`);
   * the march only provides the luminous volume, organised into the SAME 3D
   * petal bundles as the strands (dark voids between petals), a hot core, a
   * faint rim glow and the absorbing medium. One baked-noise sample per step.
   */
  const cloudBody = (q: any) => {
    const r = length(q).max(0.002);
    const dir = q.div(r);
    const phase = u.phase as any;
    const axes = u.axes as any[];
    const kinds = u.lobeKind as any;
    const weights = u.weights as any;
    const peaks = u.peaks as any;
    const kindArr = [kinds.x, kinds.y, kinds.z];
    const wArr = [weights.x, weights.y, weights.z];
    const pArr = [peaks.x, peaks.y, peaks.z];
    // Orbital probability density |Y_lm|^2 (shared by emission and medium).
    const lobeSum = float(0).toVar();
    const hueAcc = vec3(0).toVar();
    for (let k = 0; k < 3; k += 1) {
      const c = dot(dir, axes[k]);
      const c2 = c.mul(c);
      const d2 = pow(c2.mul(3).sub(1), 2).mul(0.25);
      const lobe = mix(c2, d2, step(1.5, kindArr[k]));
      const rad = exp(pow(r.sub(pArr[k]).div(0.42), 2).negate());
      const dk = wArr[k].mul(lobe.add(0.28)).mul(rad.mul(0.8).add(0.2));
      lobeSum.addAssign(dk);
      hueAcc.addAssign((u.hues as any[])[k].mul(dk));
    }
    const hueMix = hueAcc.div(lobeSum.max(0.0001));
    // 3D petal bundles: closeness to the nearest bundle axis.
    let petalMax: any = float(0);
    for (const a of petalAxesN) petalMax = max(petalMax, dot(dir, a));
    const petal = smoothstep(0.9, 0.985, petalMax);
    const churn = noise4(dir.mul(3.1), phase.mul(0.35).add(r.mul(2.3)))
      .mul(0.4)
      .add(0.75);
    const shell = exp(pow(r.sub(0.55).div(0.36), 2).negate());
    const edgeR = u.reach as any;
    const crowdK = u.crowd as any;
    const interior = float(1).sub(smoothstep(edgeR.mul(0.78), edgeR.mul(0.98), r));
    // Radial plasma petals (idea5): noise of the DIRECTION only is constant along
    // the radius, so its zero sheets are radial walls bursting from the nucleus.
    // Seen edge-on they are bright violet-to-cyan strands; between them the body
    // stays dark (petal voids). A finer direction-only octave striates each petal.
    const farK = u.far as any;
    const sheetN = noise4(dir.mul(4.6), phase.mul(0.03), 0);
    const sheet = pow(float(1).sub(sheetN.abs()).max(0), mix(float(15), float(9), farK));
    const striaN = noise4(dir.mul(13.0), phase.mul(0.05).add(3.7), 1);
    const stria = pow(float(1).sub(striaN.abs()).max(0), 5);
    const filEnv = smoothstep(0.07, 0.24, r).mul(
      float(1).sub(smoothstep(edgeR.mul(0.86), edgeR.mul(1.0), r))
    );
    const fil = sheet
      .mul(stria.mul(mix(float(0.8), float(0.45), farK)).add(mix(float(0.35), float(0.6), farK)))
      .mul(filEnv)
      .mul(petal.mul(0.55).add(0.45))
      .mul(float(0.55).add(excitation.mul(0.6)));
    // Dark voids: the diffuse body is carried by the petals, not uniform haze.
    const voidK = pow(float(1).sub(sheetN.abs()).max(0), 3.5).mul(0.85).add(0.1);
    const bodyD = lobeSum
      .mul(voidK)
      .mul(shell)
      .mul(churn)
      .mul(interior)
      .mul(petal.mul(1.0).add(0.015))
      // Inner plume: dense and bright near the nucleus, thinning outward.
      .mul(mix(float(1.9), float(0.55), smoothstep(0.08, 0.7, r)))
      .mul(float(0.5).add(excitation.mul(0.5)))
      .mul((u.far as any).mul(3.2).mul(crowdK.mul(crowdK)).add(1))
      .mul(crowdK.mul(0.5).add(0.5))
      .mul(0.45);
    // Hot core plasma near the nucleus.
    const core = exp(r.mul(r).mul(-90))
      .mul(crowdK.mul(0.45).add(0.55).mul(3.2))
      .add(exp(r.mul(r).mul(-14)).mul(0.25));
    // Faint, churned rim glow (the fine sparkly fringe is instanced geometry).
    const rimBand = exp(pow(r.sub(edgeR.mul(0.84)).div(0.06), 2).negate())
      .mul(churn.sub(0.55).max(0))
      .mul(petal.mul(0.9).add(0.1))
      .mul(0.55);
    const density = bodyD.add(core).add(rimBand);
    const rimT = smoothstep(edgeR.mul(0.78), edgeR.mul(0.96), r);
    const interiorCol = mix(hueMix, u.inner as any, 0.5);
    const rimCol = mix(u.rim as any, hueMix, 0.2);
    const baseCol = mix(interiorCol, rimCol, rimT);
    const hot = saturate(core.mul(0.5));
    const under = smoothstep(-0.1, -0.95, q.y);
    const base = mix(mix(baseCol, vec3(0.1, 0.85, 1.0), under.mul(0.2)), u.coreColor as any, hot);
    const luma = dot(base, vec3(0.2126, 0.7152, 0.0722));
    const graded = pow(max(mix(vec3(luma), base, saturation), 0.0001), vec3(1.7));
    // Absorbing plasma medium: deep violet voids, occludes the room behind.
    const medium = lobeSum
      .mul(shell)
      .mul(churn)
      .mul(interior)
      .mul(petal.mul(0.7).add(0.3))
      .mul(u.mediumK as any);
    const mediumCol = pow(max(mix(vec3(luma), u.inner as any, saturation), 0.0001), vec3(1.6));
    // Filament colour: hot violet-white at the root, violet/magenta mid, cyan tip.
    const filT = smoothstep(0.55, 0.97, r.div(edgeR));
    const filBase = mix(
      mix(vec3(0.95, 0.55, 1.0), u.inner as any, smoothstep(0.08, 0.35, r)),
      u.rim as any,
      filT
    );
    const fl = dot(filBase, vec3(0.2126, 0.7152, 0.0722));
    const filCol = pow(max(mix(vec3(fl), filBase, saturation), 0.0001), vec3(1.35));
    return {
      col: graded
        .mul(density)
        .add(filCol.mul(fil).mul(mix(float(FIL_GAIN), float(FIL_GAIN * 2.8), farK)))
        .add(mediumCol.mul(medium).mul(petal.mul(0.8).add(0.02)).mul(0.4)),
      w: density.add(fil.mul(0.4)),
      // Deeper voids when small on screen: dark violet body behind bright petals.
      m: medium.mul(float(1.6).sub(voidK.mul(0.6))).mul(farK.mul(0.8).add(1)),
    };
  };
  /**
   * The cloud march (emission `acc`, transmittances `trans` / `transBg`), from the cloud entry to
   * the cloud exit or the nucleus hit `tNucV` (< 0 = none). Shared by the full atom and the
   * low-res hero cloud pass, so both march exactly the same samples per pixel.
   */
  const marchCloud = (ro: any, rd: any, tNucV: any, acc: any, trans: any, transBg: any) => {
    const cloudR = u.cloudRadius as any;
    const hc = raySphere(ro, rd, center, cloudR);
    If(hc.y.greaterThan(0), () => {
      const t0 = max(hc.x, 0);
      const t1 = select(tNucV.greaterThan(0), min(hc.y, tNucV), hc.y);
      If(t1.greaterThan(t0), () => {
        // Chord-scaled step count: a constant world-space step length, so short
        // grazing chords near the silhouette take proportionally fewer samples
        // (same per-step quality, ~1/3 fewer samples on average across the disc).
        const maxSteps = float(u.steps as any);
        const stepsF = max(ceil(t1.sub(t0).div(cloudR.mul(2)).mul(maxSteps)), 12);
        const dt = t1.sub(t0).div(stepsF);
        const t = t0.add(dt.mul(interleavedGradientNoise(screenCoordinate.xy))).toVar();
        // Distance-aware gain: at default zoom the saturated violet body carries
        // the atom read (filled plasma flower, not a hollow glassy orb).
        const emission = brightness
          .mul(1.5)
          .add(0.22)
          .mul(0.011)
          .mul((u.far as any).mul(2.1).add(1));
        Loop(u.steps as any, () => {
          If(t.greaterThan(t1).or(trans.lessThan(0.02)), () => {
            Break();
          });
          const q = ro.add(rd.mul(t)).sub(center).div(cloudR);
          const s = cloudBody(q);
          const w = s.w;
          acc.addAssign(s.col.mul(emission).mul(dt).mul(trans));
          const m = s.m;
          // The medium also attenuates emission behind it (depth: near petals
          // occlude far ones), not just the room.
          trans.mulAssign(exp(w.mul(0.03).add(m.mul(0.07)).mul(dt).negate()));
          transBg.mulAssign(exp(m.mul(dt).negate()));
          t.addAssign(dt);
        });
      });
    });
  };

  /** Upsampled low-res hero cloud for this full-res pixel (see heroPass.ts). */
  const sampleHeroCloud = (fullHit: any) => {
    const lowSize = heroLowSize as any;
    const pLow = screenCoordinate.xy.mul(heroLowScale as any).sub(0.5);
    const base = floor(pLow);
    const f = pLow.sub(base);
    const accS = vec3(0).toVar();
    const o1 = float(0).toVar();
    const o2 = float(0).toVar();
    const wS = float(0).toVar();
    const want = select(fullHit, float(1), float(0));
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const ij = base.add(vec2(dx, dy)).clamp(vec2(0), lowSize.sub(1));
      const s4 = heroCloudTex.sample(ij.add(0.5).div(lowSize));
      const packed = s4.w;
      const hitF = floor(packed.div(HERO_MASK));
      const rest = packed.sub(hitF.mul(HERO_MASK));
      const q1 = floor(rest.div(HERO_Q2));
      const q2 = rest.sub(q1.mul(HERO_Q2));
      const bx = dx === 0 ? float(1).sub(f.x) : f.x;
      const by = dy === 0 ? float(1).sub(f.y) : f.y;
      const match = select(hitF.min(1).equal(want), float(1), float(0.02));
      const w = bx.mul(by).mul(match).add(1e-6);
      accS.addAssign(s4.xyz.mul(w));
      o1.addAssign(q1.mul(w));
      o2.addAssign(q2.mul(w));
      wS.addAssign(w);
    }
    return {
      acc: accS.div(wS),
      trans: float(1).sub(o1.div(wS).div(HERO_Q)),
      transBg: float(1).sub(o2.div(wS).div(HERO_Q)),
    };
  };

  const fullFragment = Fn(() => {
    const mirrorOn = u.mirror as any;
    const fy = u.floorY as any;
    const camM = vec3(cameraPosition.x, fy.mul(2).sub(cameraPosition.y), cameraPosition.z);
    const posM = vec3(positionWorld.x, fy.mul(2).sub(positionWorld.y), positionWorld.z);
    const ro = select(mirrorOn.greaterThan(0.5), camM, cameraPosition);
    const rd = normalize(select(mirrorOn.greaterThan(0.5), posM, positionWorld).sub(ro));
    const cloudR = u.cloudRadius as any;
    const glassR = u.glassRadius as any;

    // --- surface: glass shell + nucleons ---------------------------------
    const surface = vec3(0).toVar();
    const surfAlpha = float(0).toVar();
    const tNuc = float(-1).toVar();
    const hg = raySphere(ro, rd, center, glassR);
    If(hg.x.greaterThan(0), () => {
      const pg = ro.add(rd.mul(hg.x));
      const ng = normalize(pg.sub(center));
      const ndv = saturate(dot(ng, rd.negate()));
      const fg = float(0.03).add(float(0.97).mul(pow(float(1).sub(ndv), 4.5)));
      const reflG = neonEnvironment(reflect(rd, ng), float(0.04)).mul(fg).mul(0.8);
      const rim = pow(float(1).sub(ndv), 3)
        .mul(u.coreColor as any)
        .mul(float(0.12).add(excitation.mul(0.4)));
      // Low-index glass (directive 38.4): at 1.32 the magnified image of side/rear
      // nucleons reached the glass silhouette and was cut there (the "notch").
      const rdIn = refract(rd, ng, float(1 / NUCLEUS_GLASS_IOR));
      const res = traceNucleus(pg, rdIn);
      // Distance-faded glass: at default zoom the plasma reads first, not a glassy orb.
      const shellK = float(1).sub((u.far as any).mul(0.95));
      surface.assign(reflG.add(rim.mul(0.6)).mul(shellK));
      surfAlpha.assign(
        saturate(fg.mul(0.8).add(rim.x.mul(0.2)))
          .min(0.5)
          .mul(shellK)
      );
      If(res.w.greaterThan(0), () => {
        surface.addAssign(
          res.xyz
            .mul(float(1).sub(fg))
            .mul(brightness.mul(0.5).add(0.2))
            // Small on screen: the model-coloured nucleus must read through the cloud.
            .mul((u.far as any).mul(2.2).add(1))
        );
        surfAlpha.assign(1);
        tNuc.assign(hg.x.add(res.w));
      });
    });

    // --- volumetric electron cloud ---------------------------------------
    const acc = vec3(0).toVar();
    const trans = float(1).toVar();
    const transBg = float(1).toVar();
    If((u.heroComposite as any).greaterThan(0.5), () => {
      // Hero atom: the cloud was marched at low resolution (heroPass); read it back with a
      // nucleus-hit-aware bilinear upsample (taps across the nucleus silhouette are rejected,
      // so the full-res nucleus edge never picks up cloud from the other side).
      const r = sampleHeroCloud(tNuc.greaterThan(0));
      acc.assign(r.acc);
      trans.assign(r.trans);
      transBg.assign(r.transBg);
    }).Else(() => {
      marchCloud(ro, rd, tNuc, acc, trans, transBg);
    });

    // Equatorial anamorphic flare + hot core flare (HDR-driven, restrained).
    const tc = dot(center.sub(ro), rd);
    const pc = ro.add(rd.mul(tc)).sub(center);
    const fx = dot(pc, u.camRight as any);
    const fyy = dot(pc, u.camUp as any);
    // Hot core flare: a tight pink-white star (round core + 4 thin spikes) over
    // the gem. The wide anamorphic equatorial streak is a separate sprite.
    const lc = length(vec3(fx, fyy, 0));
    const coreFlare = exp(lc.div(cloudR.mul(0.03)).negate())
      .mul(2.0)
      .add(exp(lc.div(cloudR.mul(0.12)).negate()).mul(0.12));
    const spikeH = exp(fyy.abs().div(cloudR.mul(0.004)).negate()).mul(
      exp(fx.abs().div(cloudR.mul(0.16)).negate())
    );
    const spikeV = exp(fx.abs().div(cloudR.mul(0.004)).negate()).mul(
      exp(fyy.abs().div(cloudR.mul(0.12)).negate())
    );
    const flareK = excitation.mul(0.9).add(0.12);
    const flare = vec3(1.0, 0.6, 0.92)
      .mul(coreFlare.add(spikeH.add(spikeV).mul(0.9)))
      .mul(0.55)
      .mul(flareK);
    // Plasma in front of the gem is thinner (the reference keeps the crystal
    // crisp): the body glow over a nucleus hit is held back.
    const accK = select(tNuc.greaterThan(0), float(0.35), float(1));
    // Defined luminous cyan rim (idea5): an analytic limb on the ray's impact
    // parameter (only the silhouette lights, never the face of the disc), broken
    // into sparkly petal tips by direction-only noise.
    const bImp = length(pc);
    const edgeW = (u.reach as any).mul(cloudR).mul(0.9);
    const limbD = bImp.sub(edgeW).div(cloudR);
    const limbCore = exp(limbD.div(0.018).pow(2).negate());
    const limbGlow = exp(limbD.div(0.05).pow(2).negate()).mul(0.1);
    const limbN = bakedNoise(
      normalize(pc)
        .mul(22)
        .add(vec3((u.phase as any).mul(0.02))),
      0
    );
    const limbBreak = float(1).sub(limbN.abs()).max(0).pow(2.2).mul(0.85).add(0.15);
    const rimL = dot(u.rim as any, vec3(0.2126, 0.7152, 0.0722));
    const rimTone = max(mix(vec3(rimL), u.rim as any, saturation), 0);
    const limb = rimTone
      .mul(limbCore.mul(limbBreak).add(limbGlow))
      .mul(float(0.55).add(excitation.mul(0.45)))
      .mul(brightness.mul(0.6).add(0.4))
      .mul((u.crowd as any).mul(0.6).add(0.4))
      .mul(RIM_GAIN);
    const withFlare = acc
      .mul(accK)
      .add(flare.mul(trans.mul(0.5).add(0.5)))
      .add(limb);
    const refl = select(mirrorOn.greaterThan(0.5), float(0.3), float(1));
    const color = withFlare.add(surface.mul(mix(trans, float(1), 0.6))).mul(refl);
    const alpha = float(1)
      .sub(trans.mul(transBg).mul(float(1).sub(surfAlpha)))
      .mul(refl);
    return vec4(color, alpha);
  });

  /**
   * Small-projected-size LOD (operator directives 26 + 31): the SAME atom for genuinely
   * tiny clouds (<= ~50 css px; cross-fades to the full atom by ~110 px). A cheap
   * analytic stand-in for the ray march: deep violet plasma body with soft organic
   * petal bundles (soft modulation, never flat cut-outs), a defined sparkly cyan rim and
   * a glowing MODEL-COLOURED nucleus (tint sectors, saturated, never a white blob). The
   * orbit wires stay real geometry; the sub-pixel hairline strands are swapped for the
   * body's own thicker, brighter radial streaks. Pure function of the quad-local
   * coordinate (no loops, no texture reads).
   */
  const smallFragment = Fn(() => {
    const mirrorOn = u.mirror as any;
    const cloudR = u.cloudRadius as any;
    // Quad-local coordinates (identical for the main and the mirrored floor pass).
    const x = positionGeometry.x.mul(u.quadHalf as any).div(cloudR);
    const y = positionGeometry.y.mul(u.quadHalf as any).div(cloudR);
    const r = length(vec3(x, y, 0)).max(0.0005);
    const phase = u.phase as any;
    const reach = u.reach as any;
    const sat = saturation;
    const seed = dot(u.axes[0] as any, vec3(12.9898, 78.233, 37.719));
    const seedF = seed.sub(seed.floor());
    const nPet = seedF.mul(4).floor().add(7);
    const swirl = phase.mul(0.05).add(r.mul(0.9));
    const ang = atan(y, x).add(swirl);
    const petal = cos(ang.mul(nPet).add(seedF.mul(6.28)))
      .mul(0.5)
      .add(0.5);
    const petal2 = cos(ang.mul(nPet.add(3)).add(phase.mul(0.15)).add(seedF.mul(3)))
      .mul(0.5)
      .add(0.5);
    // Soft petal bundles: modulate brightness and the outline only slightly.
    const bundle = smoothstep(0.05, 0.95, petal.mul(petal2.mul(0.35).add(0.65)));
    const edgeR = reach.mul(0.94).mul(float(0.9).add(bundle.mul(0.1)));
    const rr = r.div(edgeR);
    const inside = float(1).sub(smoothstep(0.9, 1.0, rr));
    // Deep violet plasma body: dense bright core fading outward, radial streaks as the
    // thick stand-in for the hairline strands, mild dark voids between bundles.
    const streak = pow(
      cos(ang.mul(nPet.mul(4)).add(r.mul(10)).add(seedF.mul(9)))
        .mul(0.5)
        .add(0.5),
      2
    );
    const bodyHue = mix(u.inner as any, (u.hues as any)[0], 0.35).mul(vec3(0.85, 0.5, 1.15));
    const bodyDeep = mix(bodyHue, vec3(0.42, 0.1, 1.0), 0.5);
    const coreFall = exp(rr.mul(rr).mul(-1.4));
    const bodyK = mix(float(0.5), float(1.15), bundle)
      .mul(streak.mul(0.4).add(0.7))
      .mul(coreFall.mul(0.9).add(0.45));
    const bodyCol = bodyDeep.mul(bodyK);
    // Defined cyan rim, sparkly (angular hash twinkle).
    const cell = ang.mul(70).floor();
    const tw = fract(sin(cell.mul(12.9898).add(seedF.mul(78.233))).mul(43758.5453));
    const twk = sin(phase.mul(1.7).add(tw.mul(30)))
      .mul(0.5)
      .add(0.5);
    const rimBand = exp(pow(rr.sub(0.965).div(0.055), 2).negate());
    const rimCol = (u.rim as any)
      .mul(rimBand)
      .mul(tw.mul(0.5).add(0.5).add(twk.mul(0.6)))
      .mul(2.4);
    const halo = exp(pow(rr.sub(1.02).div(0.22), 2).negate())
      .mul(0.22)
      .mul(u.rim as any);
    // Nucleus: a glowing, saturated, MODEL-COLOURED ball (sectored by up to 3 tints).
    const rho = (u.glassRadius as any).div(cloudR).mul(0.95).max(0.17);
    const nr = r.div(rho);
    const nz = sqrt(max(float(1).sub(nr.mul(nr)), 0));
    const t0 = (u.nucleonTints as any).element(0).xyz;
    const t1 = (u.nucleonTints as any).element(1).xyz;
    const t2 = (u.nucleonTints as any).element(2).xyz;
    const sec = atan(y, x).add(3.14159).div(6.28318).mul(3);
    const s0 = smoothstep(1.0, 0.7, sec.sub(0.0).abs()).add(smoothstep(2.3, 2.7, sec));
    const s1 = smoothstep(0.7, 1.0, sec)
      .mul(smoothstep(2.0, 1.7, sec))
      .add(0.0001);
    const s2 = smoothstep(1.7, 2.0, sec)
      .mul(smoothstep(3.1, 2.7, sec))
      .add(0.0001);
    const tint = t0.mul(s0).add(t1.mul(s1)).add(t2.mul(s2)).div(s0.add(s1).add(s2));
    const tl = dot(tint, vec3(0.2126, 0.7152, 0.0722));
    const tintSat = max(mix(vec3(tl), tint, 3.4), 0);
    const nucK = excitation.mul(0.8).add(0.7);
    // Hue-preserving: lit by its own colour (no white add), so the model colour reads.
    const ballCol = tintSat.mul(nz.mul(0.7).add(0.6)).mul(nucK).mul(1.45);
    const ballIn = float(1).sub(smoothstep(0.92, 1.0, nr));
    const ballGlow = tintSat
      .mul(exp(nr.mul(nr).mul(-0.9)))
      .mul(nucK)
      .mul(0.7);
    const energyK = excitation.mul(0.6).add(0.7).mul(brightness.mul(0.5).add(0.55));
    const crowdK = (u.crowd as any).max(0.55);
    let col: any = bodyCol
      .mul(inside)
      .mul(energyK.max(0.75))
      .mul(1.9)
      .add(rimCol.mul(inside.mul(0.6).add(0.4)))
      .add(halo);
    col = col.mul(float(1).sub(ballIn)).add(ballCol.mul(ballIn)).add(ballGlow.mul(inside));
    // Only Tier 0 greys (saturation uniform); healthy atoms keep full colour.
    const l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = max(mix(vec3(l), col, sat.mul(0.5).add(0.5)), 0).mul(crowdK.mul(0.3).add(0.7));
    const dimK = u.dim as any;
    const edgeFade = float(1).sub(smoothstep(0.93, 1.04, r));
    col = col.mul(edgeFade).mul(dimK);
    const refl = select(mirrorOn.greaterThan(0.5), float(0.3), float(1));
    const alpha = saturate(inside.mul(0.9).add(halo.x.mul(0.3)).add(ballIn));
    return vec4(col.mul(refl), alpha.mul(refl).mul(edgeFade).mul(dimK.mul(0.6).add(0.4)));
  });

  const fragment = Fn(() => {
    const lodW = u.lod as any;
    const out = vec4(0).toVar();
    If(lodW.lessThan(0.999), () => {
      out.addAssign(fullFragment().mul(float(1).sub(lodW)));
    });
    If(lodW.greaterThan(0.001), () => {
      out.addAssign(smallFragment().mul(lodW));
    });
    return out;
  });

  /**
   * Low-res hero cloud pass: the same ray, glass refraction and nucleus termination as the full
   * atom (hit distance only, no shading), then the shared march. Output: rgb = emission,
   * a = packed (1 - trans, 1 - transBg, nucleus hit). Outside the cloud it writes the clear value.
   */
  const cloudLowFragment = Fn(() => {
    const ro = cameraPosition;
    const rd = normalize(positionWorld.sub(ro));
    const tNuc = float(-1).toVar();
    const hg = raySphere(ro, rd, center, u.glassRadius as any);
    If(hg.x.greaterThan(0), () => {
      const pg = ro.add(rd.mul(hg.x));
      const ng = normalize(pg.sub(center));
      const rdIn = refract(rd, ng, float(1 / NUCLEUS_GLASS_IOR));
      const tn = nucleusHitT(pg, rdIn);
      If(tn.greaterThan(0), () => {
        tNuc.assign(hg.x.add(tn));
      });
    });
    const acc = vec3(0).toVar();
    const trans = float(1).toVar();
    const transBg = float(1).toVar();
    marchCloud(ro, rd, tNuc, acc, trans, transBg);
    const q1 = floor(saturate(float(1).sub(trans)).mul(HERO_Q).add(0.5));
    const q2 = floor(saturate(float(1).sub(transBg)).mul(HERO_Q).add(0.5));
    const hit = select(tNuc.greaterThan(0), float(HERO_MASK), float(0));
    return vec4(acc, hit.add(q1.mul(HERO_Q2)).add(q2));
  });

  const material = new MeshBasicNodeMaterial();
  material.fragmentNode = variant === "cloudLow" ? cloudLowFragment() : fragment();
  // Billboard quad: covers the cloud bounding sphere silhouette.
  material.positionNode = (u.camRight as any)
    .mul(positionLocal.x)
    .add((u.camUp as any).mul(positionLocal.y))
    .mul(u.quadHalf as any);
  if (variant === "cloudLow") {
    // Written as-is into the cleared low-res target (packed data, never blended).
    material.transparent = false;
    material.depthWrite = false;
    material.depthTest = false;
    material.blending = NoBlending;
    return material;
  }
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneMinusSrcAlphaFactor;
  void cross;
  return material;
}
