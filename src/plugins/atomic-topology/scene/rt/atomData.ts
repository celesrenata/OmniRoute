/**
 * GPU data for the batched ray-traced atoms (Gate B, C7a). See `atomLayout.ts`
 * for the row/column contract.
 *
 * Hot per-atom fields live in a shared UNIFORM buffer (`renderGroup`: uploaded once per render, constant-cache
 * reads in the hot ray-trace loops and the strand vertex stage). The light,
 * rarely-read per-wire/per-bolt data (wire definitions, electron angles, bolt
 * endpoints) lives in two small RGBA32F data textures.
 *
 * Capacity per batch is backend-dependent: WebGL2 guarantees only 16 KB per
 * uniform block, WebGPU 64 KB, so the host creates as many batches as needed.
 *
 * Imports `three` classes only through `three/webgpu` + `three/tsl`.
 */
import { buffer, int, ivec2, renderGroup, texture, vec3, vec4 } from "three/tsl";
import { DataTexture, FloatType, NearestFilter, RGBAFormat } from "three/webgpu";
import {
  BOLT_BASE,
  BOLT_TEXELS,
  DYN_COLS,
  ELECTRON_BASE,
  FIELD,
  FIELD_COUNT,
  STATIC_COLS,
  WIRE_DEF_BASE,
  WIRE_DEF_TEXELS,
} from "./atomLayout";

export interface AtomData {
  /** Atoms this batch can hold. */
  capacity: number;
  /** vec4 fields: (row * FIELD_COUNT + field) * 4. */
  fieldsArr: Float32Array;
  fieldsNode: any;
  /** vec4 dynamic entries: (row * DYN_COLS + col) * 4. */
  dynArr: Float32Array;
  dynNode: any;
  stat: DataTexture;
  statArr: Float32Array;
  dispose: () => void;
}

/** Atoms per batch that fit the backend's uniform-block limit (bytes). */
export function batchCapacityFor(maxUniformBlockBytes: number): number {
  const vec4s = Math.floor(Math.max(0, maxUniformBlockBytes) / 16);
  const byFields = Math.floor(vec4s / FIELD_COUNT);
  const byDyn = Math.floor(vec4s / DYN_COLS);
  return Math.max(1, Math.min(byFields, byDyn, 64));
}

function makeTexture(cols: number, rows: number): { tex: DataTexture; arr: Float32Array } {
  const arr = new Float32Array(cols * rows * 4);
  const tex = new DataTexture(arr, cols, rows, RGBAFormat, FloatType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, arr };
}

/** Allocate the batch data (zero-filled; rows are written by the batch). */
export function createAtomData(capacity: number): AtomData {
  const cap = Math.max(1, Math.floor(capacity));
  const fieldsArr = new Float32Array(cap * FIELD_COUNT * 4);
  const dynArr = new Float32Array(cap * DYN_COLS * 4);
  const s = makeTexture(STATIC_COLS, cap);
  return {
    capacity: cap,
    fieldsArr,
    fieldsNode: buffer(fieldsArr, "vec4", cap * FIELD_COUNT).setGroup(renderGroup),
    dynArr,
    dynNode: buffer(dynArr, "vec4", cap * DYN_COLS).setGroup(renderGroup),
    stat: s.tex,
    statArr: s.arr,
    dispose: () => {
      s.tex.dispose();
    },
  };
}

/** Everything the batched shaders read about one atom (TSL nodes). */
export interface AtomFields {
  center: any;
  cloudR: any;
  camRight: any;
  quadHalf: any;
  camUp: any;
  glassR: any;
  excitation: any;
  saturation: any;
  brightness: any;
  phase: any;
  weights: any;
  mediumK: any;
  far: any;
  crowd: any;
  reach: any;
  steps: any;
  lobeKind: any;
  nucleonCount: any;
  peaks: any;
  swirl: any;
  rootR: any;
  active: any;
  pxScale: any;
  hue: any[];
  lifeOn: any;
  occluderR: any;
  wireScale: any;
  inner: any;
  wireTime: any;
  rim: any;
  wireEnergy: any;
  coreColor: any;
  strandCrowd: any;
  sparkleGain: any;
  sparkleActive: any;
  /** 0..1 red failure flash. */
  alert: any;
  /** Small-atom LOD weight (0 = full ray-traced atom, 1 = bold small-size LOD). */
  lod: any;
  rootColor: any;
  strandInner: any;
  streakK: any;
  glowK: any;
  ringK: any;
  axes: any[];
  isHub: any;
  /** orient * v. */
  orientMul: (v: any) => any;
  /** Wire definition texel `k` (0..3) of wire `w`. */
  wireDef: (w: any, k: number) => any;
  /** Electron angles (x, y) of wire `w`. */
  electrons: (w: any) => any;
  /** Bolt slot texel `k` (0 = A+intensity, 1 = B+variant, 2 = colour). */
  bolt: (slot: any, k: number) => any;
}

