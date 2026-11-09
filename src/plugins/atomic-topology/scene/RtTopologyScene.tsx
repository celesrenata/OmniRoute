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
  isVibrantTier,
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
import { STRIKE_CODE, strikeLife, strokeEnvelope, type StrikeKind } from "./strikeTimeline";
import { CLOUD_BOUND_RADIUS } from "./shaderParams";
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
  closeHeroWeight,
  environmentLayoutFor,
  isNeutralAtom,
  linkBaseIntensity,
  linkCurve,
} from "./rt/topologyScene";
import { createEnvironment, type Environment } from "./shaders/environment";
import { computeCameraFit } from "../cameraFit";
import { ContainerCameraClamp } from "./ContainerCameraClamp";
import { containerBounds } from "./containerBounds";
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
/** Gain of non-focused atoms while an atom is focused (isolates the focus, as in idea5). */
const FOCUS_NEIGHBOUR_DIM = 0.24;
/** Gain of neighbours around the close-up hero atom at full isolation weight. */
const CLOSE_NEIGHBOUR_DIM = 0.55;
/** Ray-march steps (bounded by shaderParams). */
const MARCH_STEPS = 48;
const FAILURE_RGB: [number, number, number] = [1.0, 0.16, 0.12];
/** Shell radii the strike attaches to (world units; hub is drawn larger). */
const ATOM_SHELL_R = CLOUD_BOUND_RADIUS * 0.55;
const HUB_SHELL_R = ATOM_SHELL_R * HUB_SCALE;

interface AtomRuntime {
  energy: ReturnType<typeof createEnergySmoother>;
  spin: ReturnType<typeof createRotationSmoothing>;
  angle: number;
  phase: number;
}

/** A booked between-atom discharge (from an event edge only; never loops). */
interface StrikeRuntime {
  kind: StrikeKind;
  startAt: number;
  /** Per-link strike counter: picks the channel variant and mutation phase. */
  n: number;
}

interface LinkRuntime {
  prev: OneShotState;
  flash: OneShotEvent | null;
  strike: StrikeRuntime | null;
  pending: OneShotEvent | null;
  strikes: number;
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

