/**
 * Batched ray-traced atoms (Gate B, C7a). Replaces the per-atom `rtAtom.ts`:
 * every atom is one ROW in two data textures, and every layer (impostor, floor
 * reflection, strands, sparkles, wires, bolts, flares) is ONE instanced draw
 * for ALL atoms. Per frame the CPU fills typed arrays and uploads once, instead
 * of ~28 per-object uniform uploads per atom.
 *
 * Imports `three` only via `three/webgpu`. No React state; no per-frame
 * allocation (scratch vectors are preallocated, bolt lists are reused arrays).
 */
import { Group, Matrix3, Matrix4, Quaternion, Vector3, type Camera } from "three/webgpu";
import { fnv1a } from "../cloudShells";
import { CLOUD_RADIUS_MIN, type EnergyState } from "../energyState";
import { hexToLinear, packNucleus, type PackedNucleus } from "../nucleonPack";
import { orbitalLayout, orbitWires, type Orbital, type OrbitWire } from "../orbitalDensity";
import { CLOUD_BOUND_RADIUS, clampShaderParams, MAX_NUCLEONS } from "../shaderParams";
import { activeStrandFraction } from "../strandField";
import { createFlareLayer, type FlareLayer } from "../shaders/atomFlares";
import { noiseTextureDisposable } from "../shaders/atomImpostor";
import { createImpostorSlot, type ImpostorSlot } from "./impostorSlot";
import { createBoltLayer, type BoltLayer } from "../shaders/boltStrand";
import { createWireLayer, type WireLayer } from "../shaders/orbitWire";
import {
  createStrandField,
  strandGeometryDisposable,
  type StrandField,
} from "../shaders/plasmaStrands";
import { createAtomData, type AtomData } from "./atomData";
import {
  BOLT_BASE,
  BOLT_SLOTS_PER_ATOM,
  BOLT_TEXELS,
  BOLT_VARIANT_COUNT,
  DYN_COLS,
  ELECTRON_BASE,
  FIELD,
  FIELD_COUNT,
  STATIC_COLS,
  WIRES_PER_ATOM,
  WIRE_DEF_BASE,
  WIRE_DEF_TEXELS,
  strandBucket,
  strandLod,
  texelOffset,
} from "./atomLayout";
import { createRtRegistry, type RtRegistry } from "./rtRegistry";
import {
  createFrustumPlanes,
  extractFrustumPlanes,
  marchStepsFor,
  smallAtomLod,
  sphereVisible,
} from "./visibility";
import { floorY } from "./sharedUniforms";

/** World units an idle (tightest) atom sinks into its dome. */
const IDLE_SEAT_DROP = 28;

/** Extinction of the absorbing cloud body at full (excited) brightness. */
const MEDIUM_K = 0.3;
/**
 * Visual nucleus scale relative to the packed production cluster: idea5 shows
 * a small crystalline gem (~1/4 of the cloud diameter), not a large ball.
 */
export const NUCLEUS_VISUAL_SCALE = 0.48;

/** Lane palette (linear-ish) for wires/bolts: green, blue, violet, cyan, magenta. */
const LANE_PALETTE: [number, number, number][] = [
  [0.15, 1.0, 0.45],
  [0.2, 0.45, 1.0],
  [0.65, 0.22, 1.0],
  [0.1, 0.9, 1.0],
  [1.0, 0.25, 0.75],
];
const NEUTRAL_PALETTE: [number, number, number][] = [
  [0.55, 0.65, 0.85],
  [0.45, 0.6, 0.9],
  [0.6, 0.7, 0.95],
];
const NEUTRAL_HUES: [number, number, number][] = [
  [0.42, 0.52, 0.78],
  [0.35, 0.5, 0.85],
  [0.5, 0.58, 0.8],
];
const HUB_HUES: [number, number, number][] = [
  [0.95, 0.18, 0.3],
  [0.62, 0.16, 1.0],
  [0.1, 0.65, 1.0],
];

/** Excitation above which each bolt slot may fire (only the first four ever do). */
const BOLT_THRESHOLDS = [0.4, 0.6, 0.8, 0.92, 2, 2, 2, 2];

/** Deterministic hash in [0, 1) (bolt directions; no Math.random). */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function mix3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export interface BatchAtomConfig {
  id: string;
  hub: boolean;
  observedModelIds?: readonly string[];
  /** Lane hue (hex) used for the rim/inner tone when models are known. */
  laneHue: string;
  /** Unknown / stale attribution: restrained blue-silver, never a model colour. */
  neutral: boolean;
}

