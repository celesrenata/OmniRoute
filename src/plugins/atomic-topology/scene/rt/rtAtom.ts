/**
 * One ray-traced atom: nucleus + glass + volumetric cloud impostor (plus a
 * mirrored floor reflection), orbital wires, electrons and lightning. Imports
 * `three` only via `three/webgpu`. All per-frame work writes into preallocated
 * uniform storage; there is no React state and no per-frame allocation of GPU
 * resources.
 */
import {
  AdditiveBlending,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
  type Camera,
} from "three/webgpu";
import { abs, exp, float, length, smoothstep, uniform, uv, vec3, vec4 } from "three/tsl";
import { fnv1a } from "../cloudShells";
import type { EnergyState } from "../energyState";
import { desaturateLinear, hexToLinear, packNucleus, type PackedNucleus } from "../nucleonPack";
import { orbitalLayout, orbitWires, type Orbital, type OrbitWire } from "../orbitalDensity";
import {
  ATOM_WORLD_RADIUS,
  CLOUD_BOUND_RADIUS,
  clampShaderParams,
  MAX_NUCLEONS,
} from "../shaderParams";
import {
  createAtomMaterial,
  createAtomUniforms,
  noiseTextureDisposable,
  type AtomUniforms,
} from "../shaders/atomImpostor";
import {
  createBoltMaterial,
  createBoltUniforms,
  createBoltVariants,
  type BoltUniforms,
} from "../shaders/boltStrand";
import { createWireMesh, createWireUniforms, type WireUniforms } from "../shaders/orbitWire";
import {
  createStrandField,
  createStrandUniforms,
  strandGeometryDisposable,
} from "../shaders/plasmaStrands";
import { activeStrandFraction } from "../strandField";
import { FLOOR_Y } from "../shaders/environment";
import { createRtRegistry, type RtRegistry } from "./rtRegistry";

export interface RtAtomOptions {
  id: string;
  hub: boolean;
  observedModelIds?: readonly string[];
  /** Lane hue (hex) used for the rim/inner tone when models are known. */
  laneHue: string;
  position: [number, number, number];
  /** Unknown / stale attribution: restrained blue-silver, never a model colour. */
  neutral: boolean;
  wireCount?: number;
}

export interface RtAtomFrame {
  dt: number;
  camera: Camera;
  energy: EnergyState;
  phase: number;
  spinAngle: number;
  reducedMotion: boolean;
  marchSteps: number;
  time: number;
  /** Drawing-buffer height in device pixels (screen-space hairline widths). */
  pixelHeight?: number;
}

const BOLT_SLOTS = 8;
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
const BOLT_VARIANTS = 3;
/**
 * Visual nucleus scale relative to the packed production cluster: idea5 shows
 * a small crystalline gem (~1/4 of the cloud diameter), not a large ball.
 */
export const NUCLEUS_VISUAL_SCALE = 0.48;
/** Deterministic hash in [0, 1) (bolt directions; no Math.random). */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
/** Extinction of the absorbing cloud body at full (excited) brightness. */
const MEDIUM_K = 0.3;
const NEUTRAL_HUES: [number, number, number][] = [
  [0.42, 0.52, 0.78],
  [0.35, 0.5, 0.85],
  [0.5, 0.58, 0.8],
];

export interface RtAtom {
  group: Group;
  uniforms: AtomUniforms;
  packed: PackedNucleus;
  update: (f: RtAtomFrame) => void;
  dispose: () => void;
}

