/**
 * One ray-traced atom: nucleus + glass + volumetric cloud impostor (plus a
 * mirrored floor reflection), orbital wires, electrons and lightning. Imports
 * `three` only via `three/webgpu`. All per-frame work writes into preallocated
 * uniform storage; there is no React state and no per-frame allocation of GPU
 * resources.
 */
import { Group, Mesh, PlaneGeometry, Quaternion, Vector3, type Camera } from "three/webgpu";
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
import { createAtomMaterial, createAtomUniforms, type AtomUniforms } from "../shaders/atomImpostor";
import {
  createBoltMaterial,
  createBoltUniforms,
  createBoltVariants,
  type BoltUniforms,
} from "../shaders/boltStrand";
import {
  createElectron,
  createWireMesh,
  createWireUniforms,
  wirePoint,
  type ElectronVisual,
  type WireUniforms,
} from "../shaders/orbitWire";
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
}

const BOLT_SLOTS = 3;
const BOLT_VARIANTS = 3;
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
  const orbitals: Orbital[] = orbitalLayout(seed);
  const wiresDef: OrbitWire[] = orbitWires(seed, opts.wireCount ?? 10);
  const group = new Group();
  group.position.set(...opts.position);

  const uniforms = createAtomUniforms();
  const material = createAtomMaterial(uniforms);
  const quad = new PlaneGeometry(2, 2);
  const mesh = new Mesh(quad, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  group.add(mesh);
  registry.add(material);
  registry.add(quad);

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
      const c = hexToLinear(proton ? "#E5484D" : "#B8A9B4");
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
  const hueSet: [number, number, number][] = known
    ? [mix3(lane, [0.55, 0.2, 1.0], 0.55), [0.8, 0.22, 0.95], [0.12, 0.65, 1.0]]
    : NEUTRAL_HUES;
  uniforms.hues.forEach((h, i) => (h.value as Vector3).set(...hueSet[i]));
  (uniforms.inner.value as Vector3).set(...(known ? [0.5, 0.14, 1.0] : [0.4, 0.5, 0.78]));
  (uniforms.rim.value as Vector3).set(...(known ? [0.08, 0.85, 1.0] : [0.55, 0.72, 0.95]));
  (uniforms.coreColor.value as Vector3).set(...(known ? [1.0, 0.7, 0.95] : [0.85, 0.9, 1]));
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
  (uniforms.glassRadius as any).value = packed.extent * 1.14;
  (mirrorUniforms.glassRadius as any).value = packed.extent * 1.14;

  // Wires + electrons.
  const wireU: WireUniforms = createWireUniforms();
  (wireU.occluderRadius as any).value = packed.extent * 0.92;
  const wireGroup = new Group();
  group.add(wireGroup);
  wiresDef.forEach((w, i) => {
    const m = createWireMesh(w, i, wireU, 0.12);
    wireGroup.add(m);
    registry.add(m.geometry);
    registry.add(m.material as { dispose: () => void });
  });
  const electrons: ElectronVisual[] = [];
  const electronWire: number[] = [];
  wiresDef.forEach((_, i) => {
    const count = i % 3 === 0 ? 2 : 1;
    for (let k = 0; k < count; k += 1) {
      const e = createElectron(wireU, i % 2 === 0 ? [1.0, 0.55, 0.75] : [0.6, 0.95, 1.0]);
      e.core.scale.setScalar(0.85);
      e.glow.scale.setScalar(7.5);
      wireGroup.add(e.core, e.glow);
      registry.add(e);
      electrons.push(e);
      electronWire.push(i);
    }
  });

  // Lightning bolts: nucleus -> electrons (excited state only).
  const boltGroup = new Group();
  group.add(boltGroup);
  const boltSlots: {
    u: BoltUniforms;
    meshes: Mesh[];
    variants: ReturnType<typeof createBoltVariants>;
    variant: number;
    electron: number;
  }[] = [];
  for (let s = 0; s < BOLT_SLOTS; s += 1) {
    const bu = createBoltUniforms();
    const variants = createBoltVariants(seed + s * 131, BOLT_VARIANTS);
    variants.forEach((v) => registry.add(v));
    const halo = new Mesh(
      variants[0],
      createBoltMaterial(bu, { halo: true, color: [0.35, 0.75, 1.0], width: 0.9 })
    );
    const core = new Mesh(
      variants[0],
      createBoltMaterial(bu, { halo: false, color: [0.8, 0.95, 1.0], width: 0.22 })
    );
    [halo, core].forEach((m, k) => {
      m.frustumCulled = false;
      m.renderOrder = 12 + k;
      registry.add(m.material as { dispose: () => void });
      boltGroup.add(m);
    });
    (bu.occluderRadius as any).value = packed.extent * 0.92;
    boltSlots.push({
      u: bu,
      meshes: [halo, core],
      variants,
      variant: 0,
      electron: (s * 3 + 1) % electrons.length,
    });
  }

  const camRight = new Vector3();
  const camUp = new Vector3();
  const tmp = new Vector3();
  const rot = new Quaternion();
  const axis = new Vector3(...packed.spinAxis).normalize();
  let flickerClock = 0;
  const worldCenter = new Vector3();

  function update(f: RtAtomFrame): void {
    group.getWorldPosition(worldCenter);
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
      (u.energy.value as Vector3).set(params.excitation, params.saturation, params.brightness);
      (u.phase as any).value = params.phase;
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
    wireGroup.scale.setScalar(params.cloudRadius / CLOUD_BOUND_RADIUS);
    (wireU.time as any).value = f.phase * 2.2;
    (wireU.energy.value as Vector3).set(0.35 + 0.9 * params.brightness, params.saturation, 0);
    (wireU.occluderCenter.value as Vector3).copy(worldCenter);
    (wireU.tint.value as Vector3).copy(uniforms.rim.value as Vector3);

    const wscale = wireGroup.scale.x;
    for (let i = 0; i < electrons.length; i += 1) {
      const w = wiresDef[electronWire[i]];
      const theta = w.phase + f.phase * w.speed * 1.4 + i * 1.3;
      wirePoint(w, theta, tmp).multiplyScalar(wscale);
      electrons[i].core.position.copy(tmp);
      electrons[i].glow.position.copy(tmp);
    }

    // Bolt ribbons carry world-space endpoints: cancel the group's translation.
    boltGroup.position.copy(worldCenter).negate();

    // Lightning: only for excited, measured state; static in reduced motion.
    flickerClock += f.reducedMotion || !(f.dt > 0) ? 0 : Math.min(f.dt, 0.25);
    const slotThreshold = [0.45, 0.62, 0.8];
    boltSlots.forEach((slot, s) => {
      const on = f.energy.measured && f.energy.excitation > slotThreshold[s];
      const flick = f.reducedMotion
        ? 0.7
        : 0.65 + 0.35 * Math.abs(Math.sin(flickerClock * (9 + s * 3) + s));
      (slot.u.intensity as any).value = on ? flick * (0.6 + 0.8 * f.energy.excitation) : 0;
      const v = f.reducedMotion
        ? 0
        : ((Math.floor(flickerClock * 7 + s * 2) % BOLT_VARIANTS) + BOLT_VARIANTS) % BOLT_VARIANTS;
      if (v !== slot.variant) {
        slot.variant = v;
        slot.meshes.forEach((m) => (m.geometry = slot.variants[v]));
      }
      slot.meshes.forEach((m) => (m.visible = on));
      const e = electrons[slot.electron];
      (slot.u.a.value as Vector3).copy(worldCenter);
      (slot.u.b.value as Vector3).copy(e.core.position).add(worldCenter);
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