  const { cameraState, cameraAspect, fitRadius } = useAtomicSceneContext();
  const gpuRef = useRef<Gpu | null>(null);
  const alertById = useRef(new Map<string, number>());
  const focusTmp = useRef(new Vector3());
  const projTmp = useRef(new Vector3());
  /** Close-up hero (no explicit focus): previous frame's index + isolation weight. */
  const heroRef = useRef({ index: -1, w: 0 });
  const atomRt = useRef(new Map<string, AtomRuntime>());
  const linkRt = useRef(new Map<string, LinkRuntime>());
  const framesRef = useRef<BatchAtomFrame[]>([]);
  const dirtyRef = useRef(4);
  // Visibility savings on by default; `?cull=0` is the dev A/B baseline for measuring them.
  const cullRef = useRef(
    typeof window === "undefined" || new URLSearchParams(window.location.search).get("cull") !== "0"
  );
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
    // Dev-only layer A/B (`?hideLayers=strands,wires,...` by mesh name); never in production.
    const hideLayers =
      process.env.NODE_ENV !== "production" && typeof window !== "undefined"
        ? (new URLSearchParams(window.location.search).get("hideLayers") ?? "")
            .split(",")
            .filter(Boolean)
        : [];
    if (hideLayers.length) {
      const hideSet = new Set(hideLayers);
      const hideNew = (o: { name?: string; material?: unknown }) => {
        const m = o.material as { visible?: boolean } | undefined;
        if (o.name && hideSet.has(o.name) && m) m.visible = false;
      };
      root.traverse(hideNew);
      // Impostor slots are created lazily on configure: re-apply on the next frames.
      let tries = 0;
      const timer = window.setInterval(() => {
        root.traverse(hideNew);
        if (++tries > 20) window.clearInterval(timer);
      }, 250);
    }
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
        absent: d.energyTier === 0 || (d.energyTier == null && isNeutralAtom(d)),
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
    // The container encloses the default fit pose (the camera is never moved to fit it).
    const fit = computeCameraFit({ fovDeg: 50, aspect: cameraAspect, radius: fitRadius });
    const envLayout = environmentLayoutFor(descriptors, { position: fit.position });
    gpu.env.setLayout(envLayout);
    containerBounds.value = {
      min: [-envLayout.wallX, envLayout.floorY, envLayout.farZ],
      max: [envLayout.wallX, envLayout.ceilY, envLayout.nearZ],
    };
    (floorY as { value: number }).value = envLayout.floorY;
    gpu.motes.setBounds(new Vector3(...envLayout.moteCenter), new Vector3(...envLayout.moteHalf));
    // Links: one ribbon + one bolt instance per link (chunked by uniform-block size).
    const needed = Math.ceil(linkDescriptors.length / gpu.linkCap);
    while (gpu.links.length < needed) {
      const layer = createLinkLayer(gpu.linkCap);
      layer.ribbon.raycast = () => {};
      layer.bolt.raycast = () => {};
      gpu.links.push(layer);
      gpu.root.add(layer.ribbon, ...layer.fx);
      layer.fx.forEach((m) => {
        m.raycast = () => {};
      });
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
  }, [atomConfigs, descriptors, linkDescriptors, cameraAspect, fitRadius]);

  useEffect(
    () => () => {
      containerBounds.value = null;
    },
    []
  );

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
    gpu.env.setLife(reduced ? 0 : 1);

    // Links first: failure discharges flash the target atom's core red.
    alertById.current.clear();
    const anyStrike: boolean[] = gpu.links.map(() => false);
    linkDescriptors.forEach((link, i) => {
      const layer = gpu.links[Math.floor(i / gpu.linkCap)];
      if (!layer) return;
      const row = i % gpu.linkCap;
      const target = atomIndex.get(link.target);
      const td = target != null ? descriptors[target] : null;
      const state = link.visualState.state as OneShotState;
      let rt = linkRt.current.get(link.id);
      if (!rt) {
        rt = { prev: state, flash: null, strike: null, pending: null, strikes: 0 };
        linkRt.current.set(link.id, rt);
      }
      const book = (ev: OneShotEvent): void => {
        rt.strikes += 1;
        rt.strike = {
          kind: ev.kind === "completion" ? "completion" : "failure",
          startAt: ev.startAt,
          n: rt.strikes,
        };
        if (ev.kind === "completion") rt.flash = ev;
      };
      if (rt.prev !== state) {
        const ev = bookTransition(rt.prev, state, t);
        rt.prev = state;
        if (ev) {
          if (pausedRef.current) rt.pending = ev;
          else book(ev);
        }
      }
      if (rt.pending && !pausedRef.current && !sceneState.contextLost) {
        const ev = rt.pending;
        rt.pending = null;
        ev.startAt = t;
        book(ev);
      }
      if (rt.strike && t - rt.strike.startAt > strikeLife(rt.strike.kind)) rt.strike = null;
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
      // Strike (hard) from a live event; reduced motion shows a steady soft tint
      // for the state instead (no flicker, no strobing).
      const strikeAge = rt.strike && !reduced ? t - rt.strike.startAt : -1;
      const strikeStrength = rt.strike && rt.strike.kind === "failure" ? 1 : rt.strike ? 0.9 : 0;
      const alertBase = state === "error" ? (reduced ? 0.35 : 0.25) : 0;
      const alertNow =
        rt.strike && rt.strike.kind === "failure" && !reduced
          ? Math.min(1, alertBase + 0.8 * strokeEnvelope("failure", strikeAge))
          : alertBase;
      if (state === "error") alertById.current.set(link.target, alertNow);
      if (strikeAge >= 0) anyStrike[Math.floor(i / gpu.linkCap)] = true;
      const base = linkBaseIntensity(state, link.visualState.style.opacity);
      const put = (k: number, x: number, y: number, z: number, w: number) => {
        const q = o + k * 4;
        arr[q] = x;
        arr[q + 1] = y;
        arr[q + 2] = z;
        arr[q + 3] = w;
      };
      put(LINK_FIELD.A_CORE, curve.a[0], curve.a[1], curve.a[2], 1.7);
      put(LINK_FIELD.C_HALO, curve.c[0], curve.c[1], curve.c[2], 11);
      put(LINK_FIELD.B_BASE, curve.b[0], curve.b[1], curve.b[2], base);
      put(LINK_FIELD.COLOR_WOBBLE, lane[0], lane[1], lane[2], reduced ? 0 : 0.0035);
      put(LINK_FIELD.HEADS, heads[0], heads[1], heads[2], 1);
      put(LINK_FIELD.FLASH_BOLT, flashPos, flashK, 0, 0);
      const linkHash = fnv1a(link.id);
      if (strikeAge >= 0 && rt.strike) {
        put(
          LINK_FIELD.STRIKE,
          strikeAge,
          STRIKE_CODE[rt.strike.kind],
          strikeStrength,
          (linkHash % 997) + rt.strike.n * 7 + LINK_BOLT_VARIANTS * 100
        );
      } else if (reduced && (state === "error" || state === "last")) {
        // Static calm filament in the event colour (soft one-shot colour change).
        put(LINK_FIELD.STRIKE, 0.3, state === "error" ? -1 : -2, 0.6, linkHash % 997);
      } else {
        put(LINK_FIELD.STRIKE, -1, 0, 0, linkHash % 997);
      }
      put(LINK_FIELD.STRIKE2, HUB_SHELL_R, ATOM_SHELL_R, (linkHash % 1000) / 1000, 0);
    });
    gpu.links.forEach((layer, li) => layer.setStrikeVisible(anyStrike[li] === true));
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
      const energy = energyFromActivity(
        level,
        target.measured,
        reduced,
        isVibrantTier(d.energyTier)
      );
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
      // Focus view: de-emphasise every non-focused atom so the focused one is isolated.
      const hero = heroRef.current;
      f.fullDetail = focusNodeId === d.id || (hero.index === i && hero.w > 0.3);
      f.dim =
        focusNodeId && focusNodeId !== d.id
          ? FOCUS_NEIGHBOUR_DIM
          : !focusNodeId && hero.index >= 0 && hero.index !== i
            ? 1 - (1 - CLOSE_NEIGHBOUR_DIM) * hero.w
            : 1;
    });
    gpu.atoms.update(frames, {
      dt,
      camera,
      reducedMotion: reduced,
      pixelHeight: pxH,
      cull: cullRef.current,
    });
    gpu.env.follow(camera);
    const tg = cameraState.target;
    const focusPt = focusTmp.current.set(tg[0], tg[1], tg[2]);
    gpu.motes.update(camera, focusPt);
    // Depth of field: focus plane at the orbit target; in the focus view the
    // focused atom's projected disc stays sharp and its neighbours defocus.
    const fd = camera.position.distanceTo(focusPt);
    const cam = camera as PerspectiveCamera;
    const tanHalf = Math.tan(((cam.fov ?? 50) * Math.PI) / 360);
    const discOf = (fr: BatchAtomFrame) => {
      const p = projTmp.current.set(fr.position[0], fr.position[1], fr.position[2]);
      const dist = camera.position.distanceTo(p);
      p.project(camera);
      if (p.z >= 1) return null;
      const r = (CLOUD_BOUND_RADIUS * (fr.scale ?? 1)) / Math.max(1e-3, 2 * dist * tanHalf);
      return { u: (p.x + 1) / 2, v: (1 - p.y) / 2, r, x: p.x, y: p.y };
    };
    let focusDisc: { u: number; v: number; r: number; w: number } | null = null;
    const fi = focusNodeId ? atomIndex.get(focusNodeId) : undefined;
    if (fi != null && frames[fi]) {
      heroRef.current.index = -1;
      const d0 = discOf(frames[fi]);
      if (d0) focusDisc = { u: d0.u, v: d0.v, r: d0.r, w: 1 };
    } else {
      // Close-up without an explicit focus: the atom nearest the screen centre
      // becomes the hero once it fills a large part of the view (smooth ramp).
      let best: (NonNullable<ReturnType<typeof discOf>> & { i: number }) | null = null;
      for (let i = 0; i < frames.length; i += 1) {
        const d0 = discOf(frames[i]);
        if (!d0 || Math.hypot(d0.x, d0.y) > 0.45) continue;
        if (!best || Math.hypot(d0.x, d0.y) < Math.hypot(best.x, best.y)) best = { ...d0, i };
      }
      const w = best ? closeHeroWeight(best.r) : 0;
      if (best && w > 0) focusDisc = { u: best.u, v: best.v, r: best.r, w };
      heroRef.current.index = best && w > 0 ? best.i : -1;
      heroRef.current.w = w;
    }
    gpu.post.setFocus(fd, focusDisc);
    gpu.post.pipeline.render();
    if (process.env.NODE_ENV !== "production") {
      const w = window as unknown as { __atomicRtFrames?: number };
      w.__atomicRtFrames = (w.__atomicRtFrames ?? 0) + 1;
    }
  }, 1);

  return <ContainerCameraClamp />;
}