/**
 * Build field readers for the atom in `row` (an int TSL node). `eager` assigns
 * every field vec4 into a local variable at the call site (use at the top of
 * fragment shaders that loop); otherwise each use is a direct buffer read.
 */
export function atomFields(data: AtomData, row: any, eager = false): AtomFields {
  const statTex = texture(data.stat);
  const r = int(row);
  const fBase = r.mul(FIELD_COUNT);
  const dBase = r.mul(DYN_COLS);
  const f = (idx: number): any => {
    const t = data.fieldsNode.element(fBase.add(idx));
    if (!eager) return t;
    // Assign as a statement NOW (at the top of the calling Fn): a bare toVar()
    // is declared where it is first used, which put the loads inside the march loop.
    const v = vec4(0).toVar();
    v.assign(t);
    return v;
  };
  const c0 = f(FIELD.CENTER_CLOUD_R);
  const c1 = f(FIELD.RIGHT_QUADHALF);
  const c2 = f(FIELD.UP_GLASS_R);
  const c3 = f(FIELD.ENERGY_PHASE);
  const c4 = f(FIELD.WEIGHTS_MEDIUM);
  const c5 = f(FIELD.FAR_CROWD_REACH_STEPS);
  const c6 = f(FIELD.LOBE_NCOUNT);
  const c7 = f(FIELD.PEAKS_SWIRL);
  const o0 = f(FIELD.ORIENT0_ROOT_R);
  const o1 = f(FIELD.ORIENT1_ACTIVE);
  const o2 = f(FIELD.ORIENT2_PX);
  const h0 = f(FIELD.HUE0_LIFE);
  const h1 = f(FIELD.HUE1_OCC);
  const h2 = f(FIELD.HUE2_WIRESCALE);
  const c14 = f(FIELD.INNER_WIRETIME);
  const c15 = f(FIELD.RIM_WIREENERGY);
  const c16 = f(FIELD.CORE_STRANDCROWD);
  const c17 = f(FIELD.ROOT_STREAK);
  const sp0 = f(FIELD.SPARE0);
  const sp1 = f(FIELD.SPARE1);
  const a0 = f(FIELD.AXIS0_GLOW);
  const a1 = f(FIELD.AXIS1_RING);
  const a2 = f(FIELD.AXIS2_FLAGS);
  return {
    center: c0.xyz,
    cloudR: c0.w,
    camRight: c1.xyz,
    quadHalf: c1.w,
    camUp: c2.xyz,
    glassR: c2.w,
    excitation: c3.x,
    saturation: c3.y,
    brightness: c3.z,
    phase: c3.w,
    weights: c4.xyz,
    mediumK: c4.w,
    far: c5.x,
    crowd: c5.y,
    reach: c5.z,
    steps: c5.w,
    lobeKind: c6.xyz,
    nucleonCount: int(c6.w),
    peaks: c7.xyz,
    swirl: c7.w,
    rootR: o0.w,
    active: o1.w,
    pxScale: o2.w,
    hue: [h0.xyz, h1.xyz, h2.xyz],
    lifeOn: h0.w,
    occluderR: h1.w,
    wireScale: h2.w,
    inner: c14.xyz,
    wireTime: c14.w,
    rim: c15.xyz,
    wireEnergy: c15.w,
    coreColor: c16.xyz,
    strandCrowd: c16.w,
    sparkleGain: sp1.x,
    sparkleActive: sp1.y,
    alert: sp1.z,
    lod: sp1.w,
    rootColor: c17.xyz,
    strandInner: sp0.xyz,
    streakK: c17.w,
    glowK: a0.w,
    ringK: a1.w,
    axes: [a0.xyz, a1.xyz, a2.xyz],
    isHub: a2.w,
    orientMul: (v: any) => vec3(o0.xyz.dot(v), o1.xyz.dot(v), o2.xyz.dot(v)),
    wireDef: (w: any, k: number) =>
      statTex.load(
        ivec2(
          int(w)
            .mul(WIRE_DEF_TEXELS)
            .add(WIRE_DEF_BASE + k),
          r
        )
      ),
    electrons: (w: any) => data.dynNode.element(dBase.add(int(w).add(ELECTRON_BASE))),
    bolt: (slot: any, k: number) =>
      data.dynNode.element(
        dBase.add(
          int(slot)
            .mul(BOLT_TEXELS)
            .add(BOLT_BASE + k)
        )
      ),
  };
}
