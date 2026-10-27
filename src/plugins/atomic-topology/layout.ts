/**
 * Deterministic ring layout for the Atomic topology renderer
 * (OR-ATOM-002 — slot-distributed geometry rescue).
 *
 * Pure TS: no `three`, no DOM, no clock. The 3D scene (Phase B) places atoms at
 * the positions this module computes. Everything is keyed to the *set* of
 * canonical atom ids — never to array order — so reordering the snapshot never
 * moves an atom, and the host re-lays out only when the membership signature
 * changes (see {@link atomicMembershipSignature}).
 *
 * Geometry mirrors the built-in 2D layout (`ProviderTopology2D` RINGS,
 * capacities 8..38, radius step 160): each ring holds the same capacity and
 * grows the same way, but in 3D the rings are stacked with a vertical orbital
 * tilt and per-node z-jitter so two atoms with close angles never overlap.
 *
 * **Slot-distributed angles (OR-ATOM-002):** Each ring's atoms are evenly
 * distributed around the ring by slot index (0-based position / total count
 * in that ring), not by raw hash. This guarantees:
 *   - Equal angular separation within a ring (no clumping/crowding).
 *   - Stable under *reorder* of the same id set (hash-sort order is unchanged).
 *   - Deterministic phase offset per ring so rings don't align visually.
 *
 * The hash is still used for (a) stable ring-assignment order, (b) z-jitter
 * sign, and (c) the per-ring phase offset — but never for the primary angle.
 */

/** Canonical node shapes the layout consumes (a subset of `TopologySceneNode`). */
export interface AtomicLayoutNode {
  /** Canonical atom id (`hub`, `provider:<id>`, `gpu:<id>` — see layoutIdentity). */
  id: string;
  /** Atom kind; only `hub` is treated specially, everything else is ring-placed. */
  kind: "hub" | "provider" | "gpu";
}

/**
 * A device atom placed in the outer telemetry band (OR-ATOM-005 — T5.4).
 *
 * Device atoms are proven-identity fleet nodes — GPU / inference-runtime
 * devices from the fleet-telemetry reconciliation — and are laid out
 * **outside** every provider ring so no provider atom ever moves.
 */
export interface DeviceBandNode {
  /**
   * Canonical device id — `gpu:<host>:<uuid>` or `runtime:<host>:<id>`
   * (see `buildCanonicalResourceId` in `shared/topology/telemetry`).
   */
  id: string;
  /** Device atom kind. */
  kind: "gpu" | "runtime";
}

/**
 * Geometry for the device band. The band occupies whole outer rings starting
 * at `startRingIndex` — normally `maxProviderRing + 1` — reusing the exact
 * ring math of {@link computeAtomicLayout} (capacities, radii, phase offset,
 * z-jitter) so device rings are geometrically consistent with provider rings.
 */
export interface DeviceBandLayoutOptions {
  /**
   * 0-based ring index where the device band starts. Must be >= 0. Typically
   * one past the highest ring used by the provider layout, guaranteeing that
   * device atoms never share a ring with provider atoms.
   */
  startRingIndex: number;
  /** Uniform scale applied to ring radii (default 1). */
  radiusScale?: number;
  /** Vertical world units added per ring — the orbital tilt (default 24). */
  ringTiltStep?: number;
  /** Max per-node z-offset used to break angle collisions (default 18). */
  zJitter?: number;
}

/** One placed device atom (no hub — devices never sit at the origin). */
export interface DeviceBandPlacement {
  id: string;
  kind: "gpu" | "runtime";
  /** 0-based ring index (>= `startRingIndex`). */
  ringIndex: number;
  /** 0-based slot index within the ring (stable under reorder of same set). */
  slotIndex: number;
  /** Stable angle (radians, [0, 2π)) around the ring — slot-distributed. */
  angle: number;
  /** World-space position. */
  position: { x: number; y: number; z: number };
}

/** Full device-band layout result (empty input → empty placements). */
export interface DeviceBandLayout {
  placements: DeviceBandPlacement[];
  /** Highest ring index used, or -1 when the band is empty. */
  maxRingUsed: number;
  /**
   * Farthest device-atom centerline distance from the origin
   * (max band-ring radius × radiusScale + zJitter × radiusScale); 0 when empty.
   */
  boundsRadius: number;
}

