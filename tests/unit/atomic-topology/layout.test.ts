/**
 * Atomic topology — deterministic ring layout
 * (OR-ATOM-001 v2, T006a / M3 Phase A).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeAtomicLayout,
  atomicMembershipSignature,
  RING_CAPACITIES,
  RING_RADII,
  EXTRA_RING_CAPACITY,
  EXTRA_RING_RADIUS_STEP,
} from "@/plugins/atomic-topology/layout";
import type { AtomicLayoutNode } from "@/plugins/atomic-topology/layout";

function providers(...ids: string[]): AtomicLayoutNode[] {
  return ids.map((id) => ({ id: `provider:${id}`, kind: "provider" as const }));
}

/* ------------------------------------------------------------------ */
/* Ring constants mirror the 2D layout                                 */
/* ------------------------------------------------------------------ */

test("ring capacities/radii approximate the 2D layout (8..38, 210..1010)", () => {
  assert.deepEqual([...RING_CAPACITIES], [8, 14, 20, 26, 32, 38]);
  assert.deepEqual([...RING_RADII], [210, 370, 530, 690, 850, 1010]);
  assert.equal(RING_CAPACITIES[0], 8, "inner ring holds 8, mirroring the 2D layout");
  assert.equal(
    RING_CAPACITIES[RING_CAPACITIES.length - 1],
    38,
    "outer ring holds 38, mirroring the 2D layout"
  );
  assert.equal(EXTRA_RING_CAPACITY, 6, "overflow rings add ~6, as in the 2D layout");
  assert.equal(
    EXTRA_RING_RADIUS_STEP,
    160,
    "overflow rings step radius by 160, as in the 2D layout"
  );
});

/* ------------------------------------------------------------------ */
/* Membership signature                                                */
/* ------------------------------------------------------------------ */

test("membership signature is order-independent and dedupes ids", () => {
  const base = providers("openai", "anthropic", "gemini");
  const signature = atomicMembershipSignature(base);
  assert.equal(
    atomicMembershipSignature([...base].reverse()),
    signature,
    "reordering must not change the signature"
  );
  assert.equal(
    atomicMembershipSignature([...base, base[0]]),
    signature,
    "duplicate ids must not change the signature"
  );
});

test("membership signature changes exactly when membership changes", () => {
  const sig = atomicMembershipSignature(providers("openai", "anthropic"));
  assert.equal(
    atomicMembershipSignature(providers("openai", "anthropic")),
    sig,
    "same membership → same signature"
  );
  assert.notEqual(
    atomicMembershipSignature(providers("openai", "anthropic", "gemini")),
    sig,
    "added member → new signature"
  );
  assert.notEqual(
    atomicMembershipSignature(providers("openai")),
    sig,
    "removed member → new signature"
  );
  assert.notEqual(
    atomicMembershipSignature(providers("mistral", "cohere")),
    sig,
    "different membership → new signature"
  );
});

test("membership signature ignores the hub and is empty for no providers", () => {
  assert.equal(atomicMembershipSignature([]), "");
  assert.equal(atomicMembershipSignature([{ id: "hub", kind: "hub" }]), "");
  assert.equal(
    atomicMembershipSignature([{ id: "hub", kind: "hub" }, ...providers("openai")]),
    "provider:openai"
  );
});

/* ------------------------------------------------------------------ */
/* Layout determinism                                                  */
/* ------------------------------------------------------------------ */

test("layout: same ids → identical positions across any reorder", () => {
  const ids = providers(
    "openai",
    "anthropic",
    "gemini",
    "groq",
    "mistral",
    "cohere",
    "nvidia",
    "amazon",
    "vertex",
    "openrouter"
  );
  const reference = computeAtomicLayout(ids);
  const fingerprint = (l: ReturnType<typeof computeAtomicLayout>) =>
    l.placements
      .map((p) => [p.id, p.position.x, p.position.y, p.position.z, p.ringIndex, p.angle])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  for (const shuffled of [[...ids].reverse(), ids.slice().sort()]) {
    assert.deepEqual(
      fingerprint(computeAtomicLayout(shuffled)),
      fingerprint(reference),
      "reordered input → identical placements"
    );
  }
});

/* ------------------------------------------------------------------ */
/* Slot-distributed angles (OR-ATOM-002)                               */
/* ------------------------------------------------------------------ */

