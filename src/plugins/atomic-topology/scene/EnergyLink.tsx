"use client";

/**
 * Energy link — one hub→atom route edge, rendered as a curved "energy flow"
 * (OR-ATOM-001 v2, M3 Phase B).
 *
 * The link is a tube following a quadratic Bézier from the nucleus (origin) to
 * the atom's deterministic layout position. The curve arcs *outward* from the
 * origin so the route reads as an orbital path rather than a straight spoke.
 *
 * The tube's width/opacity come from the resolved visual state
 * (`VISUAL_STATE_STYLE` via {@link LinkVisualDescriptor.visualState}); an
 * "active" route animates a pulsing emissive (the "energy flowing" signal) —
 * the 3D analogue of the 2D `edgeStyles` animated dash, done without
 * `three`-level shader work.
 *
 * `three` / R3F are confined to this `scene/**` subtree.
 *
 * Explicit unknowns:
 * - **Moving "packets"**: the link pulses (emissive) rather than moving discrete
 *   packets along the tube; per-packet motion is a M4 concern (event pool).
 * - **Curve arc height**: the arc is a fixed proportion of the chord length —
 *   a bounded aesthetic choice, not an auto-fit.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import type { AtomVisualDescriptor, LinkVisualDescriptor } from "../AtomicTopologyRenderer";
import { useAtomicSceneContext } from "./sceneContext";
import { linkTubeRadius } from "../visualEncoding";

/** Tube segment resolution (smoothness). */
const TUBE_SEGMENTS = 24;
/** Arc factor: how far the Bézier control point bows outward from the chord midpoint. */
const ARC_FACTOR = 0.25;

export function EnergyLink({
  descriptor,
  atoms,
}: {
  descriptor: LinkVisualDescriptor;
  atoms: AtomVisualDescriptor[];
}) {
  const target = atoms.find((a) => a.id === descriptor.target);

  // Build the tube geometry once per (target, style) — a quadratic Bézier from
  // the origin to the atom, bowing outward. The tube radius scales with the
  // resolved visual state's stroke width (OR-ATOM-002, V4): an idle route is a
  // thin filament, an active one a thicker discharge (pure `linkTubeRadius`).
  const tubeRadius = linkTubeRadius(descriptor.visualState.style.width);
  const geometry = useMemo(() => {
    if (!target) return null;
    const end = new THREE.Vector3(target.position.x, target.position.y, target.position.z);
    // Control point at the midpoint, pushed radially outward for an arc.
    const mid = end.clone().multiplyScalar(0.5);
    const radial = mid.clone().normalize();
    if (radial.lengthSq() < 1e-6) radial.set(0, 0, 1); // degenerate: use +z
    const control = mid.clone().add(radial.multiplyScalar(end.length() * ARC_FACTOR));
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), control, end);
    return new THREE.TubeGeometry(curve, TUBE_SEGMENTS, tubeRadius, 8, false);
  }, [target, tubeRadius]);

  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const glowRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const animated = descriptor.visualState.style.animated;
  const baseEmissive = animated ? 0.6 : 0.25;
  const opacity = descriptor.visualState.style.opacity;
  const color = descriptor.laneHue;
  const { pool, reducedMotion, nowMs } = useAtomicSceneContext();

  // M4/M6 — transient per-provider discharge flare (OR-ATOM-001 v2). The link
  // flares brighter for its provider's live request-lifecycle events (a
  // completed/started request brightens the route; a failed one tints it red),
  // then decays back to the steady base. It is a *transient* emphasis read off
  // the ambient event pool — it never changes the route's persistent visual
  // state, so a failed request is not read as a failed provider route.
  const providerId = target?.providerId;
  // Reduced-motion static flare: a pure read of the pool keyed on the
  // snapshot's capture clock (no wall clock during render). Animated mode
  // flares per-frame on the wall clock inside the `useFrame` block below.
  const discharge =
    reducedMotion && pool && providerId
      ? pool.effectsFor(providerId, nowMs)
      : { intensity: 0, red: false };
  const dischargeBoost = Math.min(1, Math.max(0, discharge.intensity)) * 0.5;
  const emissiveColor = discharge.red ? "#ef4444" : color;

  // Pulse the emissive for animated (active) links, and flare the link on a
  // transient per-provider discharge (read from the pool each frame — the
  // flare decays back to the base, so no persistent health change).
  useFrame((state) => {
    const material = materialRef.current;
    if (!material) return;
    // The discharge flare is the floor; the active-route pulse sits on top.
    const pulse = animated && !reducedMotion ? 0.4 * (0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 3)) : 0;
    material.emissiveIntensity = baseEmissive + dischargeBoost + pulse;
    // The endpoint glow breathes with the route (brighter when active / on a
    // discharge) so the target end of the route reads as an energy landing.
    const glow = glowRef.current;
    if (glow) glow.emissiveIntensity = 0.6 + dischargeBoost + pulse;
  });

  if (!geometry || !target) return null;

  return (
    <group>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          ref={materialRef}
          color={color}
          emissive={emissiveColor}
          emissiveIntensity={baseEmissive + dischargeBoost}
          transparent
          opacity={opacity}
          roughness={0.3}
          metalness={0.1}
        />
      </mesh>
      {/* Endpoint glow — a small emissive sphere at the target end of the
          route (OR-ATOM-002, V4). Colored by the route lane; brightens on a
          transient discharge (red on a failure) so the landing reads. */}
      <mesh position={[target.position.x, target.position.y, target.position.z]}>
        <sphereGeometry args={[tubeRadius * 1.9, 16, 16]} />
        <meshStandardMaterial
          ref={glowRef}
          color={color}
          emissive={emissiveColor}
          emissiveIntensity={0.6 + dischargeBoost}
          transparent
          opacity={Math.min(1, opacity + 0.2)}
          roughness={0.3}
          metalness={0.1}
        />
      </mesh>
    </group>
  );
}
