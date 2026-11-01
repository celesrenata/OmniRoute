/**
 * Unit tests for the developer-only demo harness (OR-ATOM-009 / Phase 2, W3).
 *
 * Verifies, per scenario:
 *  - `build(now)` produces ONLY valid canonical ids (rebuild through
 *    `buildCanonicalResourceId` -> the same id the harness emitted).
 *  - The scenario's `expectedSignals` match the snapshot's OWN `Observed`
 *    values (the "W1 contract is NOT required" rule -- self-checking).
 *  - The scenario's `expectedReconciled` matches what the REAL
 *    `reconcileSnapshot()` emits (edges, node facts, `providerCentricFallback`).
 *
 * No DOM, no React, no `Math.random`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEMO_SCENARIOS,
  DEMO_SCENARIO_IDS,
  buildDemoSnapshot,
  expectSignalsMatch,
  getDemoScenario,
  type DemoScenario,
} from "@/plugins/atomic-topology/dev/demoHarness";
import {
  buildCanonicalResourceId,
  type FleetResourceObservation,
  type Observed,
} from "@/shared/topology/telemetry/types";
import { reconcileSnapshot } from "@/shared/topology/telemetry/reconcile";
import type { ReconciliationEdge } from "@/shared/topology/telemetry/reconcile";

const NOW = 1_700_000_000_000; // fixed epoch-ms (deterministic)

/** The canonical id every resource must carry (rebuilt from its facts). */
function canonicalIdFor(resource: FleetResourceObservation): string {
  if (resource.kind === "gpu") {
    assert.ok(resource.hostId, "gpu resource must carry a hostId");
    assert.ok(resource.deviceUuid, "gpu resource must carry a deviceUuid");
    return buildCanonicalResourceId("gpu", resource.deviceUuid, resource.hostId);
  }
  if (resource.kind === "runtime") {
    assert.ok(resource.hostId, "runtime resource must carry a hostId");
    assert.ok(resource.runtimeId, "runtime resource must carry a runtimeId");
    return buildCanonicalResourceId("runtime", resource.runtimeId, resource.hostId);
  }
  assert.ok(resource.providerId, "provider resource must carry a providerId");
  return buildCanonicalResourceId("provider", resource.providerId);
}

/**
 * Assert the scenario's `expectedReconciled` facts against the REAL
 * `reconcileSnapshot()` output.
 */
function assertReconciled(scenario: DemoScenario): void {
  const result = reconcileSnapshot(buildDemoSnapshot(scenario, NOW));

  assert.equal(
    result.providerCentricFallback,
    scenario.expectedReconciled.providerCentricFallback,
    `${scenario.id}: providerCentricFallback mismatch`
  );

  assert.equal(
    result.gpuNodes.length,
    scenario.expectedReconciled.gpuNodeCount,
    `${scenario.id}: gpuNodeCount mismatch (got ${result.gpuNodes.length})`
  );

  if (scenario.expectedReconciled.runtimeNodes) {
    for (const want of scenario.expectedReconciled.runtimeNodes) {
      const got = result.runtimeNodes.find((n) => n.resourceId === want.resourceId);
      assert.ok(got, `${scenario.id}: expected runtime node ${want.resourceId} not found`);
      assert.deepEqual(
        got?.attributedGpuIds,
        want.attributedGpuIds,
        `${scenario.id}: attributedGpuIds for ${want.resourceId}`
      );
      assert.equal(
        got?.outputTokensPerSecond?.value,
        want.outputTokensPerSecond,
        `${scenario.id}: outputTokensPerSecond for ${want.resourceId}`
      );
      assert.equal(got?.modelId, want.modelId, `${scenario.id}: modelId for ${want.resourceId}`);
    }
  }

  const edgeKey = (e: ReconciliationEdge): string => `${e.relation}|${e.source}|${e.target}`;
  const wantKeys = scenario.expectedReconciled.edges
    .map((e) => `${e.relation}|${e.source}|${e.target}`)
    .sort();
  const gotKeys = result.edges.map(edgeKey).sort();
  assert.deepEqual(
    gotKeys,
    wantKeys,
    `${scenario.id}: edge set mismatch (got ${gotKeys.join(", ")})`
  );
}

test("demo harness: scenario ids are exactly the VALIDATION_MATRIX rows", () => {
  const ids = DEMO_SCENARIOS.map((s) => s.id);
  assert.deepEqual(ids, [...DEMO_SCENARIO_IDS]);
  for (const id of DEMO_SCENARIO_IDS) {
    assert.ok(getDemoScenario(id), `getDemoScenario(${id}) must resolve`);
  }
  assert.equal(getDemoScenario("not-a-scenario"), null);
});