/** Smallest angular gap (radians) between any two atoms on the same ring. */
function minAngularGap(layout: ReturnType<typeof computeAtomicLayout>, ring: number): number {
  const angles = layout.placements
    .filter((p) => p.ringIndex === ring)
    .map((p) => p.angle % (Math.PI * 2));
  angles.sort((a, b) => a - b);
  if (angles.length < 2) return Math.PI * 2;
  let min = Math.PI * 2;
  for (let i = 0; i < angles.length; i += 1) {
    const next = (i + 1) % angles.length;
    // wrap-around gap for the last→first pair
    const gap = next === 0 ? Math.PI * 2 - angles[i] + angles[0] : angles[next] - angles[i];
    min = Math.min(min, gap);
  }
  return min;
}

test("layout: atoms are evenly distributed per ring (equal angular separation)", () => {
  const layout = computeAtomicLayout(providers(...Array.from({ length: 8 }, (_, i) => `p${i}`)));
  assert.equal(layout.placements.length, 8);
  const gap = minAngularGap(layout, 0);
  assert.ok(
    gap >= (Math.PI * 2) / 8 - 1e-9,
    `min gap ${gap} must equal 2π/8 for a full inner ring (no crowding)`
  );
});

test("layout: adding a provider redistributes the ring evenly (no clumping)", () => {
  const base = computeAtomicLayout(providers("openai", "anthropic", "gemini"));
  const withExtra = computeAtomicLayout(providers("openai", "anthropic", "gemini", "groq"));
  assert.notEqual(base.membershipSignature, withExtra.membershipSignature);

  // 4 atoms on a ring → each must be ≥ 2π/4 apart; the hash-angle era
  // allowed three atoms to crowd within a small arc.
  assert.ok(
    minAngularGap(withExtra, 0) >= (Math.PI * 2) / 4 - 1e-9,
    "4 slots → ≥90° separation between every pair (even spread, not hash clumps)"
  );
  // All 4 atoms stay on ring 0 (capacity 8).
  assert.equal(withExtra.placements.filter((p) => p.ringIndex === 0).length, 4);
});

test("layout: slots are stable under reorder of the same set", () => {
  const ids = providers("openai", "anthropic", "gemini", "groq", "mistral", "cohere");
  const reference = computeAtomicLayout(ids);
  const shuffled = computeAtomicLayout([...ids].reverse());
  const slotOf = (l: typeof reference) => new Map(l.placements.map((p) => [p.id, p.slotIndex]));
  assert.deepEqual(
    slotOf(shuffled),
    slotOf(reference),
    "slot index depends on the id set, not array order"
  );
});

test("layout: explicit bounds radius covers the farthest atom", () => {
  const ids = providers(...Array.from({ length: 140 }, (_, i) => `p${i}`));
  const layout = computeAtomicLayout(ids, { zJitter: 18 });
  const maxAtomRadius = Math.max(
    ...layout.placements.map((p) => Math.hypot(p.position.x, p.position.z))
  );
  assert.ok(
    layout.boundsRadius >= maxAtomRadius - 1e-9,
    `bounds ${layout.boundsRadius} must cover the farthest atom (${maxAtomRadius})`
  );
  assert.equal(
    layout.boundsRadius,
    RING_RADII[5] + 160 + 18,
    "140 atoms → ring 6 radius (1010+160) + z-jitter"
  );
});

test("layout: hub is fixed at the origin", () => {
  const layout = computeAtomicLayout([{ id: "hub", kind: "hub" }, ...providers("openai")]);
  assert.deepEqual(layout.hub, { x: 0, y: 0, z: 0 });
  assert.equal(layout.placements.length, 1);
  assert.equal(layout.placements[0].id, "provider:openai");
});

test("layout: ring capacities are respected (8 inner, 14 next, ...)", () => {
  const ids = providers(...Array.from({ length: 24 }, (_, i) => `p${i}`));
  const layout = computeAtomicLayout(ids);
  assert.equal(layout.placements.length, 24);
  const byRing = new Map<number, number>();
  for (const p of layout.placements) byRing.set(p.ringIndex, (byRing.get(p.ringIndex) ?? 0) + 1);
  assert.equal(byRing.get(0), 8, "inner ring holds exactly 8");
  assert.equal(byRing.get(1), 14, "second ring holds exactly 14");
  assert.equal(byRing.get(2), 2, "remainder goes to the third ring");
  assert.equal(byRing.has(3), false, "no fourth ring needed");
});

test("layout: overflow beyond 138 nodes extends rings deterministically", () => {
  const ids = providers(...Array.from({ length: 140 }, (_, i) => `p${i}`));
  const layout = computeAtomicLayout(ids);
  assert.equal(layout.placements.length, 140);
  const maxRing = Math.max(...layout.placements.map((p) => p.ringIndex));
  assert.equal(maxRing, 6, "140 nodes need one overflow ring (138 + 2)");
  assert.equal(
    layout.placements.filter((p) => p.ringIndex === 6).length,
    2,
    "only the overflow remainder sits in ring 6"
  );
});

