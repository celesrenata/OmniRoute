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

test("layout: adding a provider does not move existing providers (angles are id-keyed)", () => {
  const base = computeAtomicLayout(providers("openai", "anthropic", "gemini"));
  const withExtra = computeAtomicLayout(providers("openai", "anthropic", "gemini", "groq"));
  assert.notEqual(base.membershipSignature, withExtra.membershipSignature);

  const basePos = new Map(base.placements.map((p) => [p.id, p.position]));
  for (const p of withExtra.placements) {
    if (p.id === "provider:groq") continue;
    assert.deepEqual(
      basePos.get(p.id),
      p.position,
      `existing provider ${p.id} must not move when membership grows`
    );
  }
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
