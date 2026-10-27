/**
 * Atomic topology — outer device-band layout (OR-ATOM-005 — T5.4).
 *
 * Covers `computeDeviceBandLayout`:
 *   - devices placed at `startRingIndex` and beyond (never on ring 0 by default);
 *   - same ring math as `computeAtomicLayout` (capacityAt / radiusAt / ringPhaseOffset);
 *   - determinism (reorder → same placements);
 *   - z-jitter bounded by zJitter × radiusScale;
 *   - radiusScale scales all coordinates uniformly;
 *   - ringTiltStep rescales y;
 *   - empty input → empty placements, maxRingUsed -1, boundsRadius 0;
 *   - overflow: devices beyond capacity spill to subsequent rings.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeDeviceBandLayout,
  computeAtomicLayout,
  RING_RADII,
} from "@/plugins/atomic-topology/layout";
import type { DeviceBandNode } from "@/plugins/atomic-topology/layout";

function gpus(...ids: string[]): DeviceBandNode[] {
  return ids.map((id) => ({ id: `gpu:host:${id}`, kind: "gpu" as const }));
}

function runtimes(...ids: string[]): DeviceBandNode[] {
  return ids.map((id) => ({ id: `runtime:host:${id}`, kind: "runtime" as const }));
}

/* ------------------------------------------------------------------ */
/* Determinism                                                        */
/* ------------------------------------------------------------------ */

test("device band: same device set → identical placements regardless of input order", () => {
  const devices = [...gpus("uuid-a", "uuid-b", "uuid-c"), ...runtimes("rt-1", "rt-2")];
  const reference = computeDeviceBandLayout(devices, { startRingIndex: 1 });
  const fingerprint = (l: ReturnType<typeof computeDeviceBandLayout>) =>
    l.placements
      .map((p) => [p.id, p.position.x, p.position.y, p.position.z, p.ringIndex, p.angle])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  for (const shuffled of [[...devices].reverse(), devices.slice().sort()]) {
    assert.deepEqual(
      fingerprint(computeDeviceBandLayout(shuffled, { startRingIndex: 1 })),
      fingerprint(reference),
      "reordered device input → identical band placements"
    );
  }
});

test("device band: de-duplicates by id", () => {
  const devices = [...gpus("uuid-a"), { id: "gpu:host:uuid-a", kind: "gpu" as const }];
  const layout = computeDeviceBandLayout(devices, { startRingIndex: 0 });
  assert.equal(layout.placements.length, 1, "duplicate id appears once");
});

/* ------------------------------------------------------------------ */
/* Ring index offset                                                  */
/* ------------------------------------------------------------------ */

test("device band: startRingIndex=0 → devices on ring 0", () => {
  const layout = computeDeviceBandLayout(gpus("a", "b"), { startRingIndex: 0 });
  assert.ok(
    layout.placements.every((p) => p.ringIndex === 0),
    "few devices fit on ring 0"
  );
});

test("device band: startRingIndex=3 → devices start at ring 3, radiusAt(3)", () => {
  const layout = computeDeviceBandLayout(gpus("a", "b", "c"), { startRingIndex: 3 });
  assert.ok(
    layout.placements.every((p) => p.ringIndex === 3),
    "all three devices on ring 3"
  );
  // radiusAt(3) = RING_RADII[3] = 690
  const radius = RING_RADII[3];
  for (const p of layout.placements) {
    const norm = Math.hypot(p.position.x, p.position.z);
    // norm includes z-jitter so it won't exactly equal radius; check it's in
    // [radius - zJitter, radius + zJitter]
    assert.ok(norm >= radius - 18 - 1e-9 && norm <= radius + 18 + 1e-9, `norm ${norm} ≈ ${radius}`);
  }
});

test("device band: ring index is never below startRingIndex", () => {
  const many = gpus("a", "b", "c", "d", "e", "f", "g", "h", "i", "j"); // 10 > capacity(0)=8
  const layout = computeDeviceBandLayout(many, { startRingIndex: 2 });
  assert.ok(
    layout.placements.every((p) => p.ringIndex >= 2),
    "no placement below startRingIndex"
  );
});

/* ------------------------------------------------------------------ */
/* Overflow into multiple rings                                       */
/* ------------------------------------------------------------------ */

test("device band: overflow beyond ring capacity spills to next ring", () => {
  // 10 GPUs at startRingIndex=0: capacity(0)=8 → 8 on ring 0, 2 on ring 1
  const devices = gpus("g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9");
  const layout = computeDeviceBandLayout(devices, { startRingIndex: 0 });
  const ring0 = layout.placements.filter((p) => p.ringIndex === 0);
  const ring1 = layout.placements.filter((p) => p.ringIndex === 1);
  assert.equal(ring0.length, 8, "ring 0 holds 8");
  assert.equal(ring1.length, 2, "ring 1 holds the remaining 2");
  assert.equal(layout.maxRingUsed, 1);
});

