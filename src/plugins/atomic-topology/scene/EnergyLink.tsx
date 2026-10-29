"use client";

/**
 * Energy link — one hub→atom route edge (OR-ATOM-008 S8.1, design spec S8.1).
 *
 * Renders as a curved "energy flow" following a quadratic Bézier from the
 * nucleus (origin) to the atom's deterministic layout position (the arc
 * geometry is UNCHANGED: same endpoints, `ARC_FACTOR = 0.25`, same
 * `CURVE_SEGMENTS = 24` sampling). Layered per state:
 *
 *   (a) **base FILAMENT** — two primitives, same path:
 *       - a hairline `Line2` core (`FILAMENT_CORE_WIDTH` ≈ 0.75 world units
 *         — ~1–2 CSS px at normal framing), additive, opacity =
 *         `VISUAL_STATE_STYLE.opacity × 0.5` (faint "subtle idle energy";
 *         error → `ERROR_STATIC_OPACITY` floor while the bolt carries red);
 *       - a **plasma ribbon** — a thin quad strip (`RIBBON_HALF_WIDTH` →
 *         ~0.6 world units wide, `RIBBON_SEGMENTS` quads) along the curve,
 *         `MeshBasicMaterial` + `applyPlasmaInjection` (`plasmaShader.ts`).
 *         CHOICE NOTE (webgpu-threejs-tsl port discipline): `LineMaterial`
 *         does NOT support `onBeforeCompile`, so instead of a custom line
 *         program the halo is a small ribbon mesh with the STANDARD
 *         `MeshBasicMaterial` program — the injection adds NO custom
 *         uniforms (it reuses the material's own `diffuse` uniform for the
 *         lane hue and the geometry `uv`s for the core/halo profile), so
 *         every link shares ONE compiled program (program-cache friendly —
 *         the same discipline as `makeFresnelCoreMaterial` in
 *         `sceneResources.ts`). Static by construction → correct under
 *         `prefers-reduced-motion`.
 *   (b) **ACTIVE** — a **bounded pool of ≤ 3 pulse packets** (pure
 *       scheduling in `filament.ts`: `packetPoolSize` /
 *       `packetHeadProgress`): each packet = 1 head sprite + 2 tail sprites
 *       (shared glow texture, additive, `depthWrite: false`), placed by
 *       ARC-LENGTH fraction along the curve (`createPointAtFraction` over
 *       the memoized cumulative table — webgpu-threejs-tsl arc-length-
 *       progress technique; the Bézier points were already sampled to
 *       `CURVE_SEGMENTS`). Heads ease-in-out over `PULSE_PERIOD_S`
 *       (~2.5 s/hop — interaction-design: ease-in-out for a continuous
 *       cycle); tails trail behind with decaying scale/opacity (comet).
 *       Pool = 0 when the link has no active traffic OR under reduced
 *       motion (scale-down). Packets are driven ONLY by the existing
 *       `visualState` evidence — never fabricated.
 *   (c) **COMPLETION** — on transition INTO `last`: ONE teal flash impulse
 *       (#2DD4BF) that now **TRAVELS** — a short cool impulse moving from
 *       the atom toward the hub (`COMPLETION_TRAVEL_FRACTION` of the arc)
 *       over ~350 ms, sharp ease-out, single-shot, edge-booked by
 *       `bookTransition` (never re-fires; a transition that occurs while
 *       `paused` is deferred until the first unpaused frame — "never while
 *       paused").
 *   (d) **FAILURE** — on transition INTO `error`: ONE ~1.2 s exponential-
 *       decay burst of procedural **jagged red lightning** — a
 *       deterministic polyline (9–14 segments, `mulberry32` over FNV-1a of
 *       id+state) plus **1–2 short seeded branches** forking off
 *       mid-segments (`filament.ts::branchGeometry`; memoized with the
 *       bolt, same seed discipline — time-bounded by the same one-shot
 *       envelope, NEVER latched while in error). While still in `error`,
 *       a faint static red filament remains (the bolt at low opacity —
 *       single-shot, pinned by `sceneOneShot.test.ts`).
 *
 * No fabrication: pulses/flash/lightning are driven ONLY by the existing
 * `visualState`/state-transition evidence. Zero per-frame allocations: all
 * curves/arc-tables/ribbon/branch geometry and line objects are memoized;
 * per-frame work only mutates sprite positions/scales/opacities and
 * material opacities. Everything is driven by the pause-aware
 * `sceneClock.now` (pause freezes discharge positions; resume is
 * contiguous). All geometry/material/line/sprite objects are disposed on
 * unmount (matching the existing cleanup patterns in this file).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

import type { AtomVisualDescriptor, LinkVisualDescriptor } from "../AtomicTopologyRenderer";

import { boltPoints, boltSegmentCount } from "./discharge";
import {
  MAX_PACKET_POOL,
  PACKET_TAILS,
  branchGeometry,
  buildArcLengthTable,
  buildRibbonStripData,
  completionImpulseFraction,
  createPointAtFraction,
  packetHeadOpacity,
  packetHeadProgress,
  packetPoolSize,
  packetTailOpacity,
  packetTailScale,
  packetTailStep,
} from "./filament";
import { easeInOut, easeOutSharp } from "./motion";
import { bookTransition, oneShotIntensity, type OneShotEvent } from "./oneShot";
import { applyPlasmaInjection } from "./plasmaShader";
import { getSharedGlowTexture } from "./sceneResources";
import { sceneClock, sceneState } from "./sceneState";

/** How far the Bézier control point bows outward (bounded aesthetic, unchanged). */
const ARC_FACTOR = 0.25;
/** Bézier sampling resolution (pre-computed point list, no per-frame work). */
const CURVE_SEGMENTS = 24;
/** Hairline core width (world units) — ~1–2 CSS px at normal framing (S8.1). */
const FILAMENT_CORE_WIDTH = 0.75;
/** Ribbon quad-strip half-width (world units) → ~0.6 wide halo strip. */
const RIBBON_HALF_WIDTH = 0.3;
/** Ribbon segment count (memoized geometry — not per-frame work). */
const RIBBON_SEGMENTS = 32;
/** Active pulse hop period (s) — spec: ~2.5 s per hop, per packet. */
const PULSE_PERIOD_S = 2.5;
/** Completion flash color (teal/green family per spec). */
const COMPLETION_COLOR = "#2DD4BF";
/** Failure bolt color (red family per spec). */
const FAILURE_COLOR = "#ef4444";
/** Faint static error filament opacity (spec: "faint"). */
const ERROR_STATIC_OPACITY = 0.25;
/** Max perpendicular bolt jitter (world units) — bounded, reads as arcing. */
const BOLT_MAX_JITTER = 26;
/** Pulse head sprite diameter (world units). */
const PULSE_SIZE = 36;
/** Pulse tail sprite diameter (world units) (scaled further by `packetTailScale`). */
const PULSE_TAIL_SIZE = 24;
/** Completion flash sprite diameter (world units). */
const FLASH_SIZE = 150;

