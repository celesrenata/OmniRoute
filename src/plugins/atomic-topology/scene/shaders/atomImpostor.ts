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
  cross,
  dot,
  exp,
  floor,
  float,
  fract,
  int,
  interleavedGradientNoise,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  positionLocal,
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
  vec3,
  vec4,
} from "three/tsl";
import {
  MeshBasicNodeMaterial,
  Vector3,
  Vector4,
  AdditiveBlending,
  CustomBlending,
} from "three/webgpu";
import { OneFactor, OneMinusSrcAlphaFactor, AddEquation } from "three/webgpu";
import { MAX_NUCLEONS } from "../shaderParams";
import { raySphere, sphereOcclusion, sphereSoftShadow } from "./raySphere";

void AdditiveBlending;

/** Key light direction (towards the light) and colour. */
const KEY_DIR = vec3(-0.45, 0.72, 0.52).normalize();
const KEY_COLOR = vec3(1.0, 0.86, 0.95);

/** 3D-noise stand-in for 4D: radial coordinate decorrelates along a fixed diagonal. */
const lattice = (c: any) =>
  fract(sin(dot(c, vec3(127.1, 311.7, 74.7))).mul(43758.5453))
    .mul(2)
    .sub(1);
/** Cheap 3D value noise (8 hashed lattice points) - ~2x cheaper than perlin per sample. */
const vnoise = (p: any) => {
  const i = floor(p);
  const f = fract(p);
  const w = f.mul(f).mul(float(3).sub(f.mul(2)));
  const x00 = mix(lattice(i), lattice(i.add(vec3(1, 0, 0))), w.x);
  const x10 = mix(lattice(i.add(vec3(0, 1, 0))), lattice(i.add(vec3(1, 1, 0))), w.x);
  const x01 = mix(lattice(i.add(vec3(0, 0, 1))), lattice(i.add(vec3(1, 0, 1))), w.x);
  const x11 = mix(lattice(i.add(vec3(0, 1, 1))), lattice(i.add(vec3(1, 1, 1))), w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
};
const noise4 = (p: any, w: any) => vnoise(p.add(vec3(0.73, 0.41, 0.57).mul(w)));
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
  /** x excitation, y saturation, z brightness */
  energy: ReturnType<typeof uniform>;
  phase: ReturnType<typeof uniform>;
  steps: ReturnType<typeof uniform>;
  stale: ReturnType<typeof uniform>;
  mirror: ReturnType<typeof uniform>;
  inner: ReturnType<typeof uniform>;
  rim: ReturnType<typeof uniform>;
  floorY: ReturnType<typeof uniform>;
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
    energy: uniform(new Vector3(0.12, 0.35, 0.35)),
    phase: uniform(0),
    steps: uniform(96, "int"),
    stale: uniform(0),
    mirror: uniform(0),
    inner: uniform(new Vector3(0.62, 0.22, 1)),
    rim: uniform(new Vector3(0.1, 0.85, 1)),
    floorY: uniform(-62),
  };
}