/** Tunable geometry. All values are world units; defaults mirror the 2D rings. */
export interface AtomicLayoutOptions {
  /** Uniform scale applied to ring radii (default 1). */
  radiusScale?: number;
  /** Vertical world units added per ring — the orbital tilt (default 24). */
  ringTiltStep?: number;
  /** Max per-node z-offset used to break angle collisions (default 18). */
  zJitter?: number;
}

/** One placed atom (the hub is always at the origin and reported separately). */
export interface AtomicLayoutPlacement {
  id: string;
  kind: "provider" | "gpu";
  /** 0-based ring index. */
  ringIndex: number;
  /** 0-based slot index within the ring (stable under reorder of same set). */
  slotIndex: number;
  /** Stable angle (radians, [0, 2π)) around the ring — slot-distributed. */
  angle: number;
  /** World-space position. */
  position: { x: number; y: number; z: number };
}

/** Full layout result. `hub` is always the origin. */
export interface AtomicLayout {
  hub: { x: number; y: number; z: number };
  placements: AtomicLayoutPlacement[];
  /**
   * Canonical membership signature (sorted non-hub ids). Compare against the
   * previous layout's signature to decide whether a re-layout is needed.
   */
  membershipSignature: string;
  /**
   * Explicit bounding radius: the farthest atom centerline distance from the
   * origin (max ring radius × radiusScale + zJitter×radiusScale). The camera
   * fit uses this to guarantee all atoms are in-frame without probing
   * placements individually.
   */
  boundsRadius: number;
}

/** Ring capacities — mirrors the 2D layout (`RINGS` in `ProviderTopology2D`). */
export const RING_CAPACITIES = [8, 14, 20, 26, 32, 38] as const;
/** Ring radii (world units) — mirrors the 2D `RINGS` `rx` values. */
export const RING_RADII = [210, 370, 530, 690, 850, 1010] as const;
/** Capacity added by each overflow ring beyond the sixth (2D adds ~6). */
export const EXTRA_RING_CAPACITY = 6;
/** Radius added by each overflow ring beyond the sixth (2D steps by 160). */
export const EXTRA_RING_RADIUS_STEP = 160;

/**
 * Membership signature: sorted, de-duplicated non-hub ids joined by `\u0000`.
 * Empty membership → `""`. Two snapshots with the same signature must share
 * the same layout (modulo options), so the host can skip re-layout otherwise.
 */
export function atomicMembershipSignature(nodes: readonly AtomicLayoutNode[]): string {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.id !== "hub") ids.add(node.id);
  }
  return [...ids].sort().join("\u0000");
}

/** 32-bit FNV-1a — same hash as `visualEncoding.modelColor` (stable, pure). */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Ring capacity for index `r` (the six canonical rings, then +6 per ring). */
function capacityAt(ringIndex: number): number {
  if (ringIndex < RING_CAPACITIES.length) return RING_CAPACITIES[ringIndex];
  return (
    RING_CAPACITIES[RING_CAPACITIES.length - 1] +
    (ringIndex - RING_CAPACITIES.length + 1) * EXTRA_RING_CAPACITY
  );
}

/** Ring radius (unscaled) for index `r` (the six canonical rings, then +160). */
function radiusAt(ringIndex: number): number {
  if (ringIndex < RING_RADII.length) return RING_RADII[ringIndex];
  return (
    RING_RADII[RING_RADII.length - 1] + (ringIndex - RING_RADII.length + 1) * EXTRA_RING_RADIUS_STEP
  );
}

/**
 * Deterministic per-ring phase offset (radians) derived from the ring index.
 * Uses a golden-ratio-like irrational to ensure no two rings have aligned slots.
 * Pure function of the ring index — no randomness.
 */
function ringPhaseOffset(ringIndex: number): number {
  // Golden angle (~2.399 rad) × ring index, wrapped to [0, 2π).
  const goldenAngle = 2.399963229728653; // 2π(1 - 1/φ)
  return (ringIndex * goldenAngle) % (Math.PI * 2);
}

