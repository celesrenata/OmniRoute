"use client";

/**
 * Atom node — one provider/gpu atom at its deterministic layout position
 * (OR-ATOM-001 v2, M3 Phase B + M4/M6).
 *
 * An atom is a sphere colored by its deterministic lane hue / provider color,
 * wearing a slow-spinning {@link ElectronCloud} at the per-atom
 * `spinRadiansPerSecond` speed, and — when a queue is measured — a subtle
 * positional "vibration" (tremor) at the `queueVibration` amplitude/frequency.
 *
 * **M4/M6 — transient request discharge.** The atom reads the ambient
 * request-lifecycle {@link AtomicEventPool} (via {@link useAtomicSceneContext})
 * and applies a *transient* discharge for its provider: a started request
 * builds a brief energy discharge, a completed request emits a short
 * impulse/fade, and a failed request flashes red. The discharge decays back
 * to zero (see {@link computeDischarge}) and **never** reparents the atom's
 * persistent health/traffic state — a failed *request* is not a failed
 * *provider*, so `visualState` is untouched. The discharge clock is epoch
 * time: render-time (reduced-motion) reads are pinned to the snapshot's
 * capture clock (via `nowMs` in the scene context) so renders are pure, while
 * per-frame (animated) reads advance on the wall clock inside `useFrame`;
 * the pool + discharge math are three-free, and only the *material
 * application* here touches `three`.
 *
 * **Reduced motion:** continuous animation (electron spin + the per-frame
 * discharge pulse) is suppressed; a live discharge is shown as a *static*
 * emphasis (no pulsing/flashing), which is the reduced-motion-safe expression
 * of the same fact.
 *
 * `three` / R3F are confined to this `scene/**` subtree.
 *
 * Explicit unknowns:
 * - **Vibration**: driven by measured queue depth when present (`mode:
 *   "measured"`); "unavailable" (amplitude 0) otherwise — never fabricated.
 * - **GPU device atoms (`kind: "gpu"`)**: rendered forward-compatibly like a
 *   provider; a discharge is applied only when the event carries a matching
 *   `providerId`.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import type { AtomVisualDescriptor } from "../AtomicTopologyRenderer";
import { QUALITY_BUDGETS } from "../quality";
import { useAtomicSceneContext } from "./sceneContext";
import { ElectronCloud } from "./ElectronCloud";

/** World-space radius of a ring atom's core sphere. */
const ATOM_RADIUS = 22;
/** How much a focused atom grows (readable emphasis, not orbit). */
const FOCUS_SCALE = 1.18;
/** How much a live discharge grows the atom (transient emphasis). */
const DISCHARGE_SCALE = 0.22;
/** Peak emissive boost a live discharge adds on top of the state emissive. */
const DISCHARGE_EMISSIVE_BOOST = 0.9;
/** A live failed discharge tints the emissive toward this red. */
const FAILED_DISCHARGE_COLOR = "#ef4444";

