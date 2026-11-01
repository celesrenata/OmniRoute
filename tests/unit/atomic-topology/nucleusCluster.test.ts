/**
 * Unit tests for the deterministic nucleus-cluster builder (OR-ATOM-008,
 * S8.3) — `src/plugins/atomic-topology/scene/nucleusCluster.ts`.
 *
 * Runner: `node --import tsx/esm --test` (node:test + assert; the builder is
 * pure — no `three`, no DOM, no wall clock, seeded mulberry32 only).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { modelColor } from "../../../src/plugins/atomic-topology/visualEncoding";
import {
  buildNucleusCluster,
  GROUP_NEUTRON_SLATE_BLEND,
  GROUP_PROTON_WARM_BLEND,
  HUB_NUCLEUS_PARTICLE_COUNT,
  MAX_MODEL_GROUPS,
  mixHex,
  NEUTRON_EMISSIVE_MUL,
  NEUTRON_SCALE_MAX,
  NEUTRON_SCALE_MIN,
  NEUTRON_TINT_SLATE,
  NUCLEUS_SHELL_JITTER,
  NUCLEUS_SHELL_RADIUS,
  PROTON_EMISSIVE_MUL,
  PROTON_SCALE_MAX,
  PROTON_SCALE_MIN,
  PROTON_TINT_WARM,
  PROTON_TARGET_SHARE,
  RING_NUCLEUS_PARTICLE_COUNT,
  type NucleusCluster,
} from "../../../src/plugins/atomic-topology/scene/nucleusCluster";

/** FNV-1a 32-bit (same construction as `cloudShells.ts` / `visualEncoding.ts`). */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const SEED_A = fnv1a("provider:openai");
const SEED_B = fnv1a("provider:anthropic");

const MODELS = ["gpt-4o", "claude-sonnet-4-5", "gemini-2.5-pro"];

function expectedProtonCount(count: number): number {
  return Math.min(count, Math.max(1, Math.round(count * PROTON_TARGET_SHARE)));
}

test("ring/hub particle count constants are inside the S8.3 spec ranges", () => {
  assert.ok(RING_NUCLEUS_PARTICLE_COUNT >= 7 && RING_NUCLEUS_PARTICLE_COUNT <= 9);
  assert.ok(HUB_NUCLEUS_PARTICLE_COUNT >= 11 && HUB_NUCLEUS_PARTICLE_COUNT <= 13);
});

test("determinism: identical inputs always yield identical clusters", () => {
  const a = buildNucleusCluster({ seed: SEED_A, particleCount: RING_NUCLEUS_PARTICLE_COUNT });
  const b = buildNucleusCluster({ seed: SEED_A, particleCount: RING_NUCLEUS_PARTICLE_COUNT });
  assert.deepStrictEqual(a, b);

  const c = buildNucleusCluster({
    seed: SEED_A,
    particleCount: RING_NUCLEUS_PARTICLE_COUNT,
    observedModelIds: MODELS,
  });
  const d = buildNucleusCluster({
    seed: SEED_A,
    particleCount: RING_NUCLEUS_PARTICLE_COUNT,
    observedModelIds: MODELS,
  });
  assert.deepStrictEqual(c, d);
});

test("different seeds give different cluster orientations", () => {
  const a = buildNucleusCluster({ seed: SEED_A, particleCount: HUB_NUCLEUS_PARTICLE_COUNT });
  const b = buildNucleusCluster({ seed: SEED_B, particleCount: HUB_NUCLEUS_PARTICLE_COUNT });
  assert.notDeepStrictEqual(a.particles[0].position, b.particles[0].position);
  assert.notDeepStrictEqual(a.spinAxis, b.spinAxis);
});

test("particle count is exact; zero count yields an empty cluster", () => {
  const ring = buildNucleusCluster({ seed: SEED_A, particleCount: RING_NUCLEUS_PARTICLE_COUNT });
  assert.equal(ring.particles.length, RING_NUCLEUS_PARTICLE_COUNT);
  const hub = buildNucleusCluster({ seed: SEED_A, particleCount: HUB_NUCLEUS_PARTICLE_COUNT });
  assert.equal(hub.particles.length, HUB_NUCLEUS_PARTICLE_COUNT);
  assert.deepStrictEqual(buildNucleusCluster({ seed: SEED_A, particleCount: 0 }).particles, []);
});