export function EnergyLink({
  descriptor,
  atoms,
  paused,
}: {
  descriptor: LinkVisualDescriptor;
  atoms: AtomVisualDescriptor[];
  paused: boolean;
}) {
  const target = atoms.find((a) => a.id === descriptor.target) ?? null;
  const state = descriptor.visualState.state;
  const style = descriptor.visualState.style;
  const isActive = state === "active" && style.animated;

  const pausedRef = useRef(paused);
  // Sync in an effect (not during render — react-hooks/refs). Declared before
  // the transition-booking effect below so booking always sees current `paused`.
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  // --- Curve (memoized; rebuilt only when the target atom moves) -----------
  const curvePoints = useMemo(() => {
    if (!target) return null;
    const start = new THREE.Vector3(0, 0, 0);
    const end = new THREE.Vector3(target.position.x, target.position.y, target.position.z);
    const mid = start.clone().add(end).multiplyScalar(0.5);
    const radial = mid.lengthSq() > 1e-6 ? mid.clone().normalize() : new THREE.Vector3(0, 0, 1);
    const control = mid.clone().add(radial.multiplyScalar(end.length() * ARC_FACTOR));
    const curve = new THREE.QuadraticBezierCurve3(start, control, end);
    // Arc-length parameterization (S8.1): the SAME sampling as before, plus
    // a memoized cumulative arc-length table + fraction lookup, so every
    // effect places its heads by arc length (constant visual speed) with
    // zero per-frame cost.
    const points = curve.getPoints(CURVE_SEGMENTS);
    const flat: number[] = [];
    for (const p of points) flat.push(p.x, p.y, p.z);
    const arc = buildArcLengthTable(flat);
    const pointAt = createPointAtFraction(arc, flat);
    return { points, end, pointAt };
  }, [target]);

  // --- Base filament hairline core (Line2 — real width semantics, additive)
  const filamentGeometry = useMemo(() => {
    if (!curvePoints) return null;
    const geometry = new LineGeometry();
    const flat: number[] = [];
    for (const p of curvePoints.points) flat.push(p.x, p.y, p.z);
    geometry.setPositions(flat);
    return geometry;
  }, [curvePoints]);

  const filamentMaterial = useMemo(
    () =>
      new LineMaterial({
        color: new THREE.Color(descriptor.laneHue),
        linewidth: FILAMENT_CORE_WIDTH, // world units (LineMaterial worldUnits)
        transparent: true,
        opacity: 0.15,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [descriptor.laneHue]
  );
  useEffect(() => () => filamentMaterial.dispose(), [filamentMaterial]);
  useEffect(() => () => filamentGeometry?.dispose(), [filamentGeometry]);

  const filamentLine = useMemo(
    () => (filamentGeometry ? new Line2(filamentGeometry, filamentMaterial) : null),
    [filamentGeometry, filamentMaterial]
  );
  // Per-frame three.js writes go through a ref synced in an effect — never the
  // hook-bound value (react-hooks/immutability). The frame after (re)mount
  // renders the material's constructor values, then the loop takes over.
  const filamentMaterialRef = useRef<LineMaterial | null>(null);
  useEffect(() => {
    filamentMaterialRef.current = filamentMaterial;
  }, [filamentMaterial]);

  // --- Plasma ribbon (halo quad-strip along the same path, S8.1) -----------
  // Ribbon basis (0,1,0): the strip extends vertically; the curves bow in
  // the screen plane at the default framing, and at ~0.6 world units wide
  // the strip reads as a gentle halo around the hairline core (not a tube).
  const ribbonGeometry = useMemo(() => {
    if (!curvePoints) return null;
    const flat: number[] = [];
    for (const p of curvePoints.points) flat.push(p.x, p.y, p.z);
    const table = buildArcLengthTable(flat);
    const { positions, uvs, indices } = buildRibbonStripData(
      table,
      flat,
      RIBBON_SEGMENTS,
      RIBBON_HALF_WIDTH,
      1, // basisY — vertical (screen-facing at default framing)
      0 // basisZ
    );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return geometry;
  }, [curvePoints]);

  const ribbonMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(descriptor.laneHue),
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    applyPlasmaInjection(material);
    return material;
  }, [descriptor.laneHue]);
  useEffect(() => () => ribbonMaterial.dispose(), [ribbonMaterial]);
  useEffect(() => () => ribbonGeometry?.dispose(), [ribbonGeometry]);

  const ribbonMesh = useMemo(
    () => (ribbonGeometry ? new THREE.Mesh(ribbonGeometry, ribbonMaterial) : null),
    [ribbonGeometry, ribbonMaterial]
  );
  const ribbonMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null);
  useEffect(() => {
    ribbonMaterialRef.current = ribbonMaterial;
  }, [ribbonMaterial]);

  // --- Pulse packet pool (S8.1 — bounded: ≤ MAX_PACKET_POOL packets) -------
  // Preallocated once (MAX_PACKET_POOL heads + PACKET_TAILS tails each): the
  // pool SIZE per frame comes from the visual-state evidence only; sprites
  // beyond it are simply hidden. Materials are disposed on unmount (sprite
  // meshes are stateless containers; the shared glow texture is a scene-
  // level resource owned by `sceneResources.ts`).
  const glow = useMemo(() => getSharedGlowTexture(), []);
  const pulsePool = useMemo(() => {
    const sprites: THREE.Sprite[] = [];
    if (!glow) return sprites;
    for (let index = 0; index < MAX_PACKET_POOL; index += 1) {
      for (let tail = 0; tail <= PACKET_TAILS; tail += 1) {
        const size = tail === 0 ? PULSE_SIZE : PULSE_TAIL_SIZE;
        const material = new THREE.SpriteMaterial({
          map: glow,
          color: new THREE.Color(descriptor.laneHue),
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const sprite = new THREE.Sprite(material);
        sprite.visible = false;
        sprite.scale.set(size, size, 1);
        sprites.push(sprite);
      }
    }
    return sprites;
  }, [glow, descriptor.laneHue]);
  useEffect(() => {
    const pool = pulsePool;
    return () => {
      for (const sprite of pool) sprite.material.dispose();
    };
  }, [pulsePool]);
  // The per-frame callback mutates sprite fields on this pool; the
  // react-hooks/immutability rule forbids mutating a `useMemo` value from
  // `useFrame`, so — like `filamentMaterialRef` / `ribbonMaterialRef` — the
  // frame loop reaches the sprites through a ref bridge.
  const pulsePoolRef = useRef<THREE.Sprite[]>([]);
  useEffect(() => {
    pulsePoolRef.current = pulsePool;
  }, [pulsePool]);

  // --- Failure bolt + branches (deterministic, seeded, single-shot) --------
  const boltGeometry = useMemo(() => {
    if (!curvePoints || state !== "error") return null;
    const segments = boltSegmentCount(`${descriptor.id}:error`);
    const chordLength = Math.max(1, curvePoints.end.length());
    // Jitter amplitude as a fraction of the chord → bounded world offset
    // (≤ BOLT_MAX_JITTER) decaying outward from the hub (see boltAmplitudeAt).
    const amp = BOLT_MAX_JITTER / chordLength;
    const points = boltPoints(segments, `${descriptor.id}:error`, amp);
    // S8.1: 1–2 short SEEDED branches fork off the bolt's mid-segments
    // (pure — filament.ts; same mulberry32/FNV-1a seed discipline).
    const boltFlat: number[] = [];
    for (const p of points) boltFlat.push(p.x, p.y, p.z);
    const branches = branchGeometry(`${descriptor.id}:error`, boltFlat, amp);
    const axis = curvePoints.end.clone().normalize();
    const up = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const px = axis.clone().cross(up).normalize();
    const pz = axis.clone().cross(px).normalize();
    const toWorld = (u: number, v: number, w: number): [number, number, number] => [
      u * chordLength + px.x * v * chordLength + pz.x * w * chordLength,
      px.y * v * chordLength + pz.y * w * chordLength,
      px.z * v * chordLength + pz.z * w * chordLength,
    ];
    const flat: number[] = [];
    const push = (p: { x: number; y: number; z: number }): void => {
      const [wx, wy, wz] = toWorld(p.x, p.y, p.z);
      flat.push(wx, wy, wz);
    };
    // Main bolt polyline (p.x is the fraction along the unit axis; y/z are
    // perpendicular jitter — same world mapping as the pre-008 bolt).
    for (const p of points) push(p);
    // Branches: anchor (on the bolt) → kink 1 → kink 2 (open polylines —
    // they die out; the same red material + burst envelope drives them).
    for (const b of branches) {
      push({ x: b.x0, y: b.y0, z: b.z0 });
      push({ x: b.x1, y: b.y1, z: b.z1 });
      push({ x: b.x2, y: b.y2, z: b.z2 });
    }
    const geometry = new LineGeometry();
    geometry.setPositions(flat);
    return geometry;
  }, [curvePoints, descriptor.id, state]);

  const boltMaterial = useMemo(
    () =>
      new LineMaterial({
        color: new THREE.Color(FAILURE_COLOR),
        linewidth: 3,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    []
  );
  useEffect(() => () => boltMaterial.dispose(), [boltMaterial]);
  useEffect(() => () => boltGeometry?.dispose(), [boltGeometry]);

  const boltLine = useMemo(
    () => (boltGeometry ? new Line2(boltGeometry, boltMaterial) : null),
    [boltGeometry, boltMaterial]
  );
  // Per-frame visibility/opacity go through a ref (see above).
  const boltLineRef = useRef<Line2 | null>(null);
  useEffect(() => {
    boltLineRef.current = boltLine;
  }, [boltLine]);

  // --- One-shot impulses: completion flash / failure burst -----------------
  // sceneOneShot.test.ts). A transition observed while paused is deferred to
  // the first unpaused frame ("never while paused").
  const [flash, setFlash] = useState<OneShotEvent | null>(null);
  const [burst, setBurst] = useState<OneShotEvent | null>(null);
  const pendingRef = useRef<OneShotEvent | null>(null);
  const prevStateRef = useRef(state);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (prev === state) return;
    const event = bookTransition(prev, state, sceneClock.now);
    if (!event) return;
    if (pausedRef.current) {
      pendingRef.current = event; // deferred until unpaused
      return;
    }
    if (event.kind === "completion") setFlash(event);
    else setBurst(event);
  }, [state]);

  // --- Flash sprite + per-frame scratch --------------------------------------
  const flashRef = useRef<THREE.Sprite | null>(null);
  const lerpTmp = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const contextLost = sceneState.contextLost;
    const reduced = sceneState.reducedMotion;
    const t = sceneClock.now;

    // Defer one-shots that were booked while paused to the first live frame.
    if (pendingRef.current && !pausedRef.current && !contextLost) {
      const event = pendingRef.current;
      pendingRef.current = null;
      event.startAt = t;
      if (event.kind === "completion") setFlash(event);
      else setBurst(event);
    }

    // (a) base filament — hairline core (state opacity × 0.5; error → the
    // bolt carries the red) + plasma ribbon halo (slightly fainter than the
    // core — the halo must stay "low-contrast").
    const filamentMat = filamentMaterialRef.current;
    if (filamentMat) {
      filamentMat.opacity = state === "error" ? ERROR_STATIC_OPACITY : style.opacity * 0.5;
      filamentMat.linewidth = FILAMENT_CORE_WIDTH;
    }
    const ribbonMat = ribbonMaterialRef.current;
    if (ribbonMat) {
      ribbonMat.opacity = state === "error" ? ERROR_STATIC_OPACITY * 0.8 : style.opacity * 0.45;
    }

    // (b) active packets — bounded pool, arc-length travel, ease-in-out.
    // (reduced motion → pool 0: accessibility.md static render.)
    // Proven gate (OR-ATOM-009 S9.4): packets ride only a PROVEN link — the
    // thin filament, the completion impulse and the failure bolt below are
    // event-level and unaffected (an unproven link still shows its filament
    // and flashes on a real transition; it simply carries no traffic
    // packets). `descriptor.proven` is derived from the snapshot's own
    // evidence (`scene/provenPulse.ts`), never a guess.
    const poolSize = packetPoolSize(MAX_PACKET_POOL, isActive && descriptor.proven, reduced);
    const pool = pulsePoolRef.current;
    for (let i = 0; i < pool.length; i += 1) {
      const sprite = pool[i];
      const index = Math.floor(i / (1 + PACKET_TAILS));
      const tail = i % (1 + PACKET_TAILS);
      if (index >= poolSize || !curvePoints) {
        sprite.visible = false;
        continue;
      }
      const progress = packetHeadProgress(t, PULSE_PERIOD_S, index, poolSize);
      if (progress <= 0) {
        sprite.visible = false;
        continue;
      }
      const headF = easeInOut(progress);
      const f = tail === 0 ? headF : Math.max(0, headF - packetTailStep(tail));
      curvePoints.pointAt(f, lerpTmp);
      sprite.position.copy(lerpTmp);
      sprite.visible = true;
      const mat = sprite.material as THREE.SpriteMaterial;
      mat.opacity =
        tail === 0 ? 0.85 * packetHeadOpacity(progress) : packetTailOpacity(progress, tail);
      const scale = tail === 0 ? 1 : packetTailScale(tail);
      const size = tail === 0 ? PULSE_SIZE : PULSE_TAIL_SIZE;
      sprite.scale.set(size * scale, size * scale, 1);
    }

    // (c) completion — one TRAVELING teal impulse from the atom toward the
    // hub (S8.1): the sprite moves along the arc while the sharp ease-out
    // intensity decays; it decays cleanly (intensity 0 at duration).
    const flashSprite = flashRef.current;
    if (flashSprite) {
      const intensity = flash ? oneShotIntensity(flash, t) : 0;
      const visible = intensity > 0.01 && !!curvePoints && !reduced;
      flashSprite.visible = visible;
      if (visible && flash && curvePoints) {
        const elapsedFrac = Math.min(1, Math.max(0, (t - flash.startAt) / flash.duration));
        const fraction = completionImpulseFraction(elapsedFrac, easeOutSharp(elapsedFrac));
        curvePoints.pointAt(fraction, lerpTmp);
        flashSprite.position.copy(lerpTmp);
        (flashSprite.material as THREE.SpriteMaterial).opacity = 0.9 * intensity;
        // Expand as it fades (a soft "pop" that reads without a label).
        flashSprite.scale.setScalar(FLASH_SIZE * (0.5 + 1.5 * (1 - intensity)));
      }
    }

    // (d) failure bolt + branches — static faint while error; one decaying
    // burst on the edge into error (never loops, never latched).
    const bolt = boltLineRef.current;
    if (bolt) {
      bolt.visible = state === "error";
      const m = bolt.material as LineMaterial;
      const burstIntensity = burst ? oneShotIntensity(burst, t) : 0;
      m.opacity = ERROR_STATIC_OPACITY + (1 - ERROR_STATIC_OPACITY) * burstIntensity;
      m.linewidth = style.width + 1;
    }
  });

  if (!curvePoints) return null;

  return (
    <group>
      {/* (a) base filament — hairline core (Line2) + plasma ribbon halo */}
      {filamentLine && <primitive object={filamentLine} />}
      {ribbonMesh && <primitive object={ribbonMesh} />}
      {/* (b) active pulse packets (bounded preallocated pool) */}
      {pulsePool.map((sprite, i) => (
        <primitive key={i} object={sprite} />
      ))}
      {/* (c) completion flash (traveling) */}
      {glow && (
        <sprite ref={flashRef} scale={[FLASH_SIZE, FLASH_SIZE, 1]} visible={false}>
          <spriteMaterial
            map={glow}
            color={COMPLETION_COLOR}
            transparent
            opacity={0}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
      )}
      {/* (d) failure lightning bolt (+ seeded branches in the same geometry) */}
      {boltLine && <primitive object={boltLine} />}
    </group>
  );
}
