/**
 * Deterministic ring layout for the Atomic topology renderer
 * (OR-ATOM-001 v2, T006a / M3 Phase A).
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
 */

/** Canonical node shapes the layout consumes (a subset of `TopologySceneNode`). */
export interface AtomicLayoutNode {
  /** Canonical atom id (`hub`, `provider:<id>`, `gpu:<id>` — see layoutIdentity). */
  id: string;
  /** Atom kind; only `hub` is treated specially, everything else is ring-placed. */
  kind: "hub" | "provider" | "gpu";
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
  /** Stable angle (radians, [0, 2π)) around the ring — keyed to the node id. */
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

/** Stable angle for a node id: full [0, 2π) spread, order-independent. */
function angleForId(id: string): number {
  const twoPi = Math.PI * 2;
  return (fnv1a(id) / 0xffffffff) * twoPi;
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
 * Compute the deterministic ring layout for a set of atoms.
 *
 * Determinism contract:
 * - The hub is fixed at the origin.
 * - Non-hub atoms are assigned to rings in `fnv1a(id)` order (ties broken by
 *   id string), so ring membership and slot are functions of the id set alone.
 * - Each atom's angle is `fnv1a(id)`-keyed, so reordering the input array (or
 *   the snapshot) never moves an atom.
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

  const placements: AtomicLayoutPlacement[] = [];
  let ringIndex = 0;
  let slotInRing = 0;
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) continue;
    const radius = radiusAt(ringIndex) * radiusScale;
    const angle = angleForId(id);
    const x = radius * Math.cos(angle);
    const zBase = radius * Math.sin(angle);
    // Deterministic ± jitter (bit 31 of the id hash); scaled with the radius
    // so `radiusScale` scales the whole geometry uniformly.
    const jitterSign = ((fnv1a(id) >>> 31) & 1) === 0 ? 1 : -1;
    const z = zBase + jitterSign * zJitter * radiusScale;
    const y = ringIndex * ringTiltStep;
    placements.push({
      id,
      kind: node.kind === "gpu" ? "gpu" : "provider",
      ringIndex,
      angle,
      position: { x, y, z },
    });
    slotInRing += 1;
    if (slotInRing >= capacityAt(ringIndex)) {
      ringIndex += 1;
      slotInRing = 0;
    }
  }

  return {
    hub: { x: 0, y: 0, z: 0 },
    placements,
    membershipSignature: atomicMembershipSignature(nodes),
  };
}