test("proton/neutron split is the deterministic ~55/45 target", () => {
  for (const count of [RING_NUCLEUS_PARTICLE_COUNT, HUB_NUCLEUS_PARTICLE_COUNT]) {
    const cluster = buildNucleusCluster({ seed: SEED_A, particleCount: count });
    const protons = cluster.particles.filter((p) => p.isProton).length;
    const expected = expectedProtonCount(count);
    assert.equal(protons, expected);
    assert.equal(count - protons, count - expected);
  }
});

test("neutral palette when no model ids are observed (honest unknown)", () => {
  const cluster = buildNucleusCluster({ seed: SEED_A, particleCount: HUB_NUCLEUS_PARTICLE_COUNT });
  assert.deepStrictEqual(cluster.modelGroups, []);
  for (const p of cluster.particles) {
    assert.equal(p.modelGroupIndex, -1);
    assert.equal(p.tint, p.isProton ? PROTON_TINT_WARM : NEUTRON_TINT_SLATE);
  }
});

test("empty-string / blank model ids resolve to the neutral palette", () => {
  for (const ids of [[], ["", "  "]]) {
    const cluster = buildNucleusCluster({
      seed: SEED_A,
      particleCount: RING_NUCLEUS_PARTICLE_COUNT,
      observedModelIds: ids,
    });
    assert.deepStrictEqual(cluster.modelGroups, []);
    for (const p of cluster.particles) {
      assert.equal(p.modelGroupIndex, -1);
    }
  }
});

test("model groups cap at MAX_MODEL_GROUPS and are hash-sorted (not array-indexed)", () => {
  const ids = MODELS.concat(["llama-3.3-70b", "qwen-3-235b"]);
  const cluster = buildNucleusCluster({
    seed: SEED_A,
    particleCount: HUB_NUCLEUS_PARTICLE_COUNT,
    observedModelIds: ids,
  });
  assert.equal(cluster.modelGroups.length, MAX_MODEL_GROUPS);
  const hashes = cluster.modelGroups.map((id) => fnv1a(id));
  assert.deepStrictEqual(
    hashes,
    [...hashes].sort((x, y) => x - y)
  );
});

test("case-insensitive, de-duplicated canonicalization", () => {
  const cluster = buildNucleusCluster({
    seed: SEED_A,
    particleCount: RING_NUCLEUS_PARTICLE_COUNT,
    observedModelIds: ["GPT-4O", " gpt-4o ", "claude-sonnet-4-5"],
  });
  const canonical = ["gpt-4o", "claude-sonnet-4-5"].sort((x, y) => {
    const h = fnv1a(x) - fnv1a(y);
    return h !== 0 ? h : x < y ? -1 : 1;
  });
  assert.deepStrictEqual(cluster.modelGroups, canonical);
});

test("model-group assignment is stable under model ORDER changes", () => {
  const perm = [MODELS[2], MODELS[0], MODELS[1]];
  const a = buildNucleusCluster({
    seed: SEED_A,
    particleCount: HUB_NUCLEUS_PARTICLE_COUNT,
    observedModelIds: MODELS,
  });
  const b = buildNucleusCluster({
    seed: SEED_A,
    particleCount: HUB_NUCLEUS_PARTICLE_COUNT,
    observedModelIds: perm,
  });
  assert.deepStrictEqual(a.modelGroups, b.modelGroups);
  assert.deepStrictEqual(
    a.particles.map((p) => p.modelGroupIndex),
    b.particles.map((p) => p.modelGroupIndex)
  );
  assert.deepStrictEqual(
    a.particles.map((p) => p.tint),
    b.particles.map((p) => p.tint)
  );
});