test("device band: maxRingUsed is -1 for empty input", () => {
  const layout = computeDeviceBandLayout([], { startRingIndex: 0 });
  assert.deepEqual(layout.placements, []);
  assert.equal(layout.maxRingUsed, -1);
  assert.equal(layout.boundsRadius, 0);
});

/* ------------------------------------------------------------------ */
/* Geometry: z-jitter bounded, radiusScale, ringTiltStep              */
/* ------------------------------------------------------------------ */

test("device band: z-jitter is bounded by zJitter", () => {
  const devices = gpus("a", "b", "c", "d");
  const noJitter = computeDeviceBandLayout(devices, { startRingIndex: 0, zJitter: 0 });
  const withJitter = computeDeviceBandLayout(devices, { startRingIndex: 0, zJitter: 18 });
  for (const p of noJitter.placements) {
    const q = withJitter.placements.find((r) => r.id === p.id)!;
    assert.ok(Math.abs(p.position.x - q.position.x) < 1e-9, "x never jittered");
    assert.ok(Math.abs(p.position.y - q.position.y) < 1e-9, "y never jittered");
    assert.ok(Math.abs(p.position.z - q.position.z) <= 18 + 1e-9, "|Δz| ≤ zJitter");
  }
});

test("device band: radiusScale scales x and z uniformly", () => {
  const devices = gpus("a", "b");
  const base = computeDeviceBandLayout(devices, { startRingIndex: 0, zJitter: 0 });
  const scaled = computeDeviceBandLayout(devices, {
    startRingIndex: 0,
    radiusScale: 2,
    zJitter: 0,
  });
  for (const p of base.placements) {
    const s = scaled.placements.find((r) => r.id === p.id)!;
    assert.ok(Math.abs(s.position.x - p.position.x * 2) < 1e-9, "x × 2");
    assert.ok(Math.abs(s.position.z - p.position.z * 2) < 1e-9, "z × 2");
    // y is ringIndex × ringTiltStep — NOT scaled by radiusScale
    assert.equal(s.position.y, p.position.y, "y unaffected by radiusScale");
  }
});

test("device band: ringTiltStep rescales y; 0 flattens", () => {
  const devices = gpus("a", "b", "c", "d", "e", "f", "g", "h", "i", "j"); // spans 2 rings
  const flat = computeDeviceBandLayout(devices, { startRingIndex: 0, ringTiltStep: 0 });
  assert.ok(
    flat.placements.every((p) => p.position.y === 0),
    "tilt 0 → flat plane"
  );
  const steep = computeDeviceBandLayout(devices, { startRingIndex: 0, ringTiltStep: 40 });
  for (const p of steep.placements) {
    assert.equal(p.position.y, p.ringIndex * 40, "y = ringIndex × ringTiltStep");
  }
});

/* ------------------------------------------------------------------ */
/* Bounds radius                                                      */
/* ------------------------------------------------------------------ */

test("device band: boundsRadius = radiusAt(maxRingUsed) + zJitter", () => {
  const layout = computeDeviceBandLayout(gpus("a"), { startRingIndex: 0, zJitter: 18 });
  assert.equal(layout.boundsRadius, RING_RADII[0] + 18, "single ring 0, zJitter=18");
});

test("device band: boundsRadius scales with radiusScale", () => {
  const layout = computeDeviceBandLayout(gpus("a"), {
    startRingIndex: 2,
    radiusScale: 2,
    zJitter: 18,
  });
  assert.equal(layout.boundsRadius, RING_RADII[2] * 2 + 18 * 2, "radius and jitter both scale");
});

/* ------------------------------------------------------------------ */
/* Consistency with provider layout (no overlap)                      */
/* ------------------------------------------------------------------ */

test("device band: devices placed at startRingIndex ≥ maxProviderRing do not collide with providers", () => {
  const providers = Array.from({ length: 5 }, (_, i) => ({
    id: `provider:p${i}`,
    kind: "provider" as const,
  }));
  const providerLayout = computeAtomicLayout(providers);
  const maxProviderRing = providerLayout.placements.reduce((m, p) => Math.max(m, p.ringIndex), 0);

  const devices = gpus("g1", "g2");
  const band = computeDeviceBandLayout(devices, { startRingIndex: maxProviderRing + 1 });

  // No device ring overlaps a provider ring
  for (const dp of band.placements) {
    assert.ok(
      !providerLayout.placements.some((pp) => pp.ringIndex === dp.ringIndex),
      `device ring ${dp.ringIndex} does not overlap a provider ring`
    );
  }
});