test("demo harness: every scenario build() emits only canonical ids", () => {
  for (const scenario of DEMO_SCENARIOS) {
    const resources = scenario.build(NOW);
    assert.ok(resources.length > 0, `${scenario.id}: build() returned no resources`);
    for (const resource of resources) {
      const canonical = canonicalIdFor(resource);
      assert.equal(
        resource.resourceId,
        canonical,
        `${scenario.id}: resourceId ${resource.resourceId} is not the canonical ${canonical}`
      );
      const parts = resource.resourceId.split(":");
      for (const part of parts) {
        assert.ok(!part.includes(" ") && !part.includes("/"), `bad id segment "${part}"`);
      }
    }
  }
});

test("demo harness: build() is deterministic and non-mutating", () => {
  for (const scenario of DEMO_SCENARIOS) {
    const a = scenario.build(NOW);
    const aJson = JSON.stringify(a);
    const b = scenario.build(NOW);
    assert.equal(JSON.stringify(b), aJson, `${scenario.id}: build() not deterministic`);
    a[0].resourceId = "mutated";
    assert.notEqual(scenario.build(NOW)[0].resourceId, "mutated");
  }
});

test("demo harness: expectedSignals match the snapshot's own Observed values", () => {
  for (const scenario of DEMO_SCENARIOS) {
    const snapshot = buildDemoSnapshot(scenario, NOW);
    const check = expectSignalsMatch(snapshot, scenario);
    assert.equal(
      check.ok,
      true,
      `${scenario.id}: expectedSignals mismatch:\n${check.mismatches.join("\n")}`
    );
  }
});

test("demo harness: expectedReconciled matches the real reconcileSnapshot()", () => {
  for (const scenario of DEMO_SCENARIOS) {
    assertReconciled(scenario);
  }
});

test("demo harness: zero vs unknown is respected (explicit 0 vs null vs absent)", () => {
  const idle = getDemoScenario("idle") as DemoScenario;
  const idleSnap = buildDemoSnapshot(idle, NOW);
  const idleGpu = idleSnap.resources.find((r) => r.kind === "gpu") as FleetResourceObservation;
  const idleTps = idleGpu.outputTokensPerSecond as Observed<number>;
  assert.equal(idleTps.value, 0, "idle: a measured zero is a literal 0 (not null)");
  assert.equal(idleTps.stale, false, "idle: fresh sample is not stale");

  const stale = getDemoScenario("unknown-stale") as DemoScenario;
  const staleSnap = buildDemoSnapshot(stale, NOW);
  const staleRuntime = staleSnap.resources.find(
    (r) => r.kind === "runtime"
  ) as FleetResourceObservation;
  const staleTps = staleRuntime.outputTokensPerSecond as Observed<number>;
  assert.equal(staleTps.value, null, "stale: an aged sample decays to null (unknown)");
  assert.equal(staleTps.stale, true, "stale: the aged sample is flagged stale");
  assert.equal(
    staleRuntime.temperatureC,
    undefined,
    "stale: temperatureC is ABSENT (missing), not null"
  );
});

test("demo harness: multi-runtime GPU sums per-device attribution (never splits)", () => {
  const scenario = getDemoScenario("multi-runtime-gpu") as DemoScenario;
  const snap = buildDemoSnapshot(scenario, NOW);
  const gpuA = snap.resources.find((r) =>
    r.resourceId.endsWith(":dev-uuid-a")
  ) as FleetResourceObservation;
  const gpuB = snap.resources.find((r) =>
    r.resourceId.endsWith(":dev-uuid-b")
  ) as FleetResourceObservation;
  assert.equal(gpuA.outputTokensPerSecond?.value, 90, "GPU A carries the summed 60+30");
  assert.equal(
    gpuB.outputTokensPerSecond,
    undefined,
    "GPU B (unattributed) has NO throughput fact"
  );

  const result = reconcileSnapshot(snap);
  const rtA = result.runtimeNodes.find(
    (n) => n.runtimeId === "rt-demo-a"
  ) as (typeof result.runtimeNodes)[number];
  const rtB = result.runtimeNodes.find(
    (n) => n.runtimeId === "rt-demo-b"
  ) as (typeof result.runtimeNodes)[number];
  assert.deepEqual(rtA?.attributedGpuIds, [result.gpuNodes[0].resourceId]);
  assert.deepEqual(rtB?.attributedGpuIds, [result.gpuNodes[0].resourceId]);
  assert.equal(result.providerCentricFallback, false);
});

test("demo harness: mixed-lanes model ids classify via the real lane rules", () => {
  const scenario = getDemoScenario("mixed-lanes") as DemoScenario;
  const snap = buildDemoSnapshot(scenario, NOW);
  const models = snap.resources
    .filter((r) => r.kind === "runtime")
    .map((r) => r.modelId)
    .filter((m): m is string => typeof m === "string");
  assert.ok(models.includes("demo/text-embedding-3-small"), "embedding model present");
  assert.ok(models.includes("demo/qwen2-vl-7b-vision"), "vision model present");
});