test("layout: geometry — ring radii, orbital tilt stacking, bounded z-jitter, angle range", () => {
  const layout = computeAtomicLayout(providers(...Array.from({ length: 12 }, (_, i) => `p${i}`)));
  for (const p of layout.placements) {
    const expectedRadius =
      p.ringIndex < RING_RADII.length
        ? RING_RADII[p.ringIndex]
        : RING_RADII[5] + (p.ringIndex - 5) * 160;
    const radius = Math.hypot(p.position.x, p.position.z);
    assert.ok(
      radius >= expectedRadius - 20 && radius <= expectedRadius + 20,
      `ring ${p.ringIndex} radius ${radius} out of [${expectedRadius - 20}, ${expectedRadius + 20}]`
    );
    assert.equal(p.position.y, p.ringIndex * 24, "orbital tilt stacks rings by 24 units");
    assert.ok(p.angle >= 0 && p.angle <= Math.PI * 2, "angle is within [0, 2π]");
  }
});

test("layout: duplicate ids are placed exactly once", () => {
  const layout = computeAtomicLayout([
    ...providers("openai"),
    { id: "provider:openai", kind: "provider" as const },
  ]);
  assert.equal(layout.placements.length, 1);
});

test("layout: radiusScale option scales positions deterministically (signature stays option-independent)", () => {
  const base = computeAtomicLayout(providers("openai", "anthropic"));
  const scaled = computeAtomicLayout(providers("openai", "anthropic"), { radiusScale: 2 });
  for (let i = 0; i < base.placements.length; i += 1) {
    assert.equal(scaled.placements[i].position.x, base.placements[i].position.x * 2);
    assert.ok(Math.abs(scaled.placements[i].position.z - base.placements[i].position.z * 2) < 1e-9);
  }
  assert.equal(base.membershipSignature, scaled.membershipSignature);
});

/* ------------------------------------------------------------------ */
/* Complementary pins: exact separator, boundary overflow, axis map      */
/* ------------------------------------------------------------------ */

test("signature: mixed kinds sort together with a NUL separator; hub-only → empty", () => {
  assert.equal(
    atomicMembershipSignature([
      { id: "hub", kind: "hub" },
      { id: "gpu:x", kind: "gpu" },
      { id: "provider:a", kind: "provider" },
      { id: "provider:b", kind: "provider" },
    ]),
    "gpu:x\u0000provider:a\u0000provider:b",
    "non-hub ids of every kind are sorted and joined with the separator"
  );
  assert.equal(atomicMembershipSignature([{ id: "hub", kind: "hub" }]), "");
});

test("layout: identical membership → identical layout across input orderings", () => {
  const ids = ["openai", "anthropic", "gemini", "mistral"];
  const nodes = ids.map((id) => ({ id: `provider:${id}`, kind: "provider" as const }));
  const first = computeAtomicLayout(nodes, { zJitter: 0 });
  const second = computeAtomicLayout([...nodes].reverse(), { zJitter: 0 });
  assert.deepEqual(second.placements, first.placements, "reordering the input never moves an atom");
  assert.equal(second.membershipSignature, first.membershipSignature);
});

test("layout: gpu atoms are ring-placed exactly like provider atoms", () => {
  const layout = computeAtomicLayout(
    [
      { id: "gpu:0", kind: "gpu" },
      { id: "provider:a", kind: "provider" },
    ],
    { zJitter: 0 }
  );
  assert.equal(layout.placements.length, 2);
  const gpu = layout.placements.find((p) => p.id === "gpu:0");
  assert.ok(gpu, "gpu atoms get a placement");
  assert.equal(gpu.kind, "gpu");
  // Two atoms fit in ring 0; the radius is the canonical ring 0 radius at zero jitter.
  assert.equal(gpu.ringIndex, 0);
  assert.ok(Math.abs(Math.hypot(gpu.position.x, gpu.position.z) - RING_RADII[0]) < 1e-9);
});

test("layout: overflow boundary — ring 6 opens at the 139th node, then grows by the extra capacity", () => {
  const perRing = (n: number) => {
    const ids = Array.from({ length: n }, (_, i) => `provider:p${i}`);
    const layout = computeAtomicLayout(
      ids.map((id) => ({ id, kind: "provider" as const })),
      { zJitter: 0 }
    );
    const counts: Record<number, number> = {};
    for (const p of layout.placements) counts[p.ringIndex] = (counts[p.ringIndex] ?? 0) + 1;
    return counts;
  };
  assert.deepEqual(
    perRing(138),
    { 0: 8, 1: 14, 2: 20, 3: 26, 4: 32, 5: 38 },
    "138 fills the six canonical rings exactly"
  );
  assert.deepEqual(
    perRing(139),
    { 0: 8, 1: 14, 2: 20, 3: 26, 4: 32, 5: 38, 6: 1 },
    "the 139th node opens ring 6"
  );
  assert.deepEqual(
    perRing(146),
    { 0: 8, 1: 14, 2: 20, 3: 26, 4: 32, 5: 38, 6: 8 },
    "ring 6 grows past the extra capacity"
  );
  assert.deepEqual(
    perRing(182),
    { 0: 8, 1: 14, 2: 20, 3: 26, 4: 32, 5: 38, 6: 44 },
    "ring 6 holds up to its cumulative capacity"
  );
  assert.equal(perRing(183)[7], 1, "the 183rd node opens ring 7");
});

