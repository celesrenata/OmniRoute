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

/** Base tube radius (world units) for a link. */
const LINK_RADIUS = 6;
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
  // the origin to the atom, bowing outward.
  const geometry = useMemo(() => {
    if (!target) return null;
    const end = new THREE.Vector3(target.position.x, target.position.y, target.position.z);
    // Control point at the midpoint, pushed radially outward for an arc.
    const mid = end.clone().multiplyScalar(0.5);
    const radial = mid.clone().normalize();
    if (radial.lengthSq() < 1e-6) radial.set(0, 0, 1); // degenerate: use +z
    const control = mid.clone().add(radial.multiplyScalar(end.length() * ARC_FACTOR));
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), control, end);
    return new THREE.TubeGeometry(curve, TUBE_SEGMENTS, LINK_RADIUS, 8, false);
  }, [target]);

  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const animated = descriptor.visualState.style.animated;
  const baseEmissive = animated ? 0.6 : 0.25;
  const opacity = descriptor.visualState.style.opacity;
  const color = descriptor.laneHue;

  // Pulse the emissive for animated (active) links.
  useFrame((state) => {
    if (!animated) return;
    const material = materialRef.current;
    if (!material) return;
    material.emissiveIntensity =
      baseEmissive + 0.4 * (0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 3));
  });

  if (!geometry) return null;

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        ref={materialRef}
        color={color}
        emissive={color}
        emissiveIntensity={baseEmissive}
        transparent
        opacity={opacity}
        roughness={0.3}
        metalness={0.1}
      />
    </mesh>
  );
}
