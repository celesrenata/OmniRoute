"use client";

/**
 * A provider/gpu atom at its deterministic layout position (OR-ATOM-007;
 * OR-ATOM-008 S8.3 — proton/neutron nucleus cluster + model identity).
 *
 * "Colored nuclei, luminous": the atom body is now a deterministic
 * proton/neutron nucleus cluster ({@link buildNucleusCluster} — 8 instanced
 * nucleons: protons larger, brighter, smooth; neutrons smaller, darker,
 * matte — shape + material + luminance separation, NOT a color wash). Each
 * nucleon is tinted per instance (three.js `instanceColor` multiplies the
 * white role diffuse), so today's honest neutral two-tone reads warm-white
 * protons / cool-slate neutrons (the snapshot carries no per-node model
 * ids — see {@link AtomVisualDescriptor.observedModelIds}); once ids ARE
 * observed, at most 3 model-color angular sectors (hashed by model id,
 * stable under order changes) spatially cluster the nucleons.
 *
 * The core sphere is kept as the *small central anchor* with its truthful
 * emissive mapping ({@link AtomVisualDescriptor.color} — NEVER recolored by
 * state) and keeps:
 *   (a) a **fresnel rim glow** (`makeFresnelCoreMaterial` — the nucleon
 *       role materials use the identical `onBeforeCompile` injection, so
 *       every core + nucleon shares ONE compiled program; roles differ
 *       only in uniforms: roughness + emissive);
 *   (b) an **outer additive glow sprite** (shared radial-gradient texture,
 *       `AdditiveBlending`, `depthWrite: false`) — truthful identity color;
 *   (c) subtle **breathing**: ±2 % scale pulsation tied to the spin mode
 *       (`motionParams` — measured rate only; paused / reduced-motion →
 *       still), applied to the anchor AND the whole cluster with one factor.
 *
 * Per-state emissive stays (error brightest) and scales the nucleon role
 * emissive (proton × {@link PROTON_EMISSIVE_MUL}, neutron ×
 * {@link NEUTRON_EMISSIVE_MUL}). Cluster spin is a shared group rotation
 * around the seeded cluster axis at the *measured* spin rate (same gate as
 * the electron cloud — never fabricated); it accumulates only while
 * unfrozen, so `paused` / reduced-motion freeze it mid-orientation and
 * resume without a jump. Instance matrices/colors are written once per
 * cluster rebuild → zero per-frame allocation.
 *
 * Focus behavior (`FOCUS_SCALE`) is unchanged and now emphasizes the whole
 * body (anchor + cluster). The queue vibration (positional tremor) is
 * unchanged and still gated on the *live* frame delta (it is positional,
 * not orbital — a frozen clock still allows the tremor to be a static
 * offset when frozen mid-frame; with `paused` it is fully still).
 *
 * Geometry is shared: ONE unit-sphere geometry per atom is reused by both
 * instanced role meshes; geometry + materials + meshes are disposed on
 * unmount (web-quality-performance: per-atom geometry count stays O(1)).
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import type { AtomVisualDescriptor } from "../AtomicTopologyRenderer";
import { breathingScale, MAX_FRAME_DELTA, motionParams } from "./motion";
import { fnv1a } from "./cloudShells";
import {
  ANCHOR_RADIUS_FRACTION,
  buildNucleusCluster,
  NUCLEUS_PARTICLE_BASE_RADIUS,
  NUCLEUS_SHELL_RADIUS,
  NEUTRON_EMISSIVE_MUL,
  NEUTRON_ROUGHNESS,
  PROTON_EMISSIVE_MUL,
  PROTON_ROUGHNESS,
  RING_NUCLEUS_PARTICLE_COUNT,
  type NucleusCluster,
  type NucleusParticle,
} from "./nucleusCluster";
import { createRotationSmoothing, tpsToRadiansPerSecond } from "./nucleusMotion";
import { getSharedGlowTexture, makeFresnelCoreMaterial } from "./sceneResources";
import { sceneClock, sceneState } from "./sceneState";
import { ElectronCloud } from "./ElectronCloud";

/** World-space radius of a ring atom's core sphere (unchanged). */
const ATOM_RADIUS = 22;
/** How much a focused atom grows (readable emphasis, not orbit — unchanged). */
const FOCUS_SCALE = 1.18;