test("layout: overflow rings step radius by the extra step and tilt by the tilt step", () => {
  const ids = Array.from({ length: 183 }, (_, i) => `provider:p${i}`);
  const layout = computeAtomicLayout(
    ids.map((id) => ({ id, kind: "provider" as const })),
    { zJitter: 0 }
  );
  const ring6 = layout.placements.filter((p) => p.ringIndex === 6);
  const ring7 = layout.placements.filter((p) => p.ringIndex === 7);
  assert.ok(ring6.length > 0 && ring7.length > 0);
  // ring 6 = 1010 + 160, ring 7 = 1010 + 2×160; y stacks by the default tilt step (24).
  assert.ok(Math.abs(Math.hypot(ring6[0].position.x, ring6[0].position.z) - 1170) < 1e-9);
  assert.equal(ring6[0].position.y, 144);
  assert.ok(Math.abs(Math.hypot(ring7[0].position.x, ring7[0].position.z) - 1330) < 1e-9);
  assert.equal(ring7[0].position.y, 168);
});

test("layout: exact axis map — x = r·cos(θ), z = r·sin(θ) at zero jitter (ring 0 radius 210)", () => {
  const layout = computeAtomicLayout(
    Array.from({ length: 12 }, (_, i) => ({ id: `provider:p${i}`, kind: "provider" as const })),
    { zJitter: 0 }
  );
  for (const p of layout.placements) {
    const radius = RING_RADII[p.ringIndex];
    assert.ok(
      Math.abs(p.position.x - radius * Math.cos(p.angle)) < 1e-9,
      "x follows the hashed angle"
    );
    assert.ok(
      Math.abs(p.position.z - radius * Math.sin(p.angle)) < 1e-9,
      "z follows the hashed angle"
    );
    assert.ok(
      Math.abs(p.position.y - p.ringIndex * 24) < 1e-9,
      "y stacks by the default tilt step"
    );
  }
  const ring0 = layout.placements.filter((p) => p.ringIndex === 0);
  assert.ok(ring0.every((p) => Math.abs(Math.hypot(p.position.x, p.position.z) - 210) < 1e-9));
});

test("layout: z-jitter perturbs ONLY the z axis, bounded by ±zJitter", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `provider:p${i}`);
  const nodes = ids.map((id) => ({ id, kind: "provider" as const }));
  const without = computeAtomicLayout(nodes, { zJitter: 0 });
  const withJitter = computeAtomicLayout(nodes, { zJitter: 18 });
  for (const p of without.placements) {
    const q = withJitter.placements.find((r) => r.id === p.id);
    assert.ok(Math.abs(p.position.x - q.position.x) < 1e-9, "x is never jittered");
    assert.ok(Math.abs(p.position.y - q.position.y) < 1e-9, "y is never jittered");
    assert.ok(Math.abs(p.position.z - q.position.z) <= 18 + 1e-9, "|Δz| is bounded by the jitter");
  }
});

test("layout: custom ringTiltStep rescales the y stack; 0 flattens it", () => {
  const ids = Array.from({ length: 24 }, (_, i) => `provider:p${i}`);
  const nodes = ids.map((id) => ({ id, kind: "provider" as const }));
  const flat = computeAtomicLayout(nodes, { ringTiltStep: 0, zJitter: 0 });
  assert.ok(
    flat.placements.every((p) => p.position.y === 0),
    "tilt 0 → a flat plane"
  );
  const steep = computeAtomicLayout(nodes, { ringTiltStep: 40, zJitter: 0 });
  for (const p of steep.placements) {
    assert.equal(p.position.y, p.ringIndex * 40, "y = ringIndex × ringTiltStep");
  }
});

test("layout: empty input → hub at the origin, no placements, empty signature", () => {
  const layout = computeAtomicLayout([]);
  assert.deepEqual(layout.hub, { x: 0, y: 0, z: 0 });
  assert.deepEqual(layout.placements, []);
  assert.equal(layout.membershipSignature, "");
});