/** Per-state emissive boost (a focused/error atom glows brighter). */
const STATE_EMISSIVE: Record<AtomVisualDescriptor["visualState"]["state"], number> = {
  error: 0.9,
  active: 0.75,
  last: 0.5,
  healthy: 0.35,
  idle: 0.25,
};

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
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);

  const { pool, reducedMotion, quality, nowMs } = useAtomicSceneContext();

  const { position } = descriptor;
  const basePosition = useMemo<[number, number, number]>(
    () => [position.x, position.y, position.z],
    [position]
  );

  const { amplitude, frequencyHz, mode } = descriptor.vibration;
  const vibrating = !paused && !reducedMotion && mode === "measured" && amplitude > 0;

  /**
   * The provider id the event pool is keyed on for this atom (provider atoms
   * carry one; the hub and gpu atoms do not, so they never get a discharge).
   */
  const dischargeProviderId = descriptor.kind === "provider" ? descriptor.providerId : null;

  // Reduced motion: evaluate the discharge ONCE per render (a static
  // emphasis, no per-frame pulse) — a pure read of the pool keyed on the
  // snapshot's capture clock (`nowMs`), so renders stay deterministic (no
  // wall clock during render). Normal mode: a per-frame animated pulse that
  // advances on the wall clock inside the `useFrame` block below.
  const discharge =
    reducedMotion && pool && dischargeProviderId
      ? pool.effectsFor(dischargeProviderId, nowMs)
      : { intensity: 0, red: false };

  // Per-frame update: apply the queue vibration (a small positional tremor)
  // when a queue is measured, plus the transient request discharge on the
  // emissive material + scale. No React state is allocated per frame — the
  // material/scale are mutated imperatively (three.js refs), so there are no
  // per-frame re-renders.
  useFrame((state) => {
    const group = groupRef.current;
    if (!group) return;

    // Position: vibration tremor (or rest position).
    if (vibrating) {
      const t = state.clock.elapsedTime * frequencyHz * Math.PI * 2;
      group.position.set(
        position.x + Math.sin(t) * amplitude,
        position.y + Math.cos(t * 0.9) * amplitude,
        position.z + Math.sin(t * 1.1) * amplitude
      );
    } else {
      group.position.set(position.x, position.y, position.z);
    }

    // Transient discharge (normal motion only — reduced motion uses the static
    // emphasis computed at render; a paused scene is frozen, so no per-frame
    // discharge either). Read the current wall-clock discharge from the pool
    // (transient; decays to zero; never a persistent state).
    if (!paused && !reducedMotion && pool && dischargeProviderId) {
      const d = pool.effectsFor(dischargeProviderId, Date.now());
      applyDischarge(materialRef.current, group, d, descriptor, focused);
    }
  });

  const dischargeIntensity = Math.min(1, Math.max(0, discharge.intensity));

  const emissiveBase = STATE_EMISSIVE[descriptor.visualState.state] ?? 0.35;
  const emissiveIntensity =
    (focused ? emissiveBase + 0.3 : emissiveBase) + dischargeIntensity * DISCHARGE_EMISSIVE_BOOST;
  const scale = (focused ? FOCUS_SCALE : 1) + dischargeIntensity * DISCHARGE_SCALE;
  const emissiveColor = discharge.red ? FAILED_DISCHARGE_COLOR : descriptor.laneHue;

  return (
    <group ref={groupRef} position={basePosition}>
      {/* Core sphere — colored by the deterministic atom color. */}
      <mesh scale={scale}>
        <sphereGeometry args={[ATOM_RADIUS, 32, 32]} />
        <meshStandardMaterial
          ref={materialRef}
          color={descriptor.color}
          emissive={emissiveColor}
          emissiveIntensity={emissiveIntensity}
          roughness={0.4}
          metalness={0.25}
        />
      </mesh>

      {/* Electron cloud spinning at the per-atom speed (frozen when paused or
          reduced-motion; the discharge pulse does not touch the cloud). */}
      <ElectronCloud
        radius={ATOM_RADIUS + 16}
        speed={descriptor.spin.value}
        paused={paused || reducedMotion}
        color={descriptor.laneHue}
        electronCount={QUALITY_BUDGETS[quality].cloudParticles}
      />
    </group>
  );
}

/**
 * Apply a transient discharge to the atom's material + scale. Called from the
 * frame loop (normal motion). A zero-intensity discharge restores the steady
 * emissive so the atom never latches onto a spent event.
 */
function applyDischarge(
  material: THREE.MeshStandardMaterial | null,
  group: THREE.Group,
  d: { intensity: number; red: boolean },
  descriptor: AtomVisualDescriptor,
  focused: boolean
): void {
  const dischargeIntensity = Math.min(1, Math.max(0, d.intensity));
  const emissiveBase = STATE_EMISSIVE[descriptor.visualState.state] ?? 0.35;
  const base = focused ? emissiveBase + 0.3 : emissiveBase;
  if (material) {
    material.emissiveIntensity = base + dischargeIntensity * DISCHARGE_EMISSIVE_BOOST;
    material.emissive.set(d.red ? FAILED_DISCHARGE_COLOR : descriptor.laneHue);
  }
  // Transient scale pulse (revert to the focused/rest scale at intensity 0).
  group.scale.setScalar((focused ? FOCUS_SCALE : 1) + dischargeIntensity * DISCHARGE_SCALE);
}