/** Per-state emissive boost (a focused/error atom glows brighter — unchanged). */
const STATE_EMISSIVE: Record<AtomVisualDescriptor["visualState"]["state"], number> = {
  error: 0.9,
  active: 0.75,
  last: 0.5,
  healthy: 0.35,
  idle: 0.25,
};

/** Breathing amplitude: ±2 % (design spec). */
const BREATH_AMPLITUDE = 0.02;
/** Outer glow sprite diameter, atom-relative. */
const GLOW_SPRITE_SCALE = 2.4;

/** World-space radius of the central anchor sphere (small dense core). */
const ANCHOR_WORLD_RADIUS = ATOM_RADIUS * NUCLEUS_SHELL_RADIUS * ANCHOR_RADIUS_FRACTION;
/** World-space radius of one base nucleon (before the per-particle scaleMul). */
const NUCLEON_WORLD_RADIUS = ATOM_RADIUS * NUCLEUS_PARTICLE_BASE_RADIUS;
/** Nucleon cluster offset scale — particle positions are core-radius units. */
const NUCLEON_CLUSTER_SCALE = ATOM_RADIUS;

/** Role diffuse/emissive tint: white (diffuse carries the instance tint). */
const ROLE_BASE_TINT = "#ffffff";

/**
 * Build the two instanced role meshes (protons / neutrons) for one atom
 * from the deterministic cluster. ONE unit-sphere geometry is shared by
 * both meshes; per-instance color carries the nucleon tint, per-role
 * material carries the roughness/emissive differentiation — the two
 * materials use the same `makeFresnelCoreMaterial` injection, so the whole
 * atom (anchor + protons + neutrons) compiles to ONE program
 * (program-cache friendly; roles differ only in uniforms).
 */
