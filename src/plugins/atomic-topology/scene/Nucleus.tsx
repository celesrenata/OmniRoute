"use client";

/**
 * The hub nucleus — the central atom of the topology (OR-ATOM-007;
 * OR-ATOM-008 S8.3 — proton/neutron nucleus cluster + model identity).
 *
 * Rendered at the world origin as the "nucleus" of the atomic model. The
 * core color is the truthful per-state mapping
 * ({@link NUCLEUS_STATE_COLOR} — healthy → blue, error → red, idle →
 * slate), unchanged, and keeps the same "luminous" treatment:
 *   (a) **fresnel rim glow** (shared injection via
 *       {@link makeFresnelCoreMaterial} — the nucleon role materials use
 *       the identical injection, so anchor + nucleons share ONE compiled
 *       program; roles differ only in uniforms);
 *   (b) an **outer additive glow sprite** (shared radial-gradient texture)
 *       so the hub reads as the scene's primary light source;
 *   (c) subtle **breathing** (±2 %, slow period, tied to the state: an
 *       error hub breathes faster — urgency — while paused / reduced-motion
 *       holds it still), now applied to the anchor AND the cluster.
 *
 * S8.3 cluster: the hub wears 12 nucleons (prominence — more than the
 * ring atoms' 8) on the same deterministic proton/neutron shell: protons
 * larger/brighter/smooth, neutrons smaller/darker/matte, tinted per
 * instance. The hub has **no model attribution** (no per-node model ids
 * exist on the snapshot for the hub), so it ALWAYS renders the honest
 * neutral two-tone palette — never a model-color group.
 *
 * The cluster itself is *static* (orientation fixed by the seed): the hub
 * carries no measured spin rate, and motion here must never be fabricated
 * — the "alive" reading comes from its existing slow constant-speed
 * {@link ElectronCloud} (one fixed ring), which is unchanged.
 *
 * R3F/three are confined to this `scene/**` subtree.
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import type { AtomVisualDescriptor, AtomicVisualState } from "../AtomicTopologyRenderer";
import { fnv1a } from "./cloudShells";
import { breathingScale } from "./motion";
import {
  ANCHOR_RADIUS_FRACTION,
  buildNucleusCluster,
  HUB_NUCLEUS_PARTICLE_COUNT,
  NUCLEUS_PARTICLE_BASE_RADIUS,
  NUCLEUS_SHELL_RADIUS,
  NEUTRON_EMISSIVE_MUL,
  NEUTRON_ROUGHNESS,
  PROTON_EMISSIVE_MUL,
  PROTON_ROUGHNESS,
  type NucleusCluster,
  type NucleusParticle,
} from "./nucleusCluster";
import { getSharedGlowTexture, makeFresnelCoreMaterial } from "./sceneResources";
import { sceneClock, sceneState } from "./sceneState";
import { ElectronCloud } from "./ElectronCloud";

/** World-space radius of the nucleus sphere (unchanged). */
const NUCLEUS_RADIUS = 42;

/** Nucleus core color per resolved visual state (truthful mapping, unchanged). */
const NUCLEUS_STATE_COLOR: Record<AtomicVisualState, string> = {
  error: "#ef4444",
  active: "#3b82f6",
  last: "#60a5fa",
  healthy: "#3b82f6",
  idle: "#64748b",
};

/** Breathing amplitude: ±2 % (design spec). */
const BREATH_AMPLITUDE = 0.02;
/** Breathing periods per state (s): error is urgent, others are ambient. */
const BREATH_PERIOD: Record<AtomicVisualState, number> = {
  error: 1.2,
  active: 2.2,
  last: 3,
  healthy: 3,
  idle: 3.5,
};
/** Outer glow sprite diameter, nucleus-relative. */
const GLOW_SPRITE_SCALE = 2.6;
/** Focused emphasis (readable, not orbit — unchanged behavior). */
const FOCUSED_RIM_BOOST = 1.0;
/** Base emissive of the hub anchor/cluster (uniform across states, as today). */
const HUB_BASE_EMISSIVE = 0.4;

/** World-space radius of the central anchor sphere (small dense core). */
const ANCHOR_WORLD_RADIUS = NUCLEUS_RADIUS * NUCLEUS_SHELL_RADIUS * ANCHOR_RADIUS_FRACTION;
/** World-space radius of one base nucleon (before the per-particle scaleMul). */
const NUCLEON_WORLD_RADIUS = NUCLEUS_RADIUS * NUCLEUS_PARTICLE_BASE_RADIUS;
/** Nucleon cluster offset scale — particle positions are core-radius units. */
const NUCLEON_CLUSTER_SCALE = NUCLEUS_RADIUS;