/**
 * Compute the deterministic ring layout for a set of atoms.
 *
 * Determinism contract:
 * - The hub is fixed at the origin.
 * - Non-hub atoms are assigned to rings in `fnv1a(id)` order (ties broken by
 *   id string), so ring membership and slot are functions of the id set alone.
 * - Each atom's angle is **slot-distributed**: `slotIndex / ringCount × 2π +
 *   ringPhaseOffset(ringIndex)`, giving equal angular separation within a ring.
 *   Reordering the input array never moves an atom; *adding* an atom to a
 *   ring redistributes all slots in that ring (the ring's visual balance is
 *   preserved — no clumping).
 * - Rings are stacked by `ringTiltStep` in y; each atom gets a deterministic
 *   ±`zJitter` offset (hash-bit keyed) so near-coincident angles do not
 *   overlap.
 *
 * @param nodes  atom list (any order, duplicates tolerated — de-duplicated).
 * @param options geometry tunables (all optional; see {@link AtomicLayoutOptions}).
 */
export function computeAtomicLayout(
  nodes: readonly AtomicLayoutNode[],
  options: AtomicLayoutOptions = {}
): AtomicLayout {
  const radiusScale = options.radiusScale ?? 1;
  const ringTiltStep = options.ringTiltStep ?? 24;
  const zJitter = options.zJitter ?? 18;

  // De-duplicate by id; drop the hub (it is always the origin).
  const byId = new Map<string, AtomicLayoutNode>();
  for (const node of nodes) {
    if (node.id === "hub") continue;
    if (!byId.has(node.id)) byId.set(node.id, node);
  }
  const ids = [...byId.keys()];
  // Hash order (tie-break by id) makes ring assignment order-independent.
  ids.sort((a, b) => {
    const ha = fnv1a(a);
    const hb = fnv1a(b);
    return ha !== hb ? ha - hb : a < b ? -1 : a > b ? 1 : 0;
  });

  // Pass 1: assign ring indices and count per ring.
  const ringOf = new Map<string, number>();
  const ringCounts = new Map<number, number>();
  let ringIndex = 0;
  let slotInRing = 0;
  for (const id of ids) {
    ringOf.set(id, ringIndex);
    ringCounts.set(ringIndex, (ringCounts.get(ringIndex) ?? 0) + 1);
    slotInRing += 1;
    if (slotInRing >= capacityAt(ringIndex)) {
      ringIndex += 1;
      slotInRing = 0;
    }
  }

  // Pass 2: compute slot-distributed positions.
  const placements: AtomicLayoutPlacement[] = [];
  const slotCounter = new Map<number, number>();
  let maxRingUsed = -1;
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) continue;
    const r = ringOf.get(id)!;
    maxRingUsed = Math.max(maxRingUsed, r);
    const countInRing = ringCounts.get(r)!;
    const slot = slotCounter.get(r) ?? 0;
    slotCounter.set(r, slot + 1);

    const radius = radiusAt(r) * radiusScale;
    // Slot-distributed angle: even spread around the ring + per-ring phase.
    const angle = ((slot / countInRing) * Math.PI * 2 + ringPhaseOffset(r)) % (Math.PI * 2);
    const x = radius * Math.cos(angle);
    const zBase = radius * Math.sin(angle);
    // Deterministic ± jitter (bit 31 of the id hash); scaled with the radius
    // so `radiusScale` scales the whole geometry uniformly.
    const jitterSign = ((fnv1a(id) >>> 31) & 1) === 0 ? 1 : -1;
    const z = zBase + jitterSign * zJitter * radiusScale;
    const y = r * ringTiltStep;

    placements.push({
      id,
      kind: node.kind === "gpu" ? "gpu" : "provider",
      ringIndex: r,
      slotIndex: slot,
      angle,
      position: { x, y, z },
    });
  }

  // Explicit bounds: farthest ring radius (scaled) + max z-jitter. Using the
  // highest ring index actually used (not `ringIndex - 1`, which is off by
  // one when the final canonical ring fills exactly).
  const maxRadius =
    maxRingUsed === -1 ? 0 : radiusAt(maxRingUsed) * radiusScale + zJitter * radiusScale;

  return {
    hub: { x: 0, y: 0, z: 0 },
    placements,
    membershipSignature: atomicMembershipSignature(nodes),
    boundsRadius: maxRadius,
  };
}