export interface BatchAtomFrame {
  position: readonly [number, number, number];
  energy: EnergyState;
  phase: number;
  spinAngle: number;
  /** Nucleus-spin-independent decorative swirl is advanced internally. */
  marchSteps: number;
  /** Uniform world scale of the whole atom (focus emphasis, breathing, hub). Default 1. */
  scale?: number;
  /** 0..1 red failure flash on the nucleus/core glow (event-driven). Default 0. */
  alert?: number;
  /** 0..1 gain multiplier for non-focused atoms in the focus view (1 = unchanged). Default 1. */
  dim?: number;
}

export interface BatchFrameContext {
  dt: number;
  camera: Camera;
  reducedMotion: boolean;
  /** Drawing-buffer height in device pixels (screen-space hairline widths). */
  pixelHeight: number;
  /**
   * Visibility savings (frustum culling, projected-size march steps). Default on;
   * `false` is the dev A/B baseline (`?cull=0`) used to measure the savings.
   */
  cull?: boolean;
}

interface BoltSlotState {
  variant: number;
  shot: number;
  dir: Vector3;
}

interface AtomState {
  signature: string;
  /** Current strand draw bucket (hysteresis state). */
  bucket: number;
  config: BatchAtomConfig;
  seed: number;
  packed: PackedNucleus;
  nucExtent: number;
  orbitals: Orbital[];
  orbitalWeights: number[];
  wires: OrbitWire[];
  axis: Vector3;
  orient: Matrix3;
  known: boolean;
  hueSet: [number, number, number][];
  inner: [number, number, number];
  strandInner: [number, number, number];
  rim: [number, number, number];
  coreColor: [number, number, number];
  rootColor: [number, number, number];
  palette: [number, number, number][];
  electronHot: [number, number, number];
  electronCount: number[];
  flickerClock: number;
  swirlClock: number;
  slots: BoltSlotState[];
}

function signatureOf(c: BatchAtomConfig): string {
  return `${c.id}|${c.hub ? 1 : 0}|${c.neutral ? 1 : 0}|${c.laneHue}|${(c.observedModelIds ?? []).join(",")}`;
}

function buildAtomState(config: BatchAtomConfig): AtomState {
  const seed = fnv1a(config.id);
  const packed = packNucleus({
    seed,
    hub: config.hub,
    observedModelIds: config.observedModelIds,
  });
  // Positions shrink more than radii, so nucleons fuse into one lumpy gem.
  for (let i = 0; i < packed.count; i += 1) {
    for (let k = 0; k < 3; k += 1) packed.centers[i * 4 + k] *= NUCLEUS_VISUAL_SCALE;
    packed.centers[i * 4 + 3] *= NUCLEUS_VISUAL_SCALE * 1.18;
  }
  const tints = packed.tints;
  if (config.hub) {
    // Hub identity: crystalline OmniRoute-red / neutral core (no model colours).
    for (let i = 0; i < packed.count; i += 1) {
      const c = hexToLinear(tints[i * 4 + 3] > 0.5 ? "#E0102C" : "#5A2CE0");
      tints[i * 4] = c[0];
      tints[i * 4 + 1] = c[1];
      tints[i * 4 + 2] = c[2];
    }
  }
  if (config.neutral) {
    // Restrained blue-silver sheen for unknown / stale attribution.
    for (let i = 0; i < packed.count; i += 1) {
      const c = hexToLinear(tints[i * 4 + 3] > 0.5 ? "#8497B5" : "#4A586E");
      tints[i * 4] = c[0];
      tints[i * 4 + 1] = c[1];
      tints[i * 4 + 2] = c[2];
    }
  }
  const lane = hexToLinear(config.laneHue);
  const known = !config.neutral && packed.modelGroups.length > 0;
  const hub = config.hub;
  const hueSet: [number, number, number][] = hub
    ? HUB_HUES
    : known
      ? [mix3(lane, [0.55, 0.2, 1.0], 0.7), [0.8, 0.22, 0.95], [0.95, 0.32, 0.85]]
      : NEUTRAL_HUES;
  const orient = new Matrix3().setFromMatrix4(
    new Matrix4().makeRotationFromQuaternion(
      new Quaternion()
        .setFromAxisAngle(
          new Vector3(hash01(seed * 0.013) - 0.5, 1, hash01(seed * 0.029) - 0.5).normalize(),
          hash01(seed * 0.007) * Math.PI * 2
        )
        .normalize()
    )
  );
  const orbitals = orbitalLayout(seed);
  const palette = config.neutral ? NEUTRAL_PALETTE : LANE_PALETTE;
  const wires = orbitWires(seed, WIRES_PER_ATOM);
  return {
    signature: signatureOf(config),
    config,
    seed,
    packed,
    nucExtent: packed.extent * NUCLEUS_VISUAL_SCALE,
    orbitals,
    orbitalWeights: orbitals.map((o) => o.weight),
    wires,
    axis: new Vector3(...packed.spinAxis).normalize(),
    orient,
    known,
    hueSet,
    inner: hub ? [0.75, 0.1, 0.55] : known ? [0.5, 0.14, 1.0] : [0.4, 0.5, 0.78],
    strandInner: hub ? [0.85, 0.15, 0.6] : known ? [0.62, 0.16, 1.0] : [0.45, 0.55, 0.8],
    rim: hub || known ? [0.08, 0.85, 1.0] : [0.55, 0.72, 0.95],
    coreColor: hub || known ? [1.0, 0.62, 0.9] : [0.85, 0.9, 1],
    rootColor: hub || known ? [1.0, 0.42, 0.82] : [0.75, 0.82, 1.0],
    palette,
    electronHot: config.neutral ? [0.75, 0.85, 1.0] : [1.0, 0.5, 0.32],
    electronCount: wires.map((_, i) => (i % 3 === 0 ? 2 : 1)),
    flickerClock: 0,
    swirlClock: 0,
    bucket: -1,
    slots: Array.from({ length: BOLT_SLOTS_PER_ATOM }, () => ({
      variant: -1,
      shot: 0,
      dir: new Vector3(),
    })),
  };
}