test("grouped particles read as spatially clustered angular sectors", () => {
  const cluster = buildNucleusCluster({
    seed: SEED_A,
    particleCount: HUB_NUCLEUS_PARTICLE_COUNT,
    observedModelIds: MODELS,
  });
  const byIndex = new Map<number, [number, number, number][]>();
  for (const p of cluster.particles) {
    assert.ok(p.modelGroupIndex >= 0 && p.modelGroupIndex < MAX_MODEL_GROUPS);
    const arr = byIndex.get(p.modelGroupIndex) ?? [];
    arr.push(p.position);
    byIndex.set(p.modelGroupIndex, arr);
  }
  assert.equal(byIndex.size, MAX_MODEL_GROUPS);
  const azimuth = (p: [number, number, number]): number => {
    let a = Math.atan2(p[2], p[0]);
    if (a < 0) a += Math.PI * 2;
    return a;
  };
  const sectorWidth = (Math.PI * 2) / MAX_MODEL_GROUPS;
  for (const [, positions] of byIndex) {
    const angles = positions.map(azimuth).sort((x, y) => x - y);
    let spread = angles[angles.length - 1] - angles[0];
    if (angles.length > 1) {
      spread = Math.min(spread, Math.PI * 2 - spread);
    }
    assert.ok(spread <= sectorWidth + 1e-9, `sector spread ${spread} exceeds band`);
  }
});

test("protons vs neutrons: scale + emissive separation is exact and bounded", () => {
  const cluster = buildNucleusCluster({ seed: SEED_A, particleCount: HUB_NUCLEUS_PARTICLE_COUNT });
  for (const p of cluster.particles) {
    if (p.isProton) {
      assert.ok(p.scaleMul >= PROTON_SCALE_MIN && p.scaleMul <= PROTON_SCALE_MAX);
      assert.equal(p.emissiveMul, PROTON_EMISSIVE_MUL);
    } else {
      assert.ok(p.scaleMul >= NEUTRON_SCALE_MIN && p.scaleMul <= NEUTRON_SCALE_MAX);
      assert.equal(p.emissiveMul, NEUTRON_EMISSIVE_MUL);
      // Neutrons never reach proton scale (shape/luminance separation).
      assert.ok(p.scaleMul < PROTON_SCALE_MIN);
    }
  }
});

test("positions sit on the jittered 0.55x-core-radius shell", () => {
  const minR = NUCLEUS_SHELL_RADIUS - NUCLEUS_SHELL_JITTER;
  const maxR = NUCLEUS_SHELL_RADIUS + NUCLEUS_SHELL_JITTER;
  for (const p of buildNucleusCluster({ seed: SEED_A, particleCount: HUB_NUCLEUS_PARTICLE_COUNT })
    .particles) {
    const r = Math.hypot(p.position[0], p.position[1], p.position[2]);
    assert.ok(r >= minR && r <= maxR, `radius ${r} outside shell band`);
  }
});

test("spin axis is a unit vector and stable per seed", () => {
  const a = buildNucleusCluster({ seed: SEED_A, particleCount: RING_NUCLEUS_PARTICLE_COUNT });
  const b = buildNucleusCluster({ seed: SEED_A, particleCount: HUB_NUCLEUS_PARTICLE_COUNT });
  for (const cluster of [a, b]) {
    const [x, y, z] = cluster.spinAxis;
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-9);
  }
  assert.deepStrictEqual(a.spinAxis, b.spinAxis);
});

test("observed-group tints are modelColor blended toward the role tints", () => {
  const cluster = buildNucleusCluster({
    seed: SEED_A,
    particleCount: HUB_NUCLEUS_PARTICLE_COUNT,
    observedModelIds: MODELS,
  });
  const expected = (proton: boolean, modelId: string): string =>
    proton
      ? mixHex(modelColor(modelId), PROTON_TINT_WARM, GROUP_PROTON_WARM_BLEND)
      : mixHex(modelColor(modelId), NEUTRON_TINT_SLATE, GROUP_NEUTRON_SLATE_BLEND);
  for (const p of cluster.particles) {
    assert.equal(p.tint, expected(p.isProton, cluster.modelGroups[p.modelGroupIndex]));
  }
});

test("the same atom id always seeds the same cluster (seed contract)", () => {
  const id = "provider:openai";
  const a: NucleusCluster = buildNucleusCluster({
    seed: fnv1a(id),
    particleCount: RING_NUCLEUS_PARTICLE_COUNT,
  });
  const b: NucleusCluster = buildNucleusCluster({
    seed: fnv1a(id),
    particleCount: RING_NUCLEUS_PARTICLE_COUNT,
  });
  assert.deepStrictEqual(a, b);
});