/**
 * Compute the deterministic ring layout for the outer **device band**
 * (OR-ATOM-005 — T5.4).
 *
 * Device atoms (proven-identity GPU / inference-runtime nodes from the
 * fleet-telemetry reconciliation) are placed in whole rings starting at
 * `startRingIndex` — normally one past the highest provider ring — so the
 * device band never overlaps a provider ring and no provider atom moves.
 *
 * The band reuses the exact ring math of {@link computeAtomicLayout}:
 * same `capacityAt` / `radiusAt` / `ringPhaseOffset` / `fnv1a` determinism
 * contract, slot-distributed angles, per-node z-jitter, per-ring y tilt.
 *
 * Determinism contract (mirrors `computeAtomicLayout`):
 * - Device atoms are assigned to band rings in `fnv1a(id)` order (ties broken
 *   by id string), so ring membership and slot are functions of the id set
 *   alone — never of array order.
 * - Each atom's angle is **slot-distributed**: `slotIndex / ringCount × 2π +
 *   ringPhaseOffset(ringIndex)`.
 * - Rings are stacked by `ringTiltStep` in y; each atom gets a deterministic
 *   ±`zJitter` offset (hash-bit keyed), scaled with `radiusScale`.
 *
 * @param devices  device atom list (any order, duplicates tolerated — de-duplicated).
 * @param options  band geometry (`startRingIndex` required; other tunables optional).
 */
export function computeDeviceBandLayout(
  devices: readonly DeviceBandNode[],
  options: DeviceBandLayoutOptions
): DeviceBandLayout {
  const radiusScale = options.radiusScale ?? 1;
  const ringTiltStep = options.ringTiltStep ?? 24;
  const zJitter = options.zJitter ?? 18;
  const startRingIndex = Math.max(0, options.startRingIndex);

  // De-duplicate by id.
  const byId = new Map<string, DeviceBandNode>();
  for (const device of devices) {
    if (!byId.has(device.id)) byId.set(device.id, device);
  }
  const ids = [...byId.keys()];
  // Hash order (tie-break by id) makes ring assignment order-independent.
  ids.sort((a, b) => {
    const ha = fnv1a(a);
    const hb = fnv1a(b);
    return ha !== hb ? ha - hb : a < b ? -1 : a > b ? 1 : 0;
  });

  // Pass 1: assign ring indices (starting at `startRingIndex`) and count per ring.
  const ringOf = new Map<string, number>();
  const ringCounts = new Map<number, number>();
  let ringIndex = startRingIndex;
  let slotInRing = 0;
  for (const id of ids) {
    ringOf.set(id, ringIndex);
    ringCounts.set(ringIndex, (ringCounts.get(ringIndex) ?? 0) + 1);
    slotInRing += 1;
    if (slotInRing >= capacityAt(ringIndex)) {
      ringIndex += 1;
      slotInRing = 0;
    }
  }

  // Pass 2: compute slot-distributed positions.
  const placements: DeviceBandPlacement[] = [];
  const slotCounter = new Map<number, number>();
  let maxRingUsed = -1;
  for (const id of ids) {
    const device = byId.get(id);
    if (!device) continue;
    const r = ringOf.get(id)!;
    maxRingUsed = Math.max(maxRingUsed, r);
    const countInRing = ringCounts.get(r)!;
    const slot = slotCounter.get(r) ?? 0;
    slotCounter.set(r, slot + 1);

    const radius = radiusAt(r) * radiusScale;
    // Slot-distributed angle: even spread around the ring + per-ring phase.
    const angle = ((slot / countInRing) * Math.PI * 2 + ringPhaseOffset(r)) % (Math.PI * 2);
    const x = radius * Math.cos(angle);
    const zBase = radius * Math.sin(angle);
    // Deterministic ± jitter (bit 31 of the id hash); scaled with the radius
    // so `radiusScale` scales the whole geometry uniformly.
    const jitterSign = ((fnv1a(id) >>> 31) & 1) === 0 ? 1 : -1;
    const z = zBase + jitterSign * zJitter * radiusScale;
    const y = r * ringTiltStep;

    placements.push({
      id,
      kind: device.kind,
      ringIndex: r,
      slotIndex: slot,
      angle,
      position: { x, y, z },
    });
  }

  // Bounds: farthest band ring radius (scaled) + max z-jitter; 0 when empty.
  const boundsRadius =
    maxRingUsed === -1 ? 0 : radiusAt(maxRingUsed) * radiusScale + zJitter * radiusScale;

  return { placements, maxRingUsed, boundsRadius };
}
