"use client";

/**
 * Energy link — one hub→atom route edge, rendered as a thin filament that
 * carries a luminous discharge when traffic is observed (OR-ATOM-003, V6).
 *
 * **At rest:** a thin, dim filament (low emissive, restrained opacity) — the
 * "route exists" signal without a thick opaque pipe. The tube radius + opacity
 * come from the frozen pure encoding (`linkTubeRadius` / `VISUAL_STATE_STYLE`
 * via {@link LinkVisualDescriptor.visualState}).
 *
 * **Observed active:** when the resolved state is `animated` (live traffic) and
 * the scene is in normal-motion mode, the filament carries a luminous flow —
 * a slow emissive pulse that reads as energy moving along the route (the 3D
 * analogue of the 2D animated dash), without per-packet shader work.
 *
 * **Transient event effects (V6):** the link reads the ambient request-lifecycle
 * {@link AtomicEventPool} for its target provider. A live request (started or
 * completed) emits a short **cool green-cyan** flare; a failed request emits a
 * short **red** flash. Each effect *decays back to zero* (the frozen
 * `computeDischarge` envelope) — there is **no permanent red** and no persistent
 * route-health change (a failed *request* is not a failed *route*).
 *
 * **Per-frame fix (V6):** in normal-motion mode the discharge is read from the
 * pool *inside* `useFrame` on the wall clock (it is a per-frame transient, not a
 * render-time value). In reduced-motion mode it is read once at render, keyed on
 * the snapshot's capture clock, so renders stay pure. No per-frame React state —
 * the material is mutated imperatively (three.js refs).
 *
 * `three` / R3F are confined to this `scene/**` subtree.
 *
 * Explicit unknowns:
 * - **Moving packets**: the link pulses/flares (emissive) rather than moving
 *   discrete packets along the tube; per-packet motion is a follow-on concern.
 * - **Curve arc height**: a fixed proportion of the chord length (bounded
 *   aesthetic choice, not an auto-fit).
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import type { AtomVisualDescriptor, LinkVisualDescriptor } from "../AtomicTopologyRenderer";
import { QUALITY_BUDGETS } from "../quality";
import { useAtomicSceneContext } from "./sceneContext";
import { linkTubeRadius } from "../visualEncoding";

/**
 * Tube segment resolution — a floor only. The live value is the scene
 * quality budget (`QUALITY_BUDGETS[quality].tubeSegments`); the floor
 * keeps a very-low budget from producing a degenerate tube.
 */
function tubeSegmentsFor(quality: "high" | "medium" | "low" | "none"): number {
  return Math.max(8, QUALITY_BUDGETS[quality].tubeSegments);
}
/** Arc factor: how far the Bézier control point bows outward from the chord midpoint. */
const ARC_FACTOR = 0.25;

/** Rest-state emissive — a thin, dim filament (V6). */
const REST_EMISSIVE = 0.18;
/** Active-route pulse amplitude (sits on top of the rest base). */
const ACTIVE_PULSE = 0.45;
/** Transient-discharge emissive boost (decays to zero — never persistent). */
const DISCHARGE_BOOST = 0.7;
/** Cool green-cyan for a started/completed request flare (V6). */
const DISCHARGE_COOL = "#2dd4bf";
/** Red for a failed-request flash (V6) — transient only, decays away. */
const DISCHARGE_RED = "#ef4444";