export function createRtAtom(
  opts: RtAtomOptions,
  registry: RtRegistry = createRtRegistry()
): RtAtom {
  const seed = fnv1a(opts.id);
  const packed = packNucleus({ seed, hub: opts.hub, observedModelIds: opts.observedModelIds });
  // Positions shrink more than radii, so nucleons fuse into one lumpy gem.
  for (let i = 0; i < packed.count; i += 1) {
    for (let k = 0; k < 3; k += 1) packed.centers[i * 4 + k] *= NUCLEUS_VISUAL_SCALE;
    packed.centers[i * 4 + 3] *= NUCLEUS_VISUAL_SCALE * 1.18;
  }
  const nucExtent = packed.extent * NUCLEUS_VISUAL_SCALE;
  const orbitals: Orbital[] = orbitalLayout(seed);
  const wiresDef: OrbitWire[] = orbitWires(seed, opts.wireCount ?? 11);
  const group = new Group();
  group.position.set(...opts.position);
  const seatBaseY = opts.position[1];

  const uniforms = createAtomUniforms();
  const material = createAtomMaterial(uniforms);
  const quad = new PlaneGeometry(2, 2);
  const mesh = new Mesh(quad, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  group.add(mesh);
  registry.add(material);
  registry.add(quad);
  registry.add(noiseTextureDisposable);

  // Mirrored floor reflection (same ray-traced shader, reflected rays).
  const mirrorUniforms = createAtomUniforms();
  const mirrorMaterial = createAtomMaterial(mirrorUniforms);
  const mirrorMesh = new Mesh(quad, mirrorMaterial);
  mirrorMesh.frustumCulled = false;
  mirrorMesh.renderOrder = 2;
  group.add(mirrorMesh);
  registry.add(mirrorMaterial);

  // Hub identity: crystalline OmniRoute-red / neutral core (no model colours).
  const centers = packed.centers;
  const tintsArr = packed.tints;
  if (opts.hub) {
    for (let i = 0; i < packed.count; i += 1) {
      const proton = tintsArr[i * 4 + 3] > 0.5;
      const c = hexToLinear(proton ? "#E0102C" : "#5A2CE0");
      tintsArr[i * 4] = c[0];
      tintsArr[i * 4 + 1] = c[1];
      tintsArr[i * 4 + 2] = c[2];
    }
  }
  if (opts.neutral) {
    // Restrained blue-silver sheen for unknown / stale attribution.
    for (let i = 0; i < packed.count; i += 1) {
      const proton = tintsArr[i * 4 + 3] > 0.5;
      const c = hexToLinear(proton ? "#8497B5" : "#4A586E");
      tintsArr[i * 4] = c[0];
      tintsArr[i * 4 + 1] = c[1];
      tintsArr[i * 4 + 2] = c[2];
    }
  }

  // Orbital hues: model colours when known, else neutral silver-blue.
  const lane = hexToLinear(opts.laneHue);
  const known = !opts.neutral && packed.modelGroups.length > 0;
  // Cloud colour is LANE-hued (violet/magenta interior grading to a cyan rim);
  // model identity lives in the nucleus. Unknown / stale stays neutral silver-blue.
  const hubHues: [number, number, number][] = [
    [0.95, 0.18, 0.3],
    [0.62, 0.16, 1.0],
    [0.1, 0.65, 1.0],
  ];
  const hueSet: [number, number, number][] = opts.hub
    ? hubHues
    : known
      ? [mix3(lane, [0.55, 0.2, 1.0], 0.7), [0.8, 0.22, 0.95], [0.95, 0.32, 0.85]]
      : NEUTRAL_HUES;
  uniforms.hues.forEach((h, i) => (h.value as Vector3).set(...hueSet[i]));
  (uniforms.inner.value as Vector3).set(
    ...(opts.hub ? [0.75, 0.1, 0.55] : known ? [0.5, 0.14, 1.0] : [0.4, 0.5, 0.78])
  );
  (uniforms.rim.value as Vector3).set(
    ...(opts.hub || known ? [0.08, 0.85, 1.0] : [0.55, 0.72, 0.95])
  );
  (uniforms.coreColor.value as Vector3).set(
    ...(opts.hub || known ? [1.0, 0.62, 0.9] : [0.85, 0.9, 1])
  );
  orbitals.forEach((o, i) => {
    (uniforms.axes[i].value as Vector3).set(...o.axis);
  });
  (uniforms.lobeKind.value as Vector3).set(orbitals[0].l, orbitals[1].l, orbitals[2].l);
  (uniforms.peaks.value as Vector3).set(
    orbitals[0].radialPeak,
    orbitals[1].radialPeak,
    orbitals[2].radialPeak
  );
  mirrorUniforms.hues.forEach((h, i) =>
    (h.value as Vector3).copy(uniforms.hues[i].value as Vector3)
  );
  mirrorUniforms.axes.forEach((a, i) =>
    (a.value as Vector3).copy(uniforms.axes[i].value as Vector3)
  );
  (mirrorUniforms.lobeKind.value as Vector3).copy(uniforms.lobeKind.value as Vector3);
  (mirrorUniforms.peaks.value as Vector3).copy(uniforms.peaks.value as Vector3);
  (mirrorUniforms.inner.value as Vector3).copy(uniforms.inner.value as Vector3);
  (mirrorUniforms.rim.value as Vector3).copy(uniforms.rim.value as Vector3);
  (mirrorUniforms.coreColor.value as Vector3).copy(uniforms.coreColor.value as Vector3);
  (mirrorUniforms.mirror as any).value = 1;
  (mirrorUniforms.floorY as any).value = FLOOR_Y;
  (uniforms.floorY as any).value = FLOOR_Y;

  // Nucleon uniform arrays (rotated about the spin axis every frame).
  const nucArray = (uniforms.nucleonCenters as any).array as {
    set: (x: number, y: number, z: number, w: number) => void;
  }[];
  const tintArray = (uniforms.nucleonTints as any).array as {
    set: (x: number, y: number, z: number, w: number) => void;
  }[];
  const mirrorNuc = (mirrorUniforms.nucleonCenters as any).array as typeof nucArray;
  const mirrorTint = (mirrorUniforms.nucleonTints as any).array as typeof tintArray;
  for (let i = 0; i < MAX_NUCLEONS; i += 1) {
    tintArray[i].set(
      tintsArr[i * 4],
      tintsArr[i * 4 + 1],
      tintsArr[i * 4 + 2],
      tintsArr[i * 4 + 3]
    );
    mirrorTint[i].set(
      tintsArr[i * 4],
      tintsArr[i * 4 + 1],
      tintsArr[i * 4 + 2],
      tintsArr[i * 4 + 3]
    );
  }
  (uniforms.nucleonCount as any).value = packed.count;
  (mirrorUniforms.nucleonCount as any).value = packed.count;
  (uniforms.glassRadius as any).value = nucExtent * 1.14;
  (mirrorUniforms.glassRadius as any).value = nucExtent * 1.14;

  // Wires + electrons: screen-space hairline ribbons; electrons are small HDR
  // heads with short trails evaluated in the wire shader (no orb meshes).
  const wireU: WireUniforms = createWireUniforms();
  (wireU.occluderRadius as any).value = nucExtent * 0.92;
  const wireGroup = new Group();
  group.add(wireGroup);
  const palette = opts.neutral ? NEUTRAL_PALETTE : LANE_PALETTE;
  const electronHot: [number, number, number] = opts.neutral ? [0.75, 0.85, 1.0] : [1.0, 0.5, 0.32];
  const wireElectrons: { set: (x: number, y: number) => void }[] = [];
  const electronCount: number[] = [];
  wiresDef.forEach((w, i) => {
    const wm = createWireMesh(
      w,
      i,
      wireU,
      i % 4 === 0 ? 2.0 : 1.5,
      palette[i % palette.length],
      electronHot
    );
    wireGroup.add(wm.mesh);
    registry.add(wm.mesh.geometry);
    registry.add(wm.mesh.material as { dispose: () => void });
    wireElectrons.push(wm.electrons.value as unknown as { set: (x: number, y: number) => void });
    electronCount.push(i % 3 === 0 ? 2 : 1);
  });

  // Plasma strand field: thousands of GPU hairline strands + rim sparkles.
  const strandU = createStrandUniforms();
  const field = createStrandField(strandU);
  group.add(field.strands, field.sparkles, field.mirror);
  field.materials.forEach((m) => registry.add(m));
  registry.add(strandGeometryDisposable);
  (strandU.occluderRadius as any).value = nucExtent * 0.92;
  (strandU.floorY as any).value = FLOOR_Y;
  // Seeded per-atom orientation of the petal field (shared with the body march).
  const orientM4 = new Matrix4().makeRotationFromQuaternion(
    new Quaternion()
      .setFromAxisAngle(
        new Vector3(hash01(seed * 0.013) - 0.5, 1, hash01(seed * 0.029) - 0.5).normalize(),
        hash01(seed * 0.007) * Math.PI * 2
      )
      .normalize()
  );
  const orientM3 = new Matrix3().setFromMatrix4(orientM4);
  (strandU.orient.value as Matrix3).copy(orientM3);
  (uniforms.orient.value as Matrix3).copy(orientM3);
  (mirrorUniforms.orient.value as Matrix3).copy(orientM3);
  // Strand colours: hot root -> violet/magenta body -> cyan tip (lane graded).
  (strandU.inner.value as Vector3).set(
    ...(opts.hub ? [0.85, 0.15, 0.6] : known ? [0.62, 0.16, 1.0] : [0.45, 0.55, 0.8])
  );
  (strandU.rim.value as Vector3).copy(uniforms.rim.value as Vector3);
  (strandU.root.value as Vector3).set(
    ...(opts.hub || known ? [1.0, 0.42, 0.82] : [0.75, 0.82, 1.0])
  );

  // Lightning bolts: nucleus -> electrons (excited state only).
  const boltGroup = new Group();
  group.add(boltGroup);
  const boltSlots: {
    u: BoltUniforms;
    meshes: Mesh[];
    variants: ReturnType<typeof createBoltVariants>;
    variant: number;
    /** Unit direction core -> cloud for the current discharge. */
    dir: Vector3;
    shot: number;
  }[] = [];
  for (let s = 0; s < BOLT_SLOTS; s += 1) {
    const bu = createBoltUniforms();
    const variants = createBoltVariants(seed + s * 131, BOLT_VARIANTS);
    variants.forEach((v) => registry.add(v));
    const bc = (opts.neutral ? NEUTRAL_PALETTE : LANE_PALETTE)[(s % 5) % (opts.neutral ? 3 : 5)];
    const halo = new Mesh(
      variants[0],
      createBoltMaterial(bu, { halo: true, color: bc, width: 0.17, coreRatio: 0.3 })
    );
    halo.frustumCulled = false;
    halo.renderOrder = 12;
    registry.add(halo.material as { dispose: () => void });
    boltGroup.add(halo);
    (bu.occluderRadius as any).value = nucExtent * 0.92;
    boltSlots.push({ u: bu, meshes: [halo], variants, variant: -1, dir: new Vector3(), shot: 0 });
  }

  // Wide anamorphic equatorial streak (camera-facing, HDR -> bloom), the
  // horizontal cyan flare of the reference. Brightness follows excitation.
  const streakK = uniform(0);
  const streakMat = new SpriteNodeMaterial();
  streakMat.colorNode = (() => {
    const p = uv().sub(0.5).mul(2);
    const ax = abs(p.x);
    // Notch the centre so the streak never washes the nucleus gem.
    const notch = smoothstep(0.05, 0.17, ax).mul(0.9).add(0.1);
    const core = exp(p.y.div(0.08).pow(2).negate())
      .mul(exp(ax.mul(-2.6)))
      .mul(notch);
    const wide = exp(p.y.div(0.38).pow(2).negate())
      .mul(exp(ax.mul(-5)))
      .mul(0.35)
      .mul(notch);
    const fade = float(1).sub(ax).max(0);
    return vec4(
      vec3(0.2, 0.8, 1.0)
        .mul(core.add(wide))
        .mul(fade)
        .mul(streakK as any),
      1
    );
  })();
  streakMat.transparent = true;
  streakMat.blending = AdditiveBlending;
  streakMat.depthWrite = false;
  streakMat.depthTest = false;
  const streak = new Sprite(streakMat);
  streak.renderOrder = 13;
  group.add(streak);
  registry.add(streakMat);

  // Restrained pink-white inner glow behind/around the gem (idea5 core flare).
  const glowK = uniform(0);
  const glowMat = new SpriteNodeMaterial();
  glowMat.colorNode = (() => {
    const p = uv().sub(0.5).mul(2);
    const r2 = p.x.mul(p.x).add(p.y.mul(p.y));
    const g = exp(r2.mul(-5))
      .mul(0.9)
      .add(exp(r2.mul(-26)).mul(1.5))
      .add(exp(r2.mul(-110)).mul(1.8));
    return vec4(
      vec3(1.0, 0.5, 0.85)
        .mul(g)
        .mul(glowK as any),
      1
    );
  })();
  glowMat.transparent = true;
  glowMat.blending = AdditiveBlending;
  glowMat.depthWrite = false;
  glowMat.depthTest = false;
  const glow = new Sprite(glowMat);
  glow.renderOrder = 7;
  group.add(glow);
  registry.add(glowMat);
  // Faint cyan rim-light on the cloud outline (closed silhouette, blooms).
  const ringK = uniform(0);
  const ringMat = new SpriteNodeMaterial();
  ringMat.colorNode = (() => {
    const p = uv().sub(0.5).mul(2);
    const r = length(p);
    const band = exp(r.sub(0.9).div(0.014).pow(2).negate())
      .mul(0.1)
      .add(exp(r.sub(0.9).div(0.07).pow(2).negate()).mul(0.03));
    return vec4(
      vec3(0.1, 0.85, 1.0)
        .mul(band)
        .mul(ringK as any),
      1
    );
  })();
  ringMat.transparent = true;
  ringMat.blending = AdditiveBlending;
  ringMat.depthWrite = false;
  ringMat.depthTest = false;
  const ring = new Sprite(ringMat);
  ring.renderOrder = 7;
  group.add(ring);
  registry.add(ringMat);
  const camRight = new Vector3();
  const camUp = new Vector3();
  const tmp = new Vector3();
  const rot = new Quaternion();
  const axis = new Vector3(...packed.spinAxis).normalize();
  let flickerClock = 0;
  let swirlClock = 0;
  const worldCenter = new Vector3();
  const viewDir = new Vector3();

  function update(f: RtAtomFrame): void {
    const params = clampShaderParams({
      marchSteps: f.marchSteps,
      exposure: 1,
      excitation: f.energy.excitation,
      saturation: f.energy.saturation,
      brightness: f.energy.brightness,
      cloudRadiusMul: f.energy.cloudRadiusMul,
      nucleonCount: packed.count,
      orbitalWeights: orbitals.map((o) => o.weight),
      phase: f.phase,
    });
    // Seat the (smaller, idle) cloud on its pedestal: the full-size cloud's base
    // is the reference, so a tightened cloud drops by the radius it gave up.
    group.position.y = seatBaseY - (CLOUD_BOUND_RADIUS - params.cloudRadius);
    group.updateMatrixWorld(true);
    group.getWorldPosition(worldCenter);
    f.camera.matrixWorld.extractBasis(camRight, camUp, tmp);
    // Nucleus spin (measured-TPS driven by the caller; static when 0).
    rot.setFromAxisAngle(axis, f.spinAngle);
    for (let i = 0; i < packed.count; i += 1) {
      tmp.set(centers[i * 4], centers[i * 4 + 1], centers[i * 4 + 2]).applyQuaternion(rot);
      nucArray[i].set(tmp.x, tmp.y, tmp.z, centers[i * 4 + 3]);
      // Mirror uses atom-local coordinates too (rays are reflected, not geometry).
      mirrorNuc[i].set(tmp.x + 0, tmp.y + 0, tmp.z + 0, centers[i * 4 + 3]);
    }
    // World-space nucleon centres: shift by atom centre.
    for (let i = 0; i < packed.count; i += 1) {
      const c = nucArray[i] as any;
      c.x += worldCenter.x;
      c.y += worldCenter.y;
      c.z += worldCenter.z;
      const m = mirrorNuc[i] as any;
      m.x += worldCenter.x;
      m.y += worldCenter.y;
      m.z += worldCenter.z;
    }
    const dist = f.camera.position.distanceTo(worldCenter);
    const cr = params.cloudRadius;
    // Projected size vs the default single-atom view (dist 255 at full radius):
    // hairline/mote overlap per pixel grows as the atom shrinks on screen.
    const crowd = Math.min(1, Math.max(0.15, 255 / CLOUD_BOUND_RADIUS / (dist / cr)));
    // Close range: bolts/streak back off so they never dominate the frame.
    const farK = Math.min(1, Math.max(0, (dist / cr - 3.2) / 3.3));
    const closeK = Math.min(
      1,
      Math.max(0.4, f.camera.position.distanceTo(worldCenter) / (cr * 4.2))
    );
    const half = ((cr * dist) / Math.sqrt(Math.max(dist * dist - cr * cr, 1))) * 1.08;
    for (const [u, isMirror] of [
      [uniforms, false],
      [mirrorUniforms, true],
    ] as const) {
      (u.center.value as Vector3).copy(worldCenter);
      if (isMirror) (u.center.value as Vector3).set(worldCenter.x, worldCenter.y, worldCenter.z);
      (u.camRight.value as Vector3).copy(camRight);
      (u.camUp.value as Vector3).copy(camUp);
      (u.quadHalf as any).value = half;
      (u.cloudRadius as any).value = cr;
      (u.far as any).value = farK;
      (u.energy.value as Vector3).set(params.excitation, params.saturation, params.brightness);
      (u.phase as any).value = params.phase;
      // Absorbing plasma body thins out in the low-energy (idle) state so it
      // greys and calms instead of reading as a dark sooty ball.
      (u.mediumK as any).value = MEDIUM_K * params.brightness * params.brightness;
      (u.steps as any).value = isMirror
        ? Math.max(32, Math.round(params.marchSteps * 0.3))
        : params.marchSteps;
      (u.weights.value as Vector3).set(
        orbitals[0].weight * params.orbitalWeights[0] * 3,
        orbitals[1].weight * params.orbitalWeights[1] * 3,
        orbitals[2].weight * params.orbitalWeights[2] * 3
      );
    }
    // Mirror quad sits at the reflected centre.
    mesh.position.set(0, 0, 0);
    mirrorMesh.position.set(0, 2 * (FLOOR_Y - worldCenter.y), 0);

    // Wires follow the cloud radius (tighter at idle), dim with brightness.
    const fov = (f.camera as { fov?: number }).fov ?? 32;
    const pxH = f.pixelHeight && f.pixelHeight > 0 ? f.pixelHeight : 1882;
    const pxScale = (2 * Math.tan((fov * Math.PI) / 360)) / pxH;
    // Wires loop beyond the cloud (idea5): radius 1.18x the cloud.
    (wireU.scale as any).value = (params.cloudRadius / CLOUD_BOUND_RADIUS) * 1.18;
    (wireU.pxScale as any).value = pxScale;
    (wireU.time as any).value = f.phase * 2.2;
    (wireU.energy.value as Vector3).set(
      (0.35 + 0.9 * params.brightness) * crowd,
      params.saturation,
      0
    );
    (wireU.occluderCenter.value as Vector3).copy(worldCenter);
    (wireU.tint.value as Vector3).copy(uniforms.rim.value as Vector3);
    let eIdx = 0;
    wiresDef.forEach((w, i) => {
      const th = (k: number) => {
        const v = w.phase + f.phase * w.speed * 1.4 + (eIdx + k) * 1.3 + k * Math.PI;
        return ((v % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      };
      wireElectrons[i].set(th(0), electronCount[i] > 1 ? th(1) : -100);
      eIdx += electronCount[i];
    });

    // Strand field: energy drives count, reach, brightness and grey fade.
    const reach = 0.78 + 0.22 * params.excitation;
    (strandU.time as any).value = f.phase;
    (strandU.center.value as Vector3).copy(worldCenter);
    (strandU.cloudR as any).value = cr;
    (strandU.far as any).value = farK;
    (strandU.crowd as any).value = crowd;
    (strandU.rootR as any).value = Math.min(0.4, (nucExtent * 0.8) / cr);
    (strandU.pxScale as any).value = pxScale;
    (strandU.energy.value as Vector3).set(params.excitation, params.saturation, params.brightness);
    (strandU.active as any).value = activeStrandFraction(params.excitation, params.brightness);
    (strandU.reach as any).value = reach;
    (strandU.camRight.value as Vector3).copy(camRight);
    (strandU.camUp.value as Vector3).copy(camUp);
    (uniforms.reach as any).value = reach;
    (mirrorUniforms.reach as any).value = reach;

    // Anamorphic streak: spans well beyond the cloud, brighter when excited.
    // Quad sized to the visible band only (fill cost: it is additive over MSAA HDR).
    streak.scale.set(cr * 6, cr * 0.16, 1);
    glow.scale.set(cr * 0.62, cr * 0.62, 1);
    glowK.value =
      (0.3 + 1.3 * params.excitation) * params.brightness * (1 + 0.3 * farK) * Math.sqrt(crowd);
    ring.scale.set((2 * reach * cr) / 0.9, (2 * reach * cr) / 0.9, 1);
    ringK.value = (0.3 + 0.7 * params.excitation) * params.brightness;
    // Decorative differential swirl: rate rises with energy, never encodes
    // throughput; frozen (still-rich frame) under reduced motion.
    swirlClock +=
      f.reducedMotion || !(f.dt > 0) ? 0 : Math.min(f.dt, 0.25) * (0.1 + 0.16 * params.excitation);
    (strandU.swirl as any).value = swirlClock;
    (strandU.lifeOn as any).value = f.reducedMotion ? 0 : 1;
    streakK.value = (0.2 + 1.0 * params.excitation) * params.brightness * closeK;

    // Bolt ribbons carry world-space endpoints: cancel the group's translation.
    boltGroup.position.copy(worldCenter).negate();

    // Lightning: only for excited, measured state; static in reduced motion.
    flickerClock += f.reducedMotion || !(f.dt > 0) ? 0 : Math.min(f.dt, 0.25);
    // Fewer, thinner bolts: only the first four slots ever fire.
    const slotThreshold = [0.4, 0.6, 0.8, 0.92, 2, 2, 2, 2];
    boltSlots.forEach((slot, s) => {
      const on = f.energy.measured && f.energy.excitation > slotThreshold[s];
      const flick = f.reducedMotion
        ? 0.7
        : 0.65 + 0.35 * Math.abs(Math.sin(flickerClock * (9 + s * 3) + s));
      (slot.u.intensity as any).value = on
        ? flick * (0.4 + 0.5 * f.energy.excitation) * closeK * closeK
        : 0;
      const v = f.reducedMotion
        ? 0
        : ((Math.floor(flickerClock * 7 + s * 2) % BOLT_VARIANTS) + BOLT_VARIANTS) % BOLT_VARIANTS;
      if (v !== slot.variant) {
        slot.variant = v;
        slot.shot += 1;
        slot.meshes.forEach((m) => (m.geometry = slot.variants[v]));
        // New discharge: seeded direction from the core out to the cloud,
        // biased perpendicular to the view so it reads as a radiating tendril.
        const hs = seed * 0.001 + s * 17.3 + slot.shot * 3.7;
        const zz = hash01(hs) * 2 - 1;
        const az = hash01(hs + 9.1) * Math.PI * 2;
        const rr = Math.sqrt(1 - zz * zz);
        slot.dir.set(rr * Math.cos(az), zz, rr * Math.sin(az));
        viewDir.copy(f.camera.position).sub(worldCenter).normalize();
        slot.dir.addScaledVector(viewDir, -0.75 * slot.dir.dot(viewDir)).normalize();
      }
      slot.meshes.forEach((m) => (m.visible = on));
      const reach = cr * (0.78 + 0.16 * hash01(s * 5.3 + slot.shot));
      (slot.u.a.value as Vector3).copy(worldCenter);
      (slot.u.b.value as Vector3).copy(worldCenter).addScaledVector(slot.dir, reach);
      (slot.u.occluderCenter.value as Vector3).copy(worldCenter);
    });
  }

  return {
    group,
    uniforms,
    packed,
    update,
    dispose: () => {
      registry.disposeAll();
    },
  };
}

function mix3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export { ATOM_WORLD_RADIUS, desaturateLinear };
