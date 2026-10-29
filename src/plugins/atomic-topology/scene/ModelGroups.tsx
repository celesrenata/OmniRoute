"use client";

/**
 * Model-group sub-clusters for one nucleus (OR-ATOM-009, Phase 2 W2).
 *
 * Renders the "up to three visible model-colored particle groups" rule as
 * small instanced sub-clusters INSIDE the nucleus: each observed model
 * occupies its own deterministic angular sector, tinted with the SAME
 * color family as the rest of the scene (`modelColor` — the truthful
 * identity color from `visualEncoding.ts`, never a guess).
 *
 * Visual family (OR-ATOM-008 S8.3 + Step 8 layering rules):
 * - the sub-cluster particles reuse the nucleon material pattern
 *   (`makeFresnelCoreMaterial` — one compiled program shared with anchor
 *   + nucleons, program-cache friendly) at a small "particle" scale;
 * - additive blending + `depthWrite: false` + low per-layer opacity, so
 *   the groups layer into the luminous nucleus without blowing out white
 *   (same contract as the glow sprite / haze / filament layers).
 *
 * One instanced mesh — ONE draw call for all visible groups.
 *
 * Motion contract (motion-audit §4/§6 gate semantics, same as
 * `ElectronCloud`): a single slow constant ambient spin from the shared
 * pause-aware clock (absolute angle = `speed * t` — exact freeze, no
 * drift, contiguous resume). `paused`, `reducedMotion`, or a lost WebGL
 * context all freeze the layout to a static frame (the mutation is
 * skipped, so the last rendered orientation is held exactly). The ambient
 * spin is a static visual constant — NOT derived from telemetry (no
 * fabricated attribution); the measured-TPS nucleus spin is wired by the
 * Phase 3 integrator through `nucleusMotion.ts` helpers.
 *
 * Zero per-frame allocation in `useFrame` (ref reads + one modulo write).
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import { modelColor } from "../visualEncoding";
import { fnv1a } from "./cloudShells";
import { MAX_MODEL_GROUPS } from "./nucleusCluster";
import type { ModelGroupSlot, ModelGroupSlots } from "./nucleusMotion";
import { makeFresnelCoreMaterial } from "./sceneResources";
import { sceneClock, sceneState } from "./sceneState";

/** Group base tint: white — per-instance color carries the model color. */
const GROUP_BASE_TINT = "#ffffff";
/** Per-state-style emissive for the additive particle layer. */
const GROUP_EMISSIVE = 0.55;
/** Proton-family roughness (smooth) — the small bright role. */
const GROUP_ROUGHNESS = 0.35;
/** Low per-layer opacity so stacked additive layers never blow out. */
const GROUP_OPACITY = 0.55;

/** Visible groups per nucleus (the "up to three" rule). */
const GROUPS_PER_NUCLEUS = MAX_MODEL_GROUPS;
/** Particles per group (one instanced mesh total, ≤ 12 instances). */
const PARTICLES_PER_GROUP = 4;

/* ------------------------------------------------------------------ */
/* Layout constants (unit offsets — 1 == the atom's core radius; the   */
/* Phase 3 integrator places this component inside the nucleus group   */
/* that applies the core-radius scale, exactly like the nucleon        */
/* cluster in `AtomNode.tsx`).                                        */
/* ------------------------------------------------------------------ */

/** Sub-cluster centers sit just inside the nucleon shell (0.55). */
const GROUP_CENTER_RADIUS = 0.5;
/** Per-particle spread around the group center. */
const GROUP_SPREAD = 0.11;
/** Particle radius multiplier (small — reads as particle groups, not nucleons). */
const GROUP_PARTICLE_RADIUS = 0.06;
/** Fixed azimuth offset so a single group does not sit on the X axis. */
const AZIMUTH_BASE = 0.55;
/** Max elevation range (radians) of a group center — deterministic per model. */
const ELEVATION_RANGE = 0.6;
/** Slow ambient spin (rad/s) — a static visual constant, NOT telemetry. */
const GROUP_SPIN_RAD_PER_SECOND = 0.2;

/** Deterministic seeded PRNG (mulberry32 — same construction as `nucleusCluster.ts`). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One model-group particle spec (instanced unit-sphere fill). */
interface GroupParticle {
  /** Unit-radius offset — 1 == the atom's core radius. */
  position: [number, number, number];
  /** Radius multiplier (per-particle size variation, deterministic). */
  scaleMul: number;
  /** Final per-instance tint — the model's identity color. */
  color: string;
}

/**
 * Deterministic layout for ONE model group: a small cluster of particles
 * around a sector center. The sector azimuth comes from the slot index
 * (contiguous, ordered bands — same "angular sector" rule as
 * `nucleusCluster.ts`); elevation + per-particle offsets come from a PRNG
 * seeded by the model id (STABLE across polls and seeds — never
 * `Math.random`), so a model keeps the same spatial identity forever.
 */
