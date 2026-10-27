/**
 * Unit tests for the fleet-telemetry reconciliation layer (OR-ATOM-005 / Step 5):
 * `reconcileSnapshot(snapshot)` / `updateGpuPresence(state, ids, threshold)` —
 * both pure functions driven through the PUBLIC exports.
 *
 * Deterministic + hermetic: fixture snapshot builders, no network, no DB.
 *
 * Invariants under test (task data-semantics table):
 *   - canonical IDs exactly: `gpu:<host>:<uuid>`, `runtime:<host>:<id>`,
 *     `provider:<pid>` — built via buildCanonicalResourceId, never guessed;
 *   - GPU nodes ONLY for devices with a proven identity; cloud-only providers
 *     stay provider atoms (never conflated with devices);
 *   - relationship edges carry provenance: runtime→device ONLY from explicit
 *     per-device attribution; runtime→model ONLY from an observed modelId;
 *     an absent edge means "unattached" — never a guessed join;
 *   - zero vs unknown: a present zero is carried; a stale field marks the node
 *     stale;
 *   - dedup by canonical ID, stable sorted output across reorders.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createGpuPresenceState,
  reconcileSnapshot,
  updateGpuPresence,
} from "../../../src/shared/topology/telemetry/reconcile";
import {
  fixtureNow,
  gpuResource,
  providerResource,
  resetFixtureClock,
  runtimeResource,
  observedValue,
} from "./telemetry-fixtures";

resetFixtureClock(1_700_000_000_000);
const NOW = fixtureNow();

const GPU_A = "gpu:h1:uuid-0";
const GPU_B = "gpu:h1:uuid-1";
const RT_A = "runtime:h1:rt-0";
const RT_B = "runtime:h2:rt-1";
const PROVIDER_X = "provider:x";

function snapshotOf(
  resources: Array<Parameters<typeof gpuResource>[2] extends Partial<infer R> ? R : never>
) {
  return { schemaVersion: 1 as const, capturedAt: NOW, resources };
}

function gpuById(result: ReturnType<typeof reconcileSnapshot>, id: string) {
  const node = result.gpuNodes.find((n) => n.resourceId === id);
  assert.ok(node, `expected gpu node ${id}`);
  return node;
}

function runtimeById(result: ReturnType<typeof reconcileSnapshot>, id: string) {
  const node = result.runtimeNodes.find((n) => n.resourceId === id);
  assert.ok(node, `expected runtime node ${id}`);
  return node;
}

describe("reconcile: node construction", () => {
  it("builds a gpu node with canonical id, identity facts, and carried observed fields", () => {
    const result = reconcileSnapshot(
      snapshotOf([
        gpuResource("h1", "uuid-0", {
          utilizationPercent: observedValue(73.5, {
            source: "prometheus",
            basis: "DCGM_FI_DEV_GPU_UTIL",
          }),
          vramUsedBytes: observedValue(2_147_483_648, { source: "prometheus" }),
          powerWatts: observedValue(0, { source: "prometheus" }), // present zero is a real measurement
        }),
      ])
    );

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.capturedAt, NOW);
    assert.equal(result.gpuNodes.length, 1);
    const node = gpuById(result, GPU_A);
    assert.equal(node.hostId, "h1");
    assert.equal(node.deviceUuid, "uuid-0");
    assert.equal(node.utilizationPercent?.value, 73.5);
    assert.equal(node.vramUsedBytes?.value, 2_147_483_648);
    // A present zero is carried (not dropped as unknown).
    assert.equal(node.powerWatts?.value, 0);
    assert.equal(node.stale, false);
  });

  it("builds runtime and provider nodes with their identity facts", () => {
    const result = reconcileSnapshot(
      snapshotOf([
        runtimeResource("h1", "rt-0", {
          outputTokensPerSecond: observedValue(10, { source: "prometheus" }),
          queuedJobs: observedValue(2, { source: "prometheus" }),
          activeJobs: observedValue(1, { source: "prometheus" }),
          modelId: "llama-3-8b",
        }),
        providerResource("x", { queuedJobs: observedValue(5, { source: "omniroute-live" }) }),
      ])
    );

    const rt = runtimeById(result, RT_A);
    assert.equal(rt.hostId, "h1");
    assert.equal(rt.runtimeId, "rt-0");
    assert.equal(rt.modelId, "llama-3-8b");
    assert.equal(rt.outputTokensPerSecond?.value, 10);
    assert.equal(rt.queuedJobs?.value, 2);
    assert.equal(rt.activeJobs?.value, 1);
    assert.deepEqual(rt.attributedGpuIds, []);
    assert.equal(rt.stale, false);

    assert.equal(result.providerNodes.length, 1);
    assert.equal(result.providerNodes[0].resourceId, PROVIDER_X);
    assert.equal(result.providerNodes[0].providerId, "x");
    assert.equal(result.providerNodes[0].queuedJobs?.value, 5);
    // Cloud-only provider stays a provider atom — no gpu nodes invented.
    assert.equal(result.gpuNodes.length, 0);
    assert.equal(result.providerCentricFallback, true);
  });

  it("marks a node stale when any tracked observed field is stale", () => {
    const result = reconcileSnapshot(
      snapshotOf([
        gpuResource("h1", "uuid-0", {
          utilizationPercent: observedValue(73.5, { source: "prometheus", stale: true }),
        }),
        runtimeResource("h1", "rt-0", {
          outputTokensPerSecond: observedValue(null, { source: "prometheus", stale: true }),
        }),
      ])
    );
    assert.equal(gpuById(result, GPU_A).stale, true);
    assert.equal(runtimeById(result, RT_A).stale, true);
  });
});

describe("reconcile: identity safety", () => {
  it("drops gpu resources without a proven host/uuid (never fabricated)", () => {
    const result = reconcileSnapshot(
      snapshotOf([
        { resourceId: "gpu:?:uuid-0", kind: "gpu", deviceUuid: "uuid-0" },
        { resourceId: "gpu:h1:?", kind: "gpu", hostId: "h1" },
      ])
    );
    assert.equal(result.gpuNodes.length, 0);
  });

  it("drops runtime resources without a proven host/runtimeId", () => {
    const result = reconcileSnapshot(
      snapshotOf([{ resourceId: "runtime:h1:?", kind: "runtime", hostId: "h1" }])
    );
    assert.equal(result.runtimeNodes.length, 0);
  });

  it("drops provider resources without a proven providerId", () => {
    const result = reconcileSnapshot(snapshotOf([{ resourceId: "provider:?", kind: "provider" }]));
    assert.equal(result.providerNodes.length, 0);
  });
});

describe("reconcile: relationship edges (provenance-carrying, never guessed)", () => {
  it("emits a runtime→device edge ONLY from explicit per-device attribution", () => {
    const result = reconcileSnapshot(
      snapshotOf([
        runtimeResource("h1", "rt-0", {
          // Per-device attribution fact on the runtime sample.
          deviceUuid: "uuid-0",
          outputTokensPerSecond: observedValue(10, { source: "prometheus" }),
        }),
      ])
    );

    const rt = runtimeById(result, RT_A);
    assert.deepEqual(rt.attributedGpuIds, [GPU_A]);

    assert.deepEqual(result.edges, [
      {
        source: RT_A,
        target: GPU_A,
        relation: "runtime_device",
        basis: "runtime per-device attribution",
        sampledAt: NOW,
      },
    ]);
  });

  it("emits a runtime→model edge ONLY when a modelId is observed", () => {
    const result = reconcileSnapshot(
      snapshotOf([runtimeResource("h1", "rt-0", { modelId: "llama-3-8b" })])
    );
    assert.deepEqual(result.edges, [
      {
        source: RT_A,
        target: "model:llama-3-8b",
        relation: "runtime_model",
        basis: "runtime observed model residency",
        sampledAt: NOW,
      },
    ]);
  });

  it("never invents provider→runtime edges: absent source means unattached", () => {
    const result = reconcileSnapshot(
      snapshotOf([providerResource("x"), runtimeResource("h1", "rt-0")])
    );
    // No reliable source correlates provider key → runtime host in this module.
    assert.equal(result.edges.length, 0);
  });

  it("emits NO runtime→device edge when attribution is unknown (throughput stays runtime-level)", () => {
    const result = reconcileSnapshot(
      snapshotOf([
        // Runtime has TPS but no per-device attribution fact.
        runtimeResource("h1", "rt-0", {
          outputTokensPerSecond: observedValue(42, { source: "prometheus" }),
        }),
        // A GPU exists on the same host — that must NOT create an edge.
        gpuResource("h1", "uuid-0", {
          utilizationPercent: observedValue(50, { source: "prometheus" }),
        }),
      ])
    );
    assert.deepEqual(runtimeById(result, RT_A).attributedGpuIds, []);
    assert.equal(result.edges.length, 0);
  });
});

describe("reconcile: dedup, ordering, fallback flag", () => {
  it("dedups resources by canonical id and merges fields across rows", () => {
    const result = reconcileSnapshot(
      snapshotOf([
        gpuResource("h1", "uuid-0", {
          utilizationPercent: observedValue(73.5, { source: "prometheus" }),
        }),
        // Same canonical id, a different field (a second provider row merged in).
        gpuResource("h1", "uuid-0", {
          temperatureC: observedValue(61, { source: "grafana" }),
        }),
      ])
    );
    assert.equal(result.gpuNodes.length, 1);
    const node = gpuById(result, GPU_A);
    assert.equal(node.utilizationPercent?.value, 73.5);
    assert.equal(node.temperatureC?.value, 61);
  });

  it("returns nodes/edges sorted by canonical id (stable across input reorders)", () => {
    const resources = [
      gpuResource("h1", "uuid-1", {
        utilizationPercent: observedValue(10, { source: "prometheus" }),
      }),
      gpuResource("h1", "uuid-0", {
        utilizationPercent: observedValue(20, { source: "prometheus" }),
      }),
      runtimeResource("h2", "rt-1", { modelId: "m2" }),
      runtimeResource("h1", "rt-0", { modelId: "m1" }),
    ];
    const a = reconcileSnapshot(snapshotOf([...resources]));
    const b = reconcileSnapshot(snapshotOf([...resources].reverse()));

    assert.deepEqual(
      a.gpuNodes.map((n) => n.resourceId),
      [GPU_A, GPU_B]
    );
    assert.deepEqual(
      a.runtimeNodes.map((n) => n.resourceId),
      [RT_A, RT_B]
    );
    // Reordered input produces identical output.
    assert.deepEqual(b, a);
  });

  it("sets providerCentricFallback=false whenever at least one gpu node exists", () => {
    const result = reconcileSnapshot(
      snapshotOf([
        providerResource("x"),
        gpuResource("h1", "uuid-0", {
          utilizationPercent: observedValue(50, { source: "prometheus" }),
        }),
      ])
    );
    assert.equal(result.providerNodes.length, 1);
    assert.equal(result.gpuNodes.length, 1);
    assert.equal(result.providerCentricFallback, false);
  });
});

describe("gpu presence tracking (updateGpuPresence)", () => {
  it("drops a gpu only after `threshold` consecutive missed snapshots", () => {
    const state = createGpuPresenceState();

    // First seen.
    assert.deepEqual(updateGpuPresence(state, [GPU_A, GPU_B], 2), []);
    // First miss: below threshold.
    assert.deepEqual(updateGpuPresence(state, [GPU_B], 2), []);
    // Re-seen → counter resets, nothing dropped.
    assert.deepEqual(updateGpuPresence(state, [GPU_A, GPU_B], 2), []);
    // Two consecutive misses → dropped.
    assert.deepEqual(updateGpuPresence(state, [GPU_B], 2), []);
    assert.deepEqual(updateGpuPresence(state, [GPU_B], 2), [GPU_A]);

    // Dropped state is cleaned up; a later re-appearance starts fresh.
    assert.deepEqual(updateGpuPresence(state, [GPU_A], 2), []);
    assert.deepEqual(updateGpuPresence(state, [GPU_B], 2), []); // 1 miss, below threshold
  });
});