/** Role diffuse/emissive tint: white (diffuse carries the instance tint). */
const ROLE_BASE_TINT = "#ffffff";

/**
 * Build the two instanced role meshes (protons / neutrons) for the hub
 * from the deterministic cluster. ONE unit-sphere geometry is shared by
 * both meshes; per-instance color carries the nucleon tint, per-role
 * material carries the roughness/emissive differentiation — the two
 * materials use the same `makeFresnelCoreMaterial` injection, so the whole
 * hub (anchor + protons + neutrons) compiles to ONE program (program-cache
 * friendly; roles differ only in uniforms).
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

export function Nucleus({
  descriptor,
  paused,
  focused,
}: {
  descriptor: AtomVisualDescriptor;
  paused: boolean;
  focused: boolean;
}) {
  const coreRef = useRef<THREE.Mesh | null>(null);
  const clusterRef = useRef<THREE.Group | null>(null);

  const state = descriptor.visualState.state;
  const coreColor = NUCLEUS_STATE_COLOR[state] ?? NUCLEUS_STATE_COLOR.healthy;
  // A focused nucleus glows more strongly (readable emphasis).
  const rimBoost = focused ? FOCUSED_RIM_BOOST : 1;
  const stateEmissive = HUB_BASE_EMISSIVE * rimBoost;

  // One shared fresnel-injected anchor material, tinted by the per-state
  // color (truthful mapping, unchanged).
  const coreMaterial = useMemo(() => {
    const m = makeFresnelCoreMaterial(coreColor, coreColor, stateEmissive);
    return m;
  }, [coreColor, stateEmissive]);

  // Deterministic seed (same FNV-1a pattern as `visualEncoding.ts`). The
  // hub ALWAYS renders the neutral two-tone palette — it has no model
  // attribution (the snapshot carries no per-node model ids for the hub),
  // so `observedModelIds` is deliberately never passed.
  const seed = useMemo(() => fnv1a(descriptor.id), [descriptor.id]);
  const cluster = useMemo(
    () =>
      buildNucleusCluster({
        seed,
        particleCount: HUB_NUCLEUS_PARTICLE_COUNT,
      }),
    [seed]
  );

  const glowTexture = useMemo(() => getSharedGlowTexture(), []);

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

  // Per-frame: breathing scale (static when paused / reduced-motion /
  // context lost). No React state; only the anchor + cluster scales are
  // mutated (the cluster orientation is seed-fixed — static, no spin, since
  // the hub has no measured rate to map).
  useFrame(() => {
    const core = coreRef.current;
    const cl = clusterRef.current;
    if (!core && !cl) return;
    const frozen = paused || sceneState.contextLost || sceneState.reducedMotion;
    const s = frozen
      ? 1
      : breathingScale(sceneClock.now, BREATH_PERIOD[state], BREATH_AMPLITUDE, true);
    if (core) core.scale.setScalar(ANCHOR_WORLD_RADIUS * s);
    if (cl) cl.scale.setScalar(s);
  });

  return (
    <group position={[0, 0, 0]}>
      {/* Central anchor sphere — small dense core; fresnel rim injected. */}
      <mesh ref={coreRef} scale={ANCHOR_WORLD_RADIUS}>
        <sphereGeometry args={[1, 32, 32]} />
        <primitive object={coreMaterial} attach="material" />
      </mesh>
      {/* Proton/neutron nucleon cluster (instanced, shared unit geometry). */}
      <group ref={clusterRef}>
        <primitive object={roleMeshes.protonMesh} dispose={null} />
        <primitive object={roleMeshes.neutronMesh} dispose={null} />
      </group>
      {/* Outer additive glow — the scene's primary light source. */}
      {glowTexture && (
        <sprite scale={[NUCLEUS_RADIUS * GLOW_SPRITE_SCALE, NUCLEUS_RADIUS * GLOW_SPRITE_SCALE, 1]}>
          <spriteMaterial
            map={glowTexture}
            color={coreColor}
            transparent
            opacity={0.22}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
      )}
      {/* A slow single shell around the nucleus so the hub reads as "alive". */}
      <ElectronCloud
        radius={NUCLEUS_RADIUS + 26}
        speed={0.4}
        paused={paused}
        color="#93c5fd"
        seed={seed}
        electronCount={9}
        tilt={0.35}
        staticSpeed={0.4}
      />
    </group>
  );
}