export function EnergyLink({
  descriptor,
  atoms,
}: {
  descriptor: LinkVisualDescriptor;
  atoms: AtomVisualDescriptor[];
}) {
  const target = atoms.find((a) => a.id === descriptor.target);

  const { pool, reducedMotion, quality, nowMs } = useAtomicSceneContext();

  // Build the tube geometry once per (target, style) — a quadratic Bézier from
  // the origin to the atom, bowing outward. The tube radius scales with the
  // resolved visual state's stroke width (frozen pure `linkTubeRadius`): an
  // idle route is a thin filament, an active one a slightly thicker discharge.
  const tubeRadius = linkTubeRadius(descriptor.visualState.style.width);
  const tubeSegments = tubeSegmentsFor(quality);
  const geometry = useMemo(() => {
    if (!target) return null;
    const end = new THREE.Vector3(target.position.x, target.position.y, target.position.z);
    const mid = end.clone().multiplyScalar(0.5);
    const radial = mid.clone().normalize();
    if (radial.lengthSq() < 1e-6) radial.set(0, 0, 1); // degenerate: use +z
    const control = mid.clone().add(radial.multiplyScalar(end.length() * ARC_FACTOR));
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), control, end);
    return new THREE.TubeGeometry(curve, tubeSegments, tubeRadius, 8, false);
  }, [target, tubeRadius, tubeSegments]);

  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const glowRef = useRef<THREE.MeshStandardMaterial | null>(null);

  const animated = descriptor.visualState.style.animated;
  const opacity = descriptor.visualState.style.opacity;
  const color = descriptor.laneHue;

  const providerId = target?.providerId;

  // Reduced-motion: a *static* transient flare read once at render, keyed on
  // the snapshot's capture clock (no wall clock during render → pure render).
  // Normal motion: the discharge is read per-frame in `useFrame` below (the
  // per-frame transient) — this render-time read is only the static fallback.
  const discharge =
    reducedMotion && pool && providerId
      ? pool.effectsFor(providerId, nowMs)
      : { intensity: 0, red: false };

  const dischargeBoost = Math.min(1, Math.max(0, discharge.intensity)) * DISCHARGE_BOOST;
  // Static (reduced-motion) emissive tint: a transient discharge tints the
  // filament (cool green-cyan on activity, red on a failed request); the
  // per-frame path below overrides it imperatively in normal-motion mode.
  const emissiveColor = discharge.red ? DISCHARGE_RED : DISCHARGE_COOL;

  // Per-frame update (normal motion only — reduced motion is static above).
  //   - Active route: a luminous flow pulse (emissive breathing).
  //   - Transient event: read the current discharge off the pool each frame on
  //     the wall clock (it decays to zero — no permanent red, no persistent
  //     state). The material color + intensity are mutated imperatively.
  useFrame((state) => {
    const material = materialRef.current;
    if (!material) return;

    const pulse =
      animated && !reducedMotion
        ? ACTIVE_PULSE * (0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 3))
        : 0;

    // Per-frame transient discharge (the V6 fix): read the live pool each frame.
    let frameBoost = 0;
    let frameRed = false;
    if (!reducedMotion && pool && providerId) {
      const d = pool.effectsFor(providerId, Date.now());
      frameBoost = Math.min(1, Math.max(0, d.intensity)) * DISCHARGE_BOOST;
      frameRed = d.red;
    }

    material.emissiveIntensity = REST_EMISSIVE + pulse + frameBoost;
    material.emissive.set(frameRed ? DISCHARGE_RED : color);

    // Endpoint glow breathes with the route (brighter when active / on a
    // discharge) so the target end reads as an energy landing.
    const glow = glowRef.current;
    if (glow) {
      glow.emissiveIntensity = REST_EMISSIVE + 0.5 + pulse + frameBoost;
      glow.emissive.set(frameRed ? DISCHARGE_RED : color);
    }
  });

  if (!geometry || !target) return null;

  return (
    <group>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          ref={materialRef}
          color={color}
          emissive={discharge.intensity > 0 ? emissiveColor : color}
          emissiveIntensity={REST_EMISSIVE + dischargeBoost}
          transparent
          opacity={opacity}
          roughness={0.3}
          metalness={0.1}
        />
      </mesh>
      {/* Endpoint glow — a small emissive sphere at the target end of the route.
          Colored by the route lane; brightens on a transient discharge (red on
          a failure) so the landing reads. */}
      <mesh position={[target.position.x, target.position.y, target.position.z]}>
        <sphereGeometry args={[tubeRadius * 1.9, 16, 16]} />
        <meshStandardMaterial
          ref={glowRef}
          color={color}
          emissive={discharge.intensity > 0 ? emissiveColor : color}
          emissiveIntensity={REST_EMISSIVE + 0.5 + dischargeBoost}
          transparent
          opacity={Math.min(1, opacity + 0.2)}
          roughness={0.3}
          metalness={0.1}
        />
      </mesh>
    </group>
  );
}
