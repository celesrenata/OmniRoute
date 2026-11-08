"use client";

/**
 * Ray-traced full topology (Gate B): the approved golden atom rolled across
 * every hub / provider / gpu / runtime atom, batched energy links, and the
 * idea5 atmosphere (server-room corridor with DOF-softened racks, reflective
 * grid floor with ripples and streaks, holographic pedestals, world-space
 * bokeh motes, cinematic post).
 *
 * Mounted INSIDE the R3F `<Canvas>` (whose renderer is a `WebGPURenderer`,
 * WebGL2 backend as fallback). It owns no camera logic: `CameraRig`,
 * `CameraStateWriter` and `<SceneOrbitControls />` in `AtomicScene.tsx` drive
 * the camera exactly as before; this module only reads it.
 *
 * Per frame (one `useFrame` at priority 1, which also takes over rendering so
 * the scene is drawn exactly once through the HDR post pipeline):
 *   measured telemetry -> energy (smoothed) -> one batched upload -> render.
 * No React state is written per frame. Under reduced motion the clock is
 * frozen and a frame is rendered only when the camera, the viewport or the
 * snapshot changed (a static frame per update).
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Group, Matrix4, Vector3, type PerspectiveCamera, type WebGPURenderer } from "three/webgpu";

import type { AtomVisualDescriptor, LinkVisualDescriptor } from "../AtomicTopologyRenderer";
import {
  activityOf,
  advanceAnimationPhase,
  createEnergySmoother,
  energyFromActivity,
  resolveEnergyState,
} from "./energyState";
import {
  MAX_PACKET_POOL,
  completionImpulseFraction,
  packetHeadProgress,
  packetPoolSize,
} from "./filament";
import { breathingScale, easeInOut, easeOutSharp, MAX_FRAME_DELTA, motionParams } from "./motion";
import { createRotationSmoothing, tpsToRadiansPerSecond } from "./nucleusMotion";
import { hexToLinear } from "./nucleonPack";
import { bookTransition, oneShotIntensity, type OneShotEvent, type OneShotState } from "./oneShot";
import { sceneClock, sceneState } from "./sceneState";
import { useAtomicSceneContext } from "./sceneContext";
import { fnv1a } from "./cloudShells";
import { createAtomBatchSet, type BatchAtomConfig, type BatchAtomFrame } from "./rt/atomBatch";
import { batchCapacityFor } from "./rt/atomData";
import { createRtPost, type RtPost } from "./rt/rendererFactory";
import { createRtRegistry } from "./rt/rtRegistry";
import { envTime, floorY, pxScale } from "./rt/sharedUniforms";
import {
  FOCUS_SCALE,
  HUB_SCALE,
  atomEnergyInput,
  environmentLayoutFor,
  isNeutralAtom,
  linkBaseIntensity,
  linkCurve,
} from "./rt/topologyScene";
import { createEnvironment, type Environment } from "./shaders/environment";
import {
  LINK_BOLT_VARIANTS,
  LINK_FIELD,
  LINK_FIELDS,
  createLinkLayer,
  linkCapacityFor,
  type LinkLayer,
} from "./shaders/linkStrand";
import { createMotes, type MoteLayer } from "./shaders/motes";

/** Breathing amplitude: +/-2 % (same as the legacy atom). */
const BREATH_AMPLITUDE = 0.02;
/** Packet hop period (s), same as the legacy EnergyLink. */
const PULSE_PERIOD_S = 2.5;
/** Ray-march steps (bounded by shaderParams). */
const MARCH_STEPS = 48;
const FAILURE_RGB: [number, number, number] = [1.0, 0.16, 0.12];

interface AtomRuntime {
  energy: ReturnType<typeof createEnergySmoother>;
  spin: ReturnType<typeof createRotationSmoothing>;
  angle: number;
  phase: number;
}

interface LinkRuntime {
  prev: OneShotState;
  flash: OneShotEvent | null;
  burst: OneShotEvent | null;
  pending: OneShotEvent | null;
}

interface Gpu {
  root: Group;
  atoms: ReturnType<typeof createAtomBatchSet>;
  links: LinkLayer[];
  linkCap: number;
  env: Environment;
  motes: MoteLayer;
  post: RtPost;
  dispose: () => void;
}

export interface RtTopologyContentProps {
  descriptors: AtomVisualDescriptor[];
  linkDescriptors: LinkVisualDescriptor[];
  paused: boolean;
  focusNodeId: string | null;
  /** Dev A/B only (`?bloom=0`). */
  bloom: boolean;
}