function buildGroupParticles(slot: ModelGroupSlot): GroupParticle[] {
  const rng = mulberry32(fnv1a(slot.modelId));
  const azimuth = slot.index * ((Math.PI * 2) / GROUPS_PER_NUCLEUS) + AZIMUTH_BASE;
  const elevation = (rng() - 0.5) * ELEVATION_RANGE;
  const cosElevation = Math.cos(elevation);
  const center: [number, number, number] = [
    Math.cos(azimuth) * cosElevation * GROUP_CENTER_RADIUS,
    Math.sin(elevation) * GROUP_CENTER_RADIUS,
    Math.sin(azimuth) * cosElevation * GROUP_CENTER_RADIUS,
  ];
  const tint = modelColor(slot.modelId);
  const particles: GroupParticle[] = [];
  for (let k = 0; k < PARTICLES_PER_GROUP; k += 1) {
    const phi = rng() * Math.PI * 2;
    const cosTheta = 2 * rng() - 1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    particles.push({
      position: [
        center[0] + Math.cos(phi) * sinTheta * GROUP_SPREAD,
        center[1] + Math.sin(phi) * sinTheta * GROUP_SPREAD,
        center[2] + cosTheta * GROUP_SPREAD,
      ],
      scaleMul: 0.85 + 0.3 * rng(),
      color: tint,
    });
  }
  return particles;
}

/**
 * Build the ONE instanced mesh for all visible groups (≤ 3 × 4 = 12
 * instances → ONE draw call). Geometry/material are created ONCE per
 * slots identity; the caller disposes them on unmount (sceneResources
 * lifecycle pattern — `mesh.dispose()` frees the instance buffers, then
 * geometry + material).
 */
function buildModelGroupMesh(slots: readonly ModelGroupSlot[]): THREE.InstancedMesh | null {
  if (slots.length === 0) return null;
  const particles: GroupParticle[] = [];
  for (let i = 0; i < Math.min(slots.length, GROUPS_PER_NUCLEUS); i += 1) {
    particles.push(...buildGroupParticles(slots[i]));
  }
  const geometry = new THREE.SphereGeometry(1, 16, 16);
  const material = makeFresnelCoreMaterial(GROUP_BASE_TINT, GROUP_BASE_TINT, GROUP_EMISSIVE);
  material.roughness = GROUP_ROUGHNESS;
  material.transparent = true;
  material.opacity = GROUP_OPACITY;
  material.blending = THREE.AdditiveBlending;
  material.depthWrite = false;

  const mesh = new THREE.InstancedMesh(geometry, material, particles.length);
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  for (let i = 0; i < particles.length; i += 1) {
    const p = particles[i];
    const s = GROUP_PARTICLE_RADIUS * p.scaleMul;
    matrix.makeScale(s, s, s);
    matrix.setPosition(p.position[0], p.position[1], p.position[2]);
    mesh.setMatrixAt(i, matrix);
    color.set(p.color);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

/** Props for the model-group sub-clusters. */
export interface ModelGroupsProps {
  /** Model-group slots from `buildModelGroupSlots` (stable/memoized identity). */
  slots: ModelGroupSlots;
  /** When true the layout holds still (host `setPaused` contract). */
  paused: boolean;
  /** When true the layout is frozen to a static frame (accessibility gate). */
  reducedMotion: boolean;
}

/**
 * The model-group sub-clusters component. Mount it INSIDE the nucleus
 * group that applies the core-radius scale (next to the nucleon cluster
 * in `Nucleus.tsx` / `AtomNode.tsx`) — unit offsets are 1 == core radius.
 */
export function ModelGroups({ slots, paused, reducedMotion }: ModelGroupsProps) {
  const groupRef = useRef<THREE.Group>(null);

  // ONE instanced mesh, created once per slots identity (the integrator
  // memoizes `slots` — a new model set is a deliberate rebuild).
  const mesh = useMemo(() => buildModelGroupMesh(slots.slots), [slots]);

  // Dispose on unmount / rebuild (sceneResources lifecycle pattern).
  useEffect(
    () => () => {
      if (!mesh) return;
      mesh.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
    [mesh]
  );

  // Per-frame: the single slow ambient spin from the shared pause-aware
  // clock. The frozen gate (same semantics as `ElectronCloud`) skips the
  // mutation entirely — exact freeze, no drift, contiguous resume.
  // Zero allocation: ref reads + one modulo write.
  useFrame(() => {
    const group = groupRef.current;
    if (!group || !mesh) return;
    const frozen = paused || reducedMotion || sceneState.contextLost || sceneState.reducedMotion;
    if (frozen) return;
    group.rotation.y = (GROUP_SPIN_RAD_PER_SECOND * sceneClock.now) % (Math.PI * 2);
  });

  if (!mesh) return null;
  return (
    <group ref={groupRef}>
      <primitive object={mesh} dispose={null} />
    </group>
  );
}