function buildRoleMeshes(
  cluster: NucleusCluster,
  stateEmissive: number
): { protonMesh: THREE.InstancedMesh; neutronMesh: THREE.InstancedMesh } {
  const protonParticles = cluster.particles.filter((p) => p.isProton);
  const neutronParticles = cluster.particles.filter((p) => !p.isProton);

  const geometry = new THREE.SphereGeometry(1, 24, 24);
  const protonMaterial = makeFresnelCoreMaterial(
    ROLE_BASE_TINT,
    ROLE_BASE_TINT,
    stateEmissive * PROTON_EMISSIVE_MUL
  );
  protonMaterial.roughness = PROTON_ROUGHNESS;
  const neutronMaterial = makeFresnelCoreMaterial(
    ROLE_BASE_TINT,
    ROLE_BASE_TINT,
    stateEmissive * NEUTRON_EMISSIVE_MUL
  );
  neutronMaterial.roughness = NEUTRON_ROUGHNESS;

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const fill = (mesh: THREE.InstancedMesh, particles: NucleusParticle[]): void => {
    for (let i = 0; i < particles.length; i += 1) {
      const p = particles[i];
      const s = NUCLEON_WORLD_RADIUS * p.scaleMul;
      matrix.makeScale(s, s, s);
      matrix.setPosition(
        p.position[0] * NUCLEON_CLUSTER_SCALE,
        p.position[1] * NUCLEON_CLUSTER_SCALE,
        p.position[2] * NUCLEON_CLUSTER_SCALE
      );
      mesh.setMatrixAt(i, matrix);
      color.set(p.tint);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };

  const protonMesh = new THREE.InstancedMesh(
    geometry,
    protonMaterial,
    Math.max(protonParticles.length, 1)
  );
  const neutronMesh = new THREE.InstancedMesh(
    geometry,
    neutronMaterial,
    Math.max(neutronParticles.length, 1)
  );
  protonMesh.frustumCulled = false;
  neutronMesh.frustumCulled = false;
  fill(protonMesh, protonParticles);
  fill(neutronMesh, neutronParticles);
  return { protonMesh, neutronMesh };
}

export function AtomNode({
  descriptor,
  paused,
  focused,
}: {
  descriptor: AtomVisualDescriptor;
  paused: boolean;
  focused: boolean;
}) {
  const groupRef = useRef<THREE.Group | null>(null);
  const coreRef = useRef<THREE.Mesh | null>(null);
  const clusterRef = useRef<THREE.Group | null>(null);

  const { position } = descriptor;
  const basePosition = useMemo<[number, number, number]>(
    () => [position.x, position.y, position.z],
    [position]
  );

  // Deterministic seed for the layered electron shells + nucleus cluster
  // (same FNV-1a pattern as `visualEncoding.ts`).
  const seed = useMemo(() => fnv1a(descriptor.id), [descriptor.id]);

  // Motion gate (accessibility + no-fabrication): breathing/spin run only
  // for a measured positive rate; paused or reduced-motion → static.
  const motion = useMemo(
    () =>
      motionParams({
        reducedMotion: false,
        spinValue: descriptor.spin.value,
        spinMode: descriptor.spin.mode,
      }),
    [descriptor.spin.value, descriptor.spin.mode]
  );

  const stateEmissive = STATE_EMISSIVE[descriptor.visualState.state] ?? STATE_EMISSIVE.healthy;

  // One shared fresnel-injected anchor material, tinted with the truthful
  // per-model color (emissive carries the per-state boost + lane hue, as in
  // the pre-existing contract).
  const coreMaterial = useMemo(
    () =>
      makeFresnelCoreMaterial(
        descriptor.color,
        focused ? descriptor.color : descriptor.laneHue,
        stateEmissive
      ),
    [descriptor.color, descriptor.laneHue, focused, stateEmissive]
  );

  //
  // Deterministic nucleus cluster (S8.3). `observedModelIds` is absent today
  // (the snapshot carries no per-node model ids) → neutral two-tone; the
  // builder is general so model-color sectors activate automatically once
  // a future snapshot/descriptor exposes them.
  const cluster = useMemo(
    () =>
      buildNucleusCluster({
        seed,
        particleCount: RING_NUCLEUS_PARTICLE_COUNT,
        observedModelIds: descriptor.observedModelIds,
      }),
    [seed, descriptor.observedModelIds]
  );
  const clusterAxis = useMemo(
    () =>
      new THREE.Vector3(cluster.spinAxis[0], cluster.spinAxis[1], cluster.spinAxis[2]).normalize(),
    [cluster]
  );

  const glowTexture = useMemo(() => getSharedGlowTexture(), []);

  const { amplitude, frequencyHz, mode } = descriptor.vibration;
  const vibrating = !paused && mode === "measured" && amplitude > 0;

  const scale = focused ? FOCUS_SCALE : 1;

  // The instanced role meshes are built imperatively: a shared unit-sphere
  // geometry is reused by both role meshes and must be disposed with the
  // meshes on unmount/rebuild (JSX geometry disposal is keyed to element
  // identity, which would leak the shared buffer).
  const roleMeshes = useMemo(
    () => buildRoleMeshes(cluster, stateEmissive),
    [cluster, stateEmissive]
  );
  useEffect(
    () => () => {
      roleMeshes.protonMesh.dispose();
      roleMeshes.neutronMesh.dispose();
      roleMeshes.protonMesh.geometry.dispose();
      roleMeshes.protonMesh.material.dispose();
      roleMeshes.neutronMesh.material.dispose();
    },
    [roleMeshes]
  );

  // Preallocated per-frame rotation quaternion + accumulated spin angle
  // (zero per-frame allocation; the angle freezes mid-orientation when
  // paused and resumes contiguously).
  const clusterRotation = useMemo(() => new THREE.Quaternion(), []);
  const spinAngle = useRef(0);
  // S9.2 — the per-atom measured-TPS smoothing (EMA) is a *stable* ref, created
  // once per atom instance and stepped every live frame inside `useFrame`.
  // Stepping it in-frame (not at render) keeps the snapshot pure; freezing it
  // on pause / reduced-motion / context-loss holds the last smoothed rate and
  // orientation with no adoption jump on resume.
  const spinSmoother = useMemo(() => createRotationSmoothing(), []);

  // Per-frame: breathing scale (anchor + cluster) + cluster spin + queue
  // vibration (positional tremor). No React state; reuses only refs, the
  // preallocated quaternion and the accumulated angle.
  useFrame((_state, delta) => {
    const group = groupRef.current;
    const core = coreRef.current;
    const cl = clusterRef.current;
    if (!group) return;
    const frozen = paused || sceneState.contextLost || sceneState.reducedMotion;

    const breath =
      frozen || !motion.breathActive
        ? 1
        : breathingScale(sceneClock.now, motion.breathPeriod, BREATH_AMPLITUDE, true);
    if (core) core.scale.setScalar(ANCHOR_WORLD_RADIUS * scale * breath);
    if (cl) {
      // S9.2 — nucleus rotation binding. The cluster spins at the *measured*
      // TPS, smoothed per live frame (`spinSmoother`): a fresh sample adopts
      // instantly, subsequent samples ease in, and a `null` sample (stale /
      // missing / unattached) decays the smoothed rate toward 0 — so the
      // nucleus spins down smoothly instead of holding a fake speed, and
      // never spins when nothing is measured. Stepping + accumulating only
      // while unfrozen keeps the freeze contract (paused / reduced-motion /
      // context-loss hold the orientation, then resume contiguously).
      if (!frozen) {
        const dt = Math.min(delta, MAX_FRAME_DELTA);
        const smoothedTps = spinSmoother.step(descriptor.measuredTps, dt);
        spinAngle.current += tpsToRadiansPerSecond(smoothedTps) * dt;
      }
      clusterRotation.setFromAxisAngle(clusterAxis, spinAngle.current);
      cl.quaternion.copy(clusterRotation);
      cl.scale.setScalar(scale * breath);
    }

    if (vibrating && !frozen) {
      // Gentle 3-axis tremor at the encoded amplitude/frequency. The phase
      // is derived from the shared clock so it is continuous across
      // re-renders.
      const t = sceneClock.now * frequencyHz * Math.PI * 2;
      group.position.set(
        position.x + Math.sin(t) * amplitude,
        position.y + Math.sin(t * 1.31 + 0.7) * amplitude,
        position.z + Math.sin(t * 0.73 + 2.1) * amplitude
      );
    } else {
      group.position.set(position.x, position.y, position.z);
    }
  });

  return (
    <group ref={groupRef} position={basePosition}>
      {/* Central anchor sphere — small dense core; fresnel rim injected. */}
      <mesh ref={coreRef} scale={ANCHOR_WORLD_RADIUS * scale}>
        <sphereGeometry args={[1, 24, 24]} />
        <primitive object={coreMaterial} attach="material" />
      </mesh>
      {/* Proton/neutron nucleon cluster (instanced, shared unit geometry). */}
      <group ref={clusterRef}>
        <primitive object={roleMeshes.protonMesh} dispose={null} />
        <primitive object={roleMeshes.neutronMesh} dispose={null} />
      </group>
      {/* Outer additive glow — reads as a light source on the dark background. */}
      {glowTexture && (
        <sprite scale={[ATOM_RADIUS * GLOW_SPRITE_SCALE, ATOM_RADIUS * GLOW_SPRITE_SCALE, 1]}>
          <spriteMaterial
            map={glowTexture}
            color={descriptor.color}
            transparent
            opacity={0.18}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
      )}
      {/* Layered non-coplanar electron shells, tinted by lane hue. */}
      <ElectronCloud
        radius={ATOM_RADIUS + 16}
        speed={descriptor.spin.value}
        paused={paused}
        color={descriptor.laneHue}
        seed={seed}
      />
    </group>
  );
}