function isWebGpuBackend(gl: unknown): boolean {
  return !!(gl as { backend?: { isWebGPUBackend?: boolean } }).backend?.isWebGPUBackend;
}

export function RtTopologyContent({
  descriptors,
  linkDescriptors,
  paused,
  focusNodeId,
  bloom,
}: RtTopologyContentProps) {
  const gl = useThree((s) => s.gl) as unknown as WebGPURenderer;
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);

  const { cameraState } = useAtomicSceneContext();
  const gpuRef = useRef<Gpu | null>(null);
  const alertById = useRef(new Map<string, number>());
  const focusTmp = useRef(new Vector3());
  const atomRt = useRef(new Map<string, AtomRuntime>());
  const linkRt = useRef(new Map<string, LinkRuntime>());
  const framesRef = useRef<BatchAtomFrame[]>([]);
  const dirtyRef = useRef(4);
  const lastCam = useRef(new Matrix4());
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // --- GPU resources: built once per renderer, disposed on unmount ---------
  useEffect(() => {
    const registry = createRtRegistry();
    const webgpu = isWebGpuBackend(gl);
    const block = webgpu ? 65536 : 16384;
    const root = new Group();
    root.name = "rt-topology";
    const env = createEnvironment({ pedestals: [] });
    registry.add(env);
    env.objects.forEach((o) => root.add(o));
    const motes = createMotes();
    registry.add(motes);
    root.add(motes.far, motes.near);
    const atoms = createAtomBatchSet(batchCapacityFor(block), registry);
    root.add(atoms.group);
    const post = createRtPost(gl, scene as never, camera as never, bloom);
    registry.add(post);
    // DOM labels and the R3F pointer layer never pick these meshes.
    root.traverse((o) => {
      (o as { raycast?: unknown }).raycast = () => {};
    });
    scene.add(root);
    gpuRef.current = {
      root,
      atoms,
      links: [],
      linkCap: linkCapacityFor(block),
      env,
      motes,
      post,
      dispose: () => {
        scene.remove(root);
        registry.disposeAll();
      },
    };
    dirtyRef.current = 4;
    return () => {
      gpuRef.current?.links.forEach((l) => l.dispose());
      gpuRef.current?.dispose();
      gpuRef.current = null;
    };
  }, [gl, scene, camera, bloom]);

  // --- Snapshot -> static per-atom / per-link configuration ----------------
  const atomConfigs = useMemo<BatchAtomConfig[]>(
    () =>
      descriptors.map((d) => ({
        id: d.id,
        hub: d.kind === "hub",
        observedModelIds: d.kind === "hub" ? undefined : d.observedModelIds,
        laneHue: d.laneHue,
        neutral: isNeutralAtom(d),
      })),
    [descriptors]
  );
  const linkCurves = useMemo(
    () =>
      linkDescriptors.map((l) => {
        const d = descriptors.find((a) => a.id === l.target);
        return d ? linkCurve(d.position) : null;
      }),
    [descriptors, linkDescriptors]
  );
  const atomIndex = useMemo(() => {
    const m = new Map<string, number>();
    descriptors.forEach((d, i) => m.set(d.id, i));
    return m;
  }, [descriptors]);

  useEffect(() => {
    const gpu = gpuRef.current;
    if (!gpu) return;
    gpu.atoms.configure(atomConfigs);
    const envLayout = environmentLayoutFor(descriptors);
    gpu.env.setLayout(envLayout);
    (floorY as { value: number }).value = envLayout.floorY;
    gpu.motes.setBounds(new Vector3(...envLayout.moteCenter), new Vector3(...envLayout.moteHalf));
    // Links: one ribbon + one bolt instance per link (chunked by uniform-block size).
    const needed = Math.ceil(linkDescriptors.length / gpu.linkCap);
    while (gpu.links.length < needed) {
      const layer = createLinkLayer(gpu.linkCap);
      layer.ribbon.raycast = () => {};
      layer.bolt.raycast = () => {};
      gpu.links.push(layer);
      gpu.root.add(layer.ribbon, layer.bolt);
    }
    gpu.links.forEach((layer, li) => {
      const n = Math.max(0, Math.min(gpu.linkCap, linkDescriptors.length - li * gpu.linkCap));
      layer.setCount(n);
    });
    // Runtime state survives snapshot updates; drop atoms/links that left.
    const ids = new Set(descriptors.map((d) => d.id));
    for (const id of [...atomRt.current.keys()]) if (!ids.has(id)) atomRt.current.delete(id);
    const lids = new Set(linkDescriptors.map((l) => l.id));
    for (const id of [...linkRt.current.keys()]) if (!lids.has(id)) linkRt.current.delete(id);
    framesRef.current = descriptors.map(
      (d, i) =>
        framesRef.current[i] ?? {
          position: [d.position.x, d.position.y, d.position.z],
          energy: energyFromActivity(0, false, false),
          phase: 0,
          spinAngle: 0,
          marchSteps: MARCH_STEPS,
        }
    );
    dirtyRef.current = 4;
  }, [atomConfigs, descriptors, linkDescriptors]);

  useEffect(() => {
    dirtyRef.current = 4;
  }, [size.width, size.height, focusNodeId, paused]);

  // --- Per frame: energy -> batched upload -> one render through the post chain
  useFrame((_state, delta) => {
    const gpu = gpuRef.current;
    if (!gpu) return;
    const reduced = sceneState.reducedMotion;
    const frozen = pausedRef.current || sceneState.contextLost || reduced;
    camera.updateMatrixWorld();
    if (reduced) {
      // Static frame per update: skip when nothing visible changed.
      const camChanged = !lastCam.current.equals(camera.matrixWorld);
      if (!camChanged && dirtyRef.current <= 0) return;
      lastCam.current.copy(camera.matrixWorld);
      dirtyRef.current = Math.max(0, dirtyRef.current - 1);
    }
    const dt = frozen ? 0 : Math.min(Math.max(delta, 0), MAX_FRAME_DELTA);
    const t = sceneClock.now;
    const pxH = gl.domElement?.height || size.height * (window.devicePixelRatio || 1);
    (pxScale as { value: number }).value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / pxH;
    (envTime as { value: number }).value = reduced ? 0 : t;

    // Links first: failure discharges flash the target atom's core red.
    alertById.current.clear();
    linkDescriptors.forEach((link, i) => {
      const layer = gpu.links[Math.floor(i / gpu.linkCap)];
      if (!layer) return;
      const row = i % gpu.linkCap;
      const target = atomIndex.get(link.target);
      const td = target != null ? descriptors[target] : null;
      const state = link.visualState.state as OneShotState;
      let rt = linkRt.current.get(link.id);
      if (!rt) {
        rt = { prev: state, flash: null, burst: null, pending: null };
        linkRt.current.set(link.id, rt);
      }
      if (rt.prev !== state) {
        const ev = bookTransition(rt.prev, state, t);
        rt.prev = state;
        if (ev) {
          if (pausedRef.current) rt.pending = ev;
          else if (ev.kind === "completion") rt.flash = ev;
          else rt.burst = ev;
        }
      }
      if (rt.pending && !pausedRef.current && !sceneState.contextLost) {
        const ev = rt.pending;
        rt.pending = null;
        ev.startAt = t;
        if (ev.kind === "completion") rt.flash = ev;
        else rt.burst = ev;
      }
      const arr = layer.data.arr;
      const o = row * LINK_FIELDS * 4;
      if (!td) {
        arr.fill(0, o, o + LINK_FIELDS * 4);
        return;
      }
      const curve = linkCurves[i] ?? linkCurve(td.position);
      const lane = state === "error" ? FAILURE_RGB : hexToLinear(link.laneHue);
      const active = state === "active" && link.visualState.style.animated;
      const pool = packetPoolSize(MAX_PACKET_POOL, active && link.proven, reduced);
      const heads = [-1, -1, -1];
      for (let p = 0; p < pool; p += 1) {
        const prog = packetHeadProgress(t, PULSE_PERIOD_S, p, pool);
        heads[p] = prog > 0 ? easeInOut(prog) : -1;
      }
      let flashPos = -1;
      let flashK = 0;
      if (rt.flash && !reduced) {
        flashK = oneShotIntensity(rt.flash, t);
        const e = Math.min(1, Math.max(0, (t - rt.flash.startAt) / rt.flash.duration));
        flashPos = completionImpulseFraction(e, easeOutSharp(e));
        if (flashK <= 0.01) rt.flash = null;
      }
      const burst = rt.burst && !reduced ? oneShotIntensity(rt.burst, t) : 0;
      if (rt.burst && burst <= 0.001 && !reduced) rt.burst = null;
      // Reduced motion: a steady (non-flashing) red discharge while in error.
      const boltK = state === "error" ? (reduced ? 0.35 : 0.22 + 0.78 * burst) : 0;
      if (state === "error") {
        alertById.current.set(link.target, reduced ? 0.35 : Math.min(1, 0.25 + burst));
      }
      const base = linkBaseIntensity(state, link.visualState.style.opacity);
      const put = (k: number, x: number, y: number, z: number, w: number) => {
        const q = o + k * 4;
        arr[q] = x;
        arr[q + 1] = y;
        arr[q + 2] = z;
        arr[q + 3] = w;
      };
      put(LINK_FIELD.A_CORE, curve.a[0], curve.a[1], curve.a[2], 3.2);
      put(LINK_FIELD.C_HALO, curve.c[0], curve.c[1], curve.c[2], 16);
      put(LINK_FIELD.B_BASE, curve.b[0], curve.b[1], curve.b[2], base);
      put(LINK_FIELD.COLOR_WOBBLE, lane[0], lane[1], lane[2], reduced ? 0 : 0.0035);
      put(LINK_FIELD.HEADS, heads[0], heads[1], heads[2], 1);
      put(LINK_FIELD.FLASH_BOLT, flashPos, flashK, boltK, fnv1a(link.id) % LINK_BOLT_VARIANTS);
    });
    for (const layer of gpu.links) {
      layer.data.node.clearUpdateRanges();
      layer.data.node.addUpdateRange(0, layer.data.capacity * LINK_FIELDS * 4);
    }

    // Atoms: measured telemetry -> smoothed energy, spin, breathing, focus.
    const frames = framesRef.current;
    descriptors.forEach((d, i) => {
      let rt = atomRt.current.get(d.id);
      if (!rt) {
        const target = resolveEnergyState(atomEnergyInput(d, reduced));
        rt = {
          energy: createEnergySmoother(activityOf(target)),
          spin: createRotationSmoothing(),
          angle: 0,
          phase: (fnv1a(d.id) % 997) / 37,
        };
        atomRt.current.set(d.id, rt);
      }
      const target = resolveEnergyState(atomEnergyInput(d, reduced));
      const level = reduced ? activityOf(target) : rt.energy.step(activityOf(target), dt);
      const energy = energyFromActivity(level, target.measured, reduced);
      rt.phase = advanceAnimationPhase(rt.phase, dt, energy.speedMul, reduced);
      if (!frozen) {
        // Nucleus spin is bound strictly to measured output tok/s (null -> decays to 0).
        const tps = rt.spin.step(d.measuredTps, dt);
        rt.angle += tpsToRadiansPerSecond(tps) * dt;
      }
      const motion = motionParams({
        reducedMotion: false,
        spinValue: d.spin.value,
        spinMode: d.spin.mode,
      });
      const breath =
        frozen || !motion.breathActive
          ? 1
          : breathingScale(t, motion.breathPeriod, BREATH_AMPLITUDE, true);
      const vib = d.vibration;
      const vibrating = !frozen && vib.mode === "measured" && vib.amplitude > 0;
      const vt = t * vib.frequencyHz * Math.PI * 2;
      const f = frames[i];
      if (!f) return;
      const pos = f.position as [number, number, number];
      pos[0] = d.position.x + (vibrating ? Math.sin(vt) * vib.amplitude : 0);
      pos[1] = d.position.y + (vibrating ? Math.sin(vt * 1.31 + 0.7) * vib.amplitude : 0);
      pos[2] = d.position.z + (vibrating ? Math.sin(vt * 0.73 + 2.1) * vib.amplitude : 0);
      f.energy = energy;
      f.phase = rt.phase;
      f.spinAngle = rt.angle;
      f.marchSteps = MARCH_STEPS;
      f.scale =
        (d.kind === "hub" ? HUB_SCALE : 1) * (focusNodeId === d.id ? FOCUS_SCALE : 1) * breath;
      f.alert = alertById.current.get(d.id) ?? 0;
    });
    gpu.atoms.update(frames, {
      dt,
      camera,
      reducedMotion: reduced,
      pixelHeight: pxH,
    });
    gpu.env.follow(camera);
    const tg = cameraState.target;
    gpu.motes.update(camera, focusTmp.current.set(tg[0], tg[1], tg[2]));
    gpu.post.pipeline.render();
  }, 1);

  return null;
}