export interface AtomBatch {
  /** Add to the scene; contains every batched draw. */
  group: Group;
  data: AtomData;
  /** Atoms this batch can hold. */
  capacity: number;
  /** Number of atoms currently configured. */
  count: () => number;
  /** (Re)configure the atom list; unchanged atoms keep their state. */
  configure: (atoms: readonly BatchAtomConfig[]) => void;
  /** Write every atom's row for this frame, sort, set draw counts. */
  update: (frames: readonly BatchAtomFrame[], ctx: BatchFrameContext, offset?: number) => void;
  dispose: () => void;
}

/** Per-unit-overlap gain divisor: atoms whose discs interpenetrate are subdued (no pink-white stack). */
const OVERLAP_SUBDUE = 0.7;

export function createAtomBatch(
  capacity: number,
  registry: RtRegistry = createRtRegistry()
): AtomBatch {
  const data = createAtomData(capacity);
  const cap = data.capacity;
  registry.add(data);
  registry.add(noiseTextureDisposable);
  registry.add(strandGeometryDisposable);
  const group = new Group();

  // --- layers ---------------------------------------------------------------
  // Per-atom impostor draws (fast small-uniform fragment path; see impostorSlot.ts).
  const slots: ImpostorSlot[] = [];
  const slotOwner: (AtomState | null)[] = [];
  const nucScratch = new Float32Array(MAX_NUCLEONS * 4);
  const coreScratch: [number, number, number] = [0, 0, 0];
  const weightScratch: [number, number, number] = [0, 0, 0];
  const strandField: StrandField = createStrandField(data, cap);
  strandField.materials.forEach((m) => registry.add(m));
  strandField.geometries.forEach((g) => registry.add(g));
  const wireLayer: WireLayer = createWireLayer(data);
  registry.add(wireLayer.mesh.geometry);
  registry.add(wireLayer.material);
  const boltLayer: BoltLayer = createBoltLayer(data);
  registry.add(boltLayer.geometry);
  registry.add(boltLayer.material);
  const flareBack: FlareLayer = createFlareLayer(data, "back");
  const flareFront: FlareLayer = createFlareLayer(data, "front");
  for (const f of [flareBack, flareFront]) {
    registry.add(f.mesh.geometry);
    registry.add(f.material);
  }
  wireLayer.mesh.name = "wires";
  boltLayer.mesh.name = "bolts";
  flareBack.mesh.name = "flareBack";
  flareFront.mesh.name = "flareFront";
  group.add(...strandField.meshes, wireLayer.mesh, boltLayer.mesh, flareBack.mesh, flareFront.mesh);

  // --- CPU state --------------------------------------------------------------
  let states: AtomState[] = [];
  const byId = new Map<string, AtomState>();
  const camRight = new Vector3();
  const camUp = new Vector3();
  const camFwd = new Vector3();
  const worldCenter = new Vector3();
  const tmp = new Vector3();
  const viewDir = new Vector3();
  const rot = new Quaternion();
  const viewProj = new Matrix4();
  const planes = createFrustumPlanes();
  const dyn = data.dynArr;
  const bucketOfRow: number[] = [];
  // Screen-space overlap scratch (per row): x, y (view-plane), r (angular radius).
  let projBuf = new Float32Array(0);
  let overlapBuf = new Float32Array(0);
  const stat = data.statArr;

  function put4(arr: Float32Array, o: number, x: number, y: number, z: number, w: number): void {
    arr[o] = x;
    arr[o + 1] = y;
    arr[o + 2] = z;
    arr[o + 3] = w;
  }

  function setF(row: number, idx: number, x: number, y: number, z: number, w: number): void {
    put4(data.fieldsArr, (row * FIELD_COUNT + idx) * 4, x, y, z, w);
  }

  function set4(
    arr: Float32Array,
    cols: number,
    row: number,
    col: number,
    x: number,
    y: number,
    z: number,
    w: number
  ): void {
    const o = texelOffset(row, col, cols);
    arr[o] = x;
    arr[o + 1] = y;
    arr[o + 2] = z;
    arr[o + 3] = w;
  }

  function writeStatic(row: number, st: AtomState): void {
    // Clear, then write tints + wire definitions.
    stat.fill(0, texelOffset(row, 0, STATIC_COLS), texelOffset(row + 1, 0, STATIC_COLS));

    st.wires.forEach((w, i) => {
      if (i >= WIRES_PER_ATOM) return;
      const c = WIRE_DEF_BASE + i * WIRE_DEF_TEXELS;
      const lane = st.palette[i % st.palette.length];
      set4(stat, STATIC_COLS, row, c, w.u[0], w.u[1], w.u[2], w.a);
      set4(stat, STATIC_COLS, row, c + 1, w.v[0], w.v[1], w.v[2], w.b);
      set4(stat, STATIC_COLS, row, c + 2, lane[0], lane[1], lane[2], i % 4 === 0 ? 3.6 : 2.9);
      set4(
        stat,
        STATIC_COLS,
        row,
        c + 3,
        st.electronHot[0],
        st.electronHot[1],
        st.electronHot[2],
        w.speed
      );
    });
  }

  function configure(atoms: readonly BatchAtomConfig[]): void {
    const next: AtomState[] = [];
    const used = new Set<string>();
    atoms.slice(0, cap).forEach((cfg, row) => {
      const sig = signatureOf(cfg);
      // A duplicate id in one list gets its own state (rows never share clocks/bolts).
      const prev = used.has(cfg.id) ? undefined : byId.get(cfg.id);
      const st = prev && prev.signature === sig ? prev : buildAtomState(cfg);
      used.add(cfg.id);
      byId.set(cfg.id, st);
      next.push(st);
      writeStatic(row, st);
    });
    for (const id of [...byId.keys()]) if (!used.has(id)) byId.delete(id);
    states = next;
    data.stat.needsUpdate = true;
    while (slots.length < states.length) {
      const slot = createImpostorSlot(registry);
      slot.mesh.name = "impostor";
      slot.mirror.name = "impostorMirror";
      slots.push(slot);
      slotOwner.push(null);
      group.add(slot.mirror, slot.mesh);
    }
    slots.forEach((slot, i) => {
      const st = states[i];
      slot.mesh.visible = !!st;
      slot.mirror.visible = !!st;
      if (st && slotOwner[i] !== st) {
        slotOwner[i] = st;
        slot.setStatic({
          hues: st.hueSet,
          inner: st.inner,
          rim: st.rim,
          coreColor: st.coreColor,
          axes: st.orbitals.map((o) => o.axis),
          lobeKind: [st.orbitals[0].l, st.orbitals[1].l, st.orbitals[2].l],
          peaks: [st.orbitals[0].radialPeak, st.orbitals[1].radialPeak, st.orbitals[2].radialPeak],
          orient: st.orient,
          tints: st.packed.tints,
          count: st.packed.count,
          glassRadius: st.nucExtent * 1.14,
        });
      }
    });
    wireLayer.setCount(states.length);
    boltLayer.setCount(states.length);
    flareBack.setCount(states.length);
    flareFront.setCount(states.length);
  }

  function update(frames: readonly BatchAtomFrame[], ctx: BatchFrameContext, offset = 0): void {
    const { camera, dt, reducedMotion } = ctx;
    camera.updateMatrixWorld(true);
    camera.matrixWorld.extractBasis(camRight, camUp, camFwd);
    const camPos = camera.position;
    const fov = (camera as { fov?: number }).fov ?? 32;
    const pxH = ctx.pixelHeight > 0 ? ctx.pixelHeight : 1882;
    const pxScale = (2 * Math.tan((fov * Math.PI) / 360)) / pxH;
    const n = Math.min(states.length, Math.max(0, frames.length - offset));
    const cullOn = ctx.cull !== false;
    if (cullOn) {
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      extractFrustumPlanes(viewProj.elements, planes);
    }
    // Overlap pre-pass: atoms whose projected discs interpenetrate stack additive
    // light into pink-white. Each atom is subdued by how much of its disc is
    // covered by neighbours of comparable or larger projected size, so a lone
    // or well-separated atom (approved single/pair/close views) is unchanged.
    if (projBuf.length < n * 3) {
      projBuf = new Float32Array(n * 3);
      overlapBuf = new Float32Array(n);
    }
    for (let row = 0; row < n; row += 1) {
      const fr = frames[offset + row];
      const scl = fr.scale != null && Number.isFinite(fr.scale) && fr.scale > 0 ? fr.scale : 1;
      const mul = Number.isFinite(fr.energy.cloudRadiusMul) ? fr.energy.cloudRadiusMul : 0.8;
      const rr = Math.min(1, Math.max(0.5, mul)) * CLOUD_BOUND_RADIUS * scl;
      const dx = fr.position[0] - camPos.x;
      const dy = fr.position[1] - camPos.y;
      const dz = fr.position[2] - camPos.z;
      const depth = Math.max(1e-3, dx * camFwd.x + dy * camFwd.y + dz * camFwd.z) || 1e-3;
      projBuf[row * 3] = (dx * camRight.x + dy * camRight.y + dz * camRight.z) / Math.abs(depth);
      projBuf[row * 3 + 1] = (dx * camUp.x + dy * camUp.y + dz * camUp.z) / Math.abs(depth);
      projBuf[row * 3 + 2] = rr / Math.abs(depth);
    }
    for (let i = 0; i < n; i += 1) {
      let acc = 0;
      const xi = projBuf[i * 3];
      const yi = projBuf[i * 3 + 1];
      const ri = projBuf[i * 3 + 2];
      for (let j = 0; j < n; j += 1) {
        if (j === i) continue;
        const rj = projBuf[j * 3 + 2];
        const d = Math.hypot(projBuf[j * 3] - xi, projBuf[j * 3 + 1] - yi);
        const reachSum = ri + rj;
        if (d >= reachSum) continue;
        const cover = Math.min(1, (reachSum - d) / Math.max(1e-6, Math.min(ri, rj) * 2));
        acc += cover * Math.min(1.2, rj / Math.max(1e-6, ri));
      }
      overlapBuf[i] = acc;
    }
    for (let row = 0; row < n; row += 1) {
      const st = states[row];
      const f = frames[offset + row];
      // Projected radius of the cloud in device px (for the march-step scale).
      const projRadiusPx = projBuf[row * 3 + 2] / pxScale;
      // Small-atom LOD weight: 1 below ~340 device px of cloud diameter (bold flower
      // silhouette), cross-fading to the full ray-traced atom by ~620 px.
      const lodMul = Number.isFinite(f.energy.cloudRadiusMul) ? f.energy.cloudRadiusMul : 0.8;
      const lodScale = f.scale != null && Number.isFinite(f.scale) && f.scale > 0 ? f.scale : 1;
      const lodDist = Math.max(
        1e-3,
        Math.hypot(f.position[0] - camPos.x, f.position[1] - camPos.y, f.position[2] - camPos.z)
      );
      const lodRadiusPx =
        (Math.min(1, Math.max(0.5, lodMul)) * CLOUD_BOUND_RADIUS * lodScale) / lodDist / pxScale;
      const smallLod = smallAtomLod(lodRadiusPx * 2);
      const params = clampShaderParams({
        marchSteps: cullOn ? marchStepsFor(f.marchSteps, projRadiusPx) : f.marchSteps,
        exposure: 1,
        excitation: f.energy.excitation,
        saturation: f.energy.saturation,
        brightness: f.energy.brightness,
        cloudRadiusMul: f.energy.cloudRadiusMul,
        nucleonCount: st.packed.count,
        orbitalWeights: st.orbitalWeights,
        phase: f.phase,
      });
      // Idle atoms settle INTO the glass dome: the drop grows smoothly with the
      // radius given up, full at the tightest cloud (CLOUD_RADIUS_MIN).
      const settle = Math.min(
        1,
        Math.max(0, CLOUD_BOUND_RADIUS - params.cloudRadius) /
          (CLOUD_BOUND_RADIUS * (1 - CLOUD_RADIUS_MIN))
      );
      const sc = f.scale != null && Number.isFinite(f.scale) && f.scale > 0 ? f.scale : 1;
      const alert =
        f.alert != null && Number.isFinite(f.alert) ? Math.min(1, Math.max(0, f.alert)) : 0;
      const ne = st.nucExtent * sc;
      worldCenter.set(f.position[0], f.position[1] - settle * IDLE_SEAT_DROP * sc, f.position[2]);

      // Nucleus spin (measured-TPS driven by the caller; static when 0), in world space.
      rot.setFromAxisAngle(st.axis, f.spinAngle);
      const pc = st.packed.centers;
      for (let i = 0; i < st.packed.count; i += 1) {
        tmp
          .set(pc[i * 4], pc[i * 4 + 1], pc[i * 4 + 2])
          .applyQuaternion(rot)
          .multiplyScalar(sc);
        put4(
          nucScratch,
          i * 4,
          tmp.x + worldCenter.x,
          tmp.y + worldCenter.y,
          tmp.z + worldCenter.z,
          pc[i * 4 + 3] * sc
        );
      }

      const dist = camPos.distanceTo(worldCenter);
      const cr = params.cloudRadius * sc;
      // Projected size vs the default single-atom view (dist 255 at full radius):
      // hairline/mote overlap per pixel grows as the atom shrinks on screen.
      const crowd = Math.min(1, Math.max(0.15, 255 / CLOUD_BOUND_RADIUS / (dist / cr)));
      const farK = Math.min(1, Math.max(0, (dist / cr - 3.2) / 3.3));
      const closeK = Math.min(1, Math.max(0.4, dist / (cr * 4.2)));
      const half = ((cr * dist) / Math.sqrt(Math.max(dist * dist - cr * cr, 1))) * 1.08;
      const reach = 0.78 + 0.22 * params.excitation;
      const exc = params.excitation;
      // Overdraw subdue is for bright (excited) clouds; a dim idle cloud keeps
      // more of its gain when small on screen so it still reads as an atom.
      const dim = f.dim != null && Number.isFinite(f.dim) ? Math.min(1, Math.max(0.1, f.dim)) : 1;
      const idleK = Math.min(1, Math.max(0, 1 - (exc - 0.12) / 0.88));
      const crowdS = crowd + (1 - crowd) * 0.3 * idleK;
      const crowdG = Math.max(0.12 * dim, (dim * crowdS) / (1 + OVERLAP_SUBDUE * overlapBuf[row]));
      const bri = params.brightness;
      // Visibility: an atom (or its floor reflection) wholly outside the view
      // frustum draws nothing. The radius covers the quad, glass and flares.
      const visR = Math.max(half, cr * 1.6);
      const rowVisible =
        !cullOn ||
        sphereVisible(planes, worldCenter.x, worldCenter.y, worldCenter.z, visR) ||
        sphereVisible(
          planes,
          worldCenter.x,
          2 * (floorY.value as number) - worldCenter.y,
          worldCenter.z,
          visR
        );
      // Size-driven part of the gain keeps a floor so a lone atom still reads as a
      // dense violet flower at default distance (finding: glassy orbs); the
      // overlap divisor is NOT floored, so crowds still never wash out.
      const readS = (dim * Math.max(crowdS, 0.5)) / (1 + OVERLAP_SUBDUE * overlapBuf[row]);

      // Decorative differential swirl: rate rises with energy, never encodes
      // throughput; frozen (still-rich frame) under reduced motion.
      st.swirlClock += reducedMotion || !(dt > 0) ? 0 : Math.min(dt, 0.25) * (0.1 + 0.16 * exc);
      st.flickerClock += reducedMotion || !(dt > 0) ? 0 : Math.min(dt, 0.25);

      const o = st.orbitals;
      setF(row, FIELD.CENTER_CLOUD_R, worldCenter.x, worldCenter.y, worldCenter.z, cr);
      setF(row, FIELD.RIGHT_QUADHALF, camRight.x, camRight.y, camRight.z, half);
      setF(row, FIELD.UP_GLASS_R, camUp.x, camUp.y, camUp.z, ne * 1.14);
      setF(row, FIELD.ENERGY_PHASE, exc, params.saturation, bri, params.phase);
      setF(
        row,
        FIELD.WEIGHTS_MEDIUM,
        o[0].weight * params.orbitalWeights[0] * 3,
        o[1].weight * params.orbitalWeights[1] * 3,
        o[2].weight * params.orbitalWeights[2] * 3,
        // Absorbing plasma body thins out in the low-energy (idle) state so it
        // greys and calms instead of reading as a dark sooty ball.
        MEDIUM_K * bri * bri
      );
      setF(row, FIELD.FAR_CROWD_REACH_STEPS, farK, crowdG, reach, params.marchSteps);
      setF(row, FIELD.LOBE_NCOUNT, o[0].l, o[1].l, o[2].l, st.packed.count);
      setF(
        row,
        FIELD.PEAKS_SWIRL,
        o[0].radialPeak,
        o[1].radialPeak,
        o[2].radialPeak,
        st.swirlClock
      );
      const m = st.orient.elements; // column-major: row i = (m[i], m[i+3], m[i+6])
      setF(row, FIELD.ORIENT0_ROOT_R, m[0], m[3], m[6], Math.min(0.4, (ne * 0.8) / cr));
      // Projected-size strand LOD (1 at the approved default/close views): draw
      // the lit strands of a smaller rank prefix, each brightened by 1/lod.
      const lod = strandLod(crowd);
      const activeFrac = activeStrandFraction(exc, bri);
      const litFrac = activeFrac * lod;
      st.bucket = strandBucket(litFrac, st.bucket);
      bucketOfRow[row] = rowVisible ? st.bucket : -1;
      slots[row].mesh.visible = rowVisible;
      slots[row].mirror.visible = rowVisible;
      setF(row, FIELD.ORIENT1_ACTIVE, m[1], m[4], m[7], litFrac);
      setF(
        row,
        FIELD.SPARE1,
        Math.pow(crowdG, 2.8) * (1 - 0.9 * smallLod),
        activeFrac,
        alert,
        smallLod
      );
      setF(row, FIELD.ORIENT2_PX, m[2], m[5], m[8], pxScale);
      setF(
        row,
        FIELD.HUE0_LIFE,
        st.hueSet[0][0],
        st.hueSet[0][1],
        st.hueSet[0][2],
        reducedMotion ? 0 : 1
      );
      setF(row, FIELD.HUE1_OCC, st.hueSet[1][0], st.hueSet[1][1], st.hueSet[1][2], ne * 0.92);
      setF(
        row,
        FIELD.HUE2_WIRESCALE,
        st.hueSet[2][0],
        st.hueSet[2][1],
        st.hueSet[2][2],
        (cr / CLOUD_BOUND_RADIUS) * 1.18
      );
      setF(row, FIELD.INNER_WIRETIME, st.inner[0], st.inner[1], st.inner[2], f.phase * 2.2);
      setF(
        row,
        FIELD.RIM_WIREENERGY,
        st.rim[0],
        st.rim[1],
        st.rim[2],
        (0.35 + 0.9 * bri) *
          0.8 *
          (1 - 0.7 * farK) *
          Math.pow(Math.max(crowdG, readS * 0.9), 1.0) *
          (1 - 0.2 * smallLod)
      );
      setF(
        row,
        FIELD.CORE_STRANDCROWD,
        st.coreColor[0],
        st.coreColor[1],
        st.coreColor[2],
        (Math.pow(Math.max(crowdG, readS * 0.8), 1.2) / Math.pow(lod, 0.75)) * (1 - 0.93 * smallLod)
      );
      setF(
        row,
        FIELD.ROOT_STREAK,
        st.rootColor[0],
        st.rootColor[1],
        st.rootColor[2],
        (0.2 + 1.0 * exc) * bri * closeK
      );
      setF(
        row,
        FIELD.AXIS0_GLOW,
        o[0].axis[0],
        o[0].axis[1],
        o[0].axis[2],
        (0.3 + 1.3 * exc) * bri * (1 + 0.3 * farK) * Math.sqrt(crowdG)
      );
      setF(
        row,
        FIELD.AXIS1_RING,
        o[1].axis[0],
        o[1].axis[1],
        o[1].axis[2],
        (0.3 + 0.7 * exc) * bri
      );
      setF(row, FIELD.AXIS2_FLAGS, o[2].axis[0], o[2].axis[1], o[2].axis[2], st.config.hub ? 1 : 0);
      setF(row, FIELD.SPARE0, st.strandInner[0], st.strandInner[1], st.strandInner[2], 0);

      weightScratch[0] = o[0].weight * params.orbitalWeights[0] * 3;
      weightScratch[1] = o[1].weight * params.orbitalWeights[1] * 3;
      weightScratch[2] = o[2].weight * params.orbitalWeights[2] * 3;
      // Failure flash: the hot core shifts toward red (never a model hue).
      coreScratch[0] = st.coreColor[0] + (1.0 - st.coreColor[0]) * alert;
      coreScratch[1] = st.coreColor[1] + (0.12 - st.coreColor[1]) * alert;
      coreScratch[2] = st.coreColor[2] + (0.08 - st.coreColor[2]) * alert;
      slots[row].update({
        center: worldCenter,
        camRight,
        camUp,
        quadHalf: half,
        cloudRadius: cr,
        far: farK,
        crowd: Math.max(crowdG, readS * 0.85),
        excitation: exc,
        saturation: params.saturation,
        brightness: bri,
        phase: params.phase,
        mediumK: MEDIUM_K * bri * bri,
        steps: params.marchSteps,
        weights: weightScratch,
        reach,
        coreColor: coreScratch,
        floorY: floorY.value as number,
        nucleons: nucScratch,
        glassRadius: ne * 1.14,
        lod: smallLod,
      });

      // Electron angles per wire (heads ride the wire shader).
      let eIdx = 0;
      for (let w = 0; w < WIRES_PER_ATOM; w += 1) {
        const wd = st.wires[w];
        const th = (k: number): number => {
          const v = wd.phase + f.phase * wd.speed * 1.4 + (eIdx + k) * 1.3 + k * Math.PI;
          return ((v % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        };
        const two = st.electronCount[w] > 1;
        set4(dyn, DYN_COLS, row, ELECTRON_BASE + w, th(0), two ? th(1) : -100, 0, 0);
        eIdx += st.electronCount[w];
      }

      // Lightning: only for excited, measured state; static in reduced motion.
      // Fewer, thinner bolts: only the first four slots ever fire.
      const reachB = cr;
      for (let s = 0; s < BOLT_SLOTS_PER_ATOM; s += 1) {
        const slot = st.slots[s];
        const on = f.energy.measured && exc > BOLT_THRESHOLDS[s];
        const flick = reducedMotion
          ? 0.7
          : 0.65 + 0.35 * Math.abs(Math.sin(st.flickerClock * (9 + s * 3) + s));
        const v = reducedMotion
          ? 0
          : ((Math.floor(st.flickerClock * 7 + s * 2) % BOLT_VARIANT_COUNT) + BOLT_VARIANT_COUNT) %
            BOLT_VARIANT_COUNT;
        if (v !== slot.variant) {
          slot.variant = v;
          slot.shot += 1;
          // New discharge: seeded direction from the core out to the cloud,
          // biased perpendicular to the view so it reads as a radiating tendril.
          const hs = st.seed * 0.001 + s * 17.3 + slot.shot * 3.7;
          const zz = hash01(hs) * 2 - 1;
          const az = hash01(hs + 9.1) * Math.PI * 2;
          const rr = Math.sqrt(1 - zz * zz);
          slot.dir.set(rr * Math.cos(az), zz, rr * Math.sin(az));
          viewDir.copy(camPos).sub(worldCenter).normalize();
          slot.dir.addScaledVector(viewDir, -0.75 * slot.dir.dot(viewDir)).normalize();
        }
        const intensity = on ? flick * (0.4 + 0.5 * exc) * closeK * closeK : 0;
        const base = BOLT_BASE + s * BOLT_TEXELS;
        const len = reachB * (0.78 + 0.16 * hash01(s * 5.3 + slot.shot));
        const col = st.palette[(s % 5) % st.palette.length];
        set4(dyn, DYN_COLS, row, base, worldCenter.x, worldCenter.y, worldCenter.z, intensity);
        set4(
          dyn,
          DYN_COLS,
          row,
          base + 1,
          worldCenter.x + slot.dir.x * len,
          worldCenter.y + slot.dir.y * len,
          worldCenter.z + slot.dir.z * len,
          slot.variant
        );
        set4(dyn, DYN_COLS, row, base + 2, col[0], col[1], col[2], 0);
      }
    }
    bucketOfRow.length = n;
    strandField.setBuckets(bucketOfRow);
    // Upload only the rows in use (one writeBuffer each), not the whole capacity.
    if (n > 0) {
      data.fieldsNode.clearUpdateRanges();
      data.fieldsNode.addUpdateRange(0, n * FIELD_COUNT * 4);
      data.dynNode.clearUpdateRanges();
      data.dynNode.addUpdateRange(0, n * DYN_COLS * 4);
    }
  }

  return {
    group,
    data,
    capacity: cap,
    count: () => states.length,
    configure,
    update,
    dispose: () => {
      registry.disposeAll();
    },
  };
}

export { floorY };
void STATIC_COLS;

/**
 * A growable set of batches (each limited by the backend's uniform-block size)
 * presenting one atom list. Batches are created on demand and kept for reuse.
 */
export interface AtomBatchSet {
  group: Group;
  configure: (atoms: readonly BatchAtomConfig[]) => void;
  update: (frames: readonly BatchAtomFrame[], ctx: BatchFrameContext) => void;
  /** Total draw-call groups (batches) currently live. */
  batchCount: () => number;
  dispose: () => void;
}

export function createAtomBatchSet(
  capacityPerBatch: number,
  registry: RtRegistry = createRtRegistry()
): AtomBatchSet {
  const group = new Group();
  const batches: AtomBatch[] = [];
  const cap = Math.max(1, Math.floor(capacityPerBatch));
  let total = 0;
  return {
    group,
    configure(atoms) {
      total = atoms.length;
      const needed = Math.ceil(total / cap);
      while (batches.length < needed) {
        const b = createAtomBatch(cap, registry);
        batches.push(b);
        group.add(b.group);
      }
      batches.forEach((b, i) => {
        const slice = atoms.slice(i * cap, (i + 1) * cap);
        b.configure(slice);
        b.group.visible = slice.length > 0;
      });
    },
    update(frames, ctx) {
      batches.forEach((b, i) => {
        if (i * cap >= total) return;
        b.update(frames, ctx, i * cap);
      });
    },
    batchCount: () => Math.ceil(total / cap),
    dispose: () => registry.disposeAll(),
  };
}