/** Build the impostor material for one atom from its uniforms. */
export function createAtomMaterial(u: AtomUniforms): MeshBasicNodeMaterial {
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
      const albedo = max(mix(vec3(albedoLuma), albedoRaw, 1.55), 0).mul(
        mix(float(1), saturation.mul(0.5).add(0.5), 1)
      );
      const isP = t4.w;
      const p = ro.add(rd.mul(tBest));
      const nSmooth = normalize(p.sub(c.xyz));
      const nq = floor(nSmooth.mul(2.2).add(0.5));
      const facet = normalize(nq.add(nSmooth.mul(0.35)));
      const n = normalize(mix(nSmooth, facet, 0.28));
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
        .mul(float(0.3).add(edge.mul(0.8)))
        .mul(mix(float(0.45), float(1), isP))
        .mul(ao.mul(0.6).add(0.4))
        .mul(float(0.3).add(excitation.mul(0.7)));
      const specKey = pow(max(dot(refl, KEY_DIR), 0), mix(float(40), float(260), isP)).mul(
        isP.mul(0.8).add(0.2)
      );
      const color = diffuse
        .mul(0.55)
        .add(glow)
        .add(bounce.mul(fres.mul(1.1).add(0.06)).mul(ao.mul(0.5).add(0.5)))
        .add(KEY_COLOR.mul(specKey).mul(sh).mul(1.4));
      const cl = dot(color, vec3(0.2126, 0.7152, 0.0722));
      const vivid = max(mix(vec3(cl), color, 1.35), 0).mul(0.78);
      out.assign(vec4(vivid, tBest));
    });
    return out;
  });

  /** Orbital cloud density + emission colour at normalised cloud-space point q. */
  const cloudSample = Fn(([q]: [any]) => {
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
    // Orbital probability density |Y_lm|^2: modulates strand intensity into
    // petal-like lobes (the "flower" read of the reference cloud).
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
    // Dense radial plasma filaments: ridged noise with a very high angular
    // frequency and a low radial frequency => hundreds of strands that fan out
    // from the nucleus and converge on it.
    const rr = r.mul(1.1).sub(phase.mul(0.06));
    // True line filaments: intersection of two noise zero-sheets, elongated
    // radially (the radial coordinate decorrelates slowly; angle quickly).
    const strand = (freq: number, off: number, ex: number) => {
      const n1 = noise4(dir.mul(freq).add(off), rr);
      const n2 = noise4(dir.mul(freq).add(off + 11.7), rr.mul(1.15).add(off));
      return pow(saturate(float(1).sub(n1.abs())), ex).mul(
        pow(saturate(float(1).sub(n2.abs())), ex)
      );
    };
    const strands = strand(24, 0.0, 15)
      .mul(1.0)
      .add(strand(52, 5.1, 18).mul(1.0))
      .mul(12.0);
    // Strand brightness flickers subtly and is brightest near the nucleus.
    const flick = noise4(dir.mul(9), phase.mul(0.9)).mul(0.25).add(0.85);
    const near = float(0.1).add(exp(r.mul(-2.4)).mul(1.5));
    const haze = lobeSum.mul(0.0);
    const body = strands.mul(flick).mul(near).mul(lobeSum.mul(0.9).add(0.3)).add(haze);
    // Hot core plasma near the nucleus.
    const core = exp(r.mul(r).mul(-55))
      .mul(2.6)
      .add(exp(r.mul(r).mul(-9)).mul(0.25));
    // Defined luminous sparkly rim at the cloud boundary.
    const rimShell = exp(pow(r.sub(0.95).div(0.03), 2).negate());
    const cell = floor(q.mul(46));
    const cseed = dot(cell, vec3(12.9898, 78.233, 37.719));
    const hsh = fract(sin(cseed).mul(43758.5453));
    const cf = fract(q.mul(46)).sub(0.5);
    const sparkDot = exp(dot(cf, cf).mul(-46));
    const sparkleRim = rimShell.mul(float(0.035).add(step(0.7, hsh).mul(sparkDot).mul(5.5)));
    // Embedded pink/orange sparkle motes inside the volume.
    const mc = floor(q.mul(17));
    const mseed = dot(mc, vec3(51.7, 19.3, 83.1));
    const mh = fract(sin(mseed).mul(24634.6345));
    const mf = fract(q.mul(17)).sub(0.5);
    const mote = step(0.935, mh)
      .mul(exp(dot(mf, mf).mul(-70)))
      .mul(float(0.7).add(sin(phase.mul(2.0).add(mh.mul(40))).mul(0.3)));
    const interior = float(1).sub(smoothstep(0.93, 0.99, r));
    const density = body
      .mul(interior)
      .add(core)
      .add(sparkleRim.mul(float(1).sub(smoothstep(0.985, 1.0, r))).mul(1.4));
    // Colour: violet/magenta interior grading to a cyan rim.
    const rimT = smoothstep(0.72, 0.99, r);
    const interiorCol = mix(hueMix, u.inner as any, 0.5);
    const rimCol = mix(u.rim as any, hueMix, 0.2);
    const baseCol = mix(interiorCol, rimCol, rimT);
    const hot = saturate(core.mul(0.5));
    const moteCol = vec3(1.0, 0.45, 0.62);
    const base = mix(baseCol, u.coreColor as any, hot);
    const luma = dot(base, vec3(0.2126, 0.7152, 0.0722));
    const graded = mix(vec3(luma), base, saturation);
    const moteGraded = mix(vec3(dot(moteCol, vec3(0.2126, 0.7152, 0.0722))), moteCol, saturation);
    return vec4(graded.mul(density).add(moteGraded.mul(mote).mul(22.0)), density.add(mote));
  });

  const fragment = Fn(() => {
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
      const reflG = neonEnvironment(reflect(rd, ng), float(0.04)).mul(fg).mul(1.6);
      const rim = pow(float(1).sub(ndv), 3)
        .mul(u.coreColor as any)
        .mul(float(0.12).add(excitation.mul(0.4)));
      const rdIn = refract(rd, ng, float(1 / 1.32));
      const res = traceNucleus(pg, rdIn);
      surface.assign(reflG.add(rim.mul(0.6)));
      surfAlpha.assign(saturate(fg.mul(0.8).add(rim.x.mul(0.2))).min(0.5));
      If(res.w.greaterThan(0), () => {
        surface.addAssign(res.xyz.mul(float(1).sub(fg)).mul(brightness.mul(0.5).add(0.2)));
        surfAlpha.assign(1);
        tNuc.assign(hg.x.add(res.w));
      });
    });

    // --- volumetric electron cloud ---------------------------------------
    const acc = vec3(0).toVar();
    const trans = float(1).toVar();
    const hc = raySphere(ro, rd, center, cloudR);
    If(hc.y.greaterThan(0), () => {
      const t0 = max(hc.x, 0);
      const t1 = select(tNuc.greaterThan(0), min(hc.y, tNuc), hc.y);
      If(t1.greaterThan(t0), () => {
        const stepsF = float(u.steps as any);
        const dt = t1.sub(t0).div(stepsF);
        const t = t0.add(dt.mul(interleavedGradientNoise(screenCoordinate.xy))).toVar();
        const emission = brightness.mul(1.5).add(0.22).mul(0.0078);
        Loop(u.steps as any, () => {
          If(t.greaterThan(t1), () => {
            Break();
          });
          const q = ro.add(rd.mul(t)).sub(center).div(cloudR);
          const s = cloudSample(q);
          const w = s.w;
          acc.addAssign(s.xyz.mul(emission).mul(dt).mul(trans));
          trans.mulAssign(exp(w.mul(dt).mul(-0.006)));
          t.addAssign(dt);
        });
      });
    });

    // Equatorial anamorphic flare + hot core flare (HDR-driven, restrained).
    const tc = dot(center.sub(ro), rd);
    const pc = ro.add(rd.mul(tc)).sub(center);
    const fx = dot(pc, u.camRight as any);
    const fyy = dot(pc, u.camUp as any);
    const streak = exp(pow(fyy.div(cloudR.mul(0.018)), 2).negate())
      .mul(exp(fx.abs().div(cloudR.mul(0.55)).negate()))
      .mul(float(1).sub(smoothstep(0.75, 1.1, fx.abs().div(cloudR))));
    const coreFlare = exp(
      length(vec3(fx, fyy, 0))
        .div(cloudR.mul(0.05))
        .negate()
    );
    const flareK = excitation.mul(0.9).add(0.12);
    const flare = vec3(0.25, 0.85, 1.0)
      .mul(streak)
      .mul(0.55)
      .add(vec3(1.0, 0.7, 0.95).mul(coreFlare).mul(0.9))
      .mul(flareK);
    const withFlare = acc.add(flare.mul(smoothstep(0.0, 0.2, trans)));
    const refl = select(mirrorOn.greaterThan(0.5), float(0.3), float(1));
    const color = withFlare.add(surface.mul(trans)).mul(refl);
    const alpha = float(1)
      .sub(trans.mul(float(1).sub(surfAlpha)))
      .mul(refl);
    return vec4(color, alpha);
  });

  const material = new MeshBasicNodeMaterial();
  material.fragmentNode = fragment();
  // Billboard quad: covers the cloud bounding sphere silhouette.
  material.positionNode = (u.camRight as any)
    .mul(positionLocal.x)
    .add((u.camUp as any).mul(positionLocal.y))
    .mul(u.quadHalf as any);
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
