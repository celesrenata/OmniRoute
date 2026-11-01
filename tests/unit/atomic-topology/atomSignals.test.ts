import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildAtomSignals,
  mergeDemoSignals,
  type AtomMotionSignal,
} from "../../../src/shared/topology/telemetry/atomSignals";
import type {
  ReconciliationEdge,
  ReconciliationResult,
  ReconciledGpuNode,
  ReconciledProviderNode,
  ReconciledRuntimeNode,
} from "../../../src/shared/topology/telemetry/reconcile";
import type { Observed } from "../../../src/shared/topology/telemetry/types";

/** Build a minimal provenance-carrying Observed with sane defaults. */
function observed(
  value: number | null,
  overrides: Partial<Observed<number>> = {}
): Observed<number> {
  return { value, source: "runtime", sampledAt: 1000, ...overrides };
}

function gpu(resourceId: string, overrides: Partial<ReconciledGpuNode> = {}): ReconciledGpuNode {
  return { resourceId, hostId: "host", deviceUuid: "uuid", stale: false, ...overrides };
}

function runtime(
  resourceId: string,
  overrides: Partial<ReconciledRuntimeNode> = {}
): ReconciledRuntimeNode {
  return {
    resourceId,
    hostId: "host",
    runtimeId: "r",
    attributedGpuIds: [],
    stale: false,
    ...overrides,
  };
}

function provider(
  resourceId: string,
  overrides: Partial<ReconciledProviderNode> = {}
): ReconciledProviderNode {
  return { resourceId, providerId: "p", stale: false, ...overrides };
}

function edge(
  source: string,
  target: string,
  relation: ReconciliationEdge["relation"],
  basis: string,
  sampledAt: number
): ReconciliationEdge {
  return { source, target, relation, basis, sampledAt };
}

function reconciliation(overrides: Partial<ReconciliationResult> = {}): ReconciliationResult {
  return {
    schemaVersion: 1,
    capturedAt: 500,
    gpuNodes: [],
    runtimeNodes: [],
    providerNodes: [],
    edges: [],
    providerCentricFallback: false,
    ...overrides,
  };
}

function atom(signals: ReturnType<typeof buildAtomSignals>, id: string): AtomMotionSignal {
  const found = signals.perAtom.get(id);
  assert.ok(found, `expected atom signal for ${id}`);
  return found;
}

describe("buildAtomSignals", () => {
  it("maps null and undefined to an empty, provider-neutral result", () => {
    for (const input of [null, undefined]) {
      const signals = buildAtomSignals(input);
      assert.equal(signals.perAtom.size, 0);
      assert.deepEqual(signals.edges, []);
      assert.equal(signals.providerCentricFallback, false);
      assert.equal(signals.capturedAt, 0);
    }
  });

  describe("fresh explicit zero maps through (a real measurement)", () => {
    it("gpu: fresh zero TPS is kept, source live, proven throughput true", () => {
      const signals = buildAtomSignals(
        reconciliation({
          gpuNodes: [gpu("gpu:h:0", { outputTokensPerSecond: observed(0, { basis: "gpu-own" }) })],
        })
      );
      const a = atom(signals, "gpu:h:0");
      assert.equal(a.tokensPerSecond, 0);
      assert.equal(a.source, "live");
      assert.equal(a.gpuHasProvenThroughput, true);
      assert.equal(a.sampledAt, 1000);
      assert.equal(a.basis, "gpu-own");
    });

    it("runtime: fresh zero queuedJobs is kept while TPS drives the headline", () => {
      const signals = buildAtomSignals(
        reconciliation({
          runtimeNodes: [
            runtime("runtime:h:r", {
              queuedJobs: observed(0),
              outputTokensPerSecond: observed(120),
            }),
          ],
        })
      );
      const a = atom(signals, "runtime:h:r");
      assert.equal(a.queuedJobs, 0);
      assert.equal(a.tokensPerSecond, 120);
      assert.equal(a.source, "live");
    });

    it("provider: fresh zero activeJobs is kept", () => {
      const signals = buildAtomSignals(
        reconciliation({
          providerNodes: [
            provider("provider:p", {
              activeJobs: observed(0),
              outputTokensPerSecond: observed(55),
            }),
          ],
        })
      );
      const a = atom(signals, "provider:p");
      assert.equal(a.activeJobs, 0);
      assert.equal(a.tokensPerSecond, 55);
    });
  });

  describe("stale Observed maps to null with source 'stale'", () => {
    it("gpu: stale TPS → null, source stale, no proven throughput", () => {
      const signals = buildAtomSignals(
        reconciliation({
          gpuNodes: [gpu("gpu:h:0", { outputTokensPerSecond: observed(42, { stale: true }) })],
        })
      );
      const a = atom(signals, "gpu:h:0");
      assert.equal(a.tokensPerSecond, null);
      assert.equal(a.source, "stale");
      assert.equal(a.gpuHasProvenThroughput, false);
    });

    it("runtime: stale TPS + stale queued both → null, source stale", () => {
      const signals = buildAtomSignals(
        reconciliation({
          runtimeNodes: [
            runtime("runtime:h:r", {
              outputTokensPerSecond: observed(300, { stale: true }),
              queuedJobs: observed(9, { stale: true }),
            }),
          ],
        })
      );
      const a = atom(signals, "runtime:h:r");
      assert.equal(a.tokensPerSecond, null);
      assert.equal(a.queuedJobs, null);
      assert.equal(a.source, "stale");
    });

    it("provider: stale TPS → null, source stale", () => {
      const signals = buildAtomSignals(
        reconciliation({
          providerNodes: [
            provider("provider:p", { outputTokensPerSecond: observed(10, { stale: true }) }),
          ],
        })
      );
      const a = atom(signals, "provider:p");
      assert.equal(a.tokensPerSecond, null);
      assert.equal(a.source, "stale");
    });
  });

  describe("field-missing Observed maps to null with source 'unavailable'", () => {
    it("gpu: missing TPS → null, unavailable, no proven throughput", () => {
      const signals = buildAtomSignals(reconciliation({ gpuNodes: [gpu("gpu:h:0")] }));
      const a = atom(signals, "gpu:h:0");
      assert.equal(a.tokensPerSecond, null);
      assert.equal(a.source, "unavailable");
      assert.equal(a.gpuHasProvenThroughput, false);
      assert.equal(a.sampledAt, null);
      assert.equal(a.basis, undefined);
    });

    it("runtime: all fields missing → nulls, unavailable", () => {
      const signals = buildAtomSignals(reconciliation({ runtimeNodes: [runtime("runtime:h:r")] }));
      const a = atom(signals, "runtime:h:r");
      assert.equal(a.tokensPerSecond, null);
      assert.equal(a.queuedJobs, null);
      assert.equal(a.activeJobs, null);
      assert.equal(a.source, "unavailable");
      assert.deepEqual(a.modelIds, []);
    });

    it("provider: missing TPS → null, unavailable", () => {
      const signals = buildAtomSignals(reconciliation({ providerNodes: [provider("provider:p")] }));
      const a = atom(signals, "provider:p");
      assert.equal(a.tokensPerSecond, null);
      assert.equal(a.source, "unavailable");
      assert.deepEqual(a.modelIds, []);
    });
  });

  describe("null-observed (value null) maps to null with source 'unavailable'", () => {
    it("gpu: value-null TPS → null, unavailable, no proven throughput", () => {
      const signals = buildAtomSignals(
        reconciliation({
          gpuNodes: [gpu("gpu:h:0", { outputTokensPerSecond: observed(null) })],
        })
      );
      const a = atom(signals, "gpu:h:0");
      assert.equal(a.tokensPerSecond, null);
      assert.equal(a.source, "unavailable");
      assert.equal(a.gpuHasProvenThroughput, false);
    });

    it("runtime: null-observed queued → null while live TPS keeps source live", () => {
      const signals = buildAtomSignals(
        reconciliation({
          runtimeNodes: [
            runtime("runtime:h:r", {
              outputTokensPerSecond: observed(200),
              queuedJobs: observed(null),
              activeJobs: observed(null),
            }),
          ],
        })
      );
      const a = atom(signals, "runtime:h:r");
      assert.equal(a.tokensPerSecond, 200);
      assert.equal(a.queuedJobs, null);
      assert.equal(a.activeJobs, null);
      assert.equal(a.source, "live");
    });
  });

  describe("live numeric data present → source 'live'", () => {
    it("runtime: live TPS keeps value + basis + sampledAt", () => {
      const signals = buildAtomSignals(
        reconciliation({
          runtimeNodes: [
            runtime("runtime:h:r", {
              outputTokensPerSecond: observed(321, { basis: "gen:window", sampledAt: 4242 }),
              modelId: "m1",
            }),
          ],
        })
      );
      const a = atom(signals, "runtime:h:r");
      assert.equal(a.tokensPerSecond, 321);
      assert.equal(a.source, "live");
      assert.equal(a.basis, "gen:window");
      assert.equal(a.sampledAt, 4242);
      assert.deepEqual(a.modelIds, ["m1"]);
      assert.equal(a.gpuHasProvenThroughput, false);
    });

    it("provider: live TPS → value + live", () => {
      const signals = buildAtomSignals(
        reconciliation({
          providerNodes: [provider("provider:p", { outputTokensPerSecond: observed(77) })],
        })
      );
      const a = atom(signals, "provider:p");
      assert.equal(a.tokensPerSecond, 77);
      assert.equal(a.source, "live");
    });
  });

  describe("NO TPS splitting across attributedGpuIds", () => {
    it("runtime TPS present + GPU TPS absent → gpu null, no proven throughput", () => {
      const signals = buildAtomSignals(
        reconciliation({
          gpuNodes: [gpu("gpu:h:0")],
          runtimeNodes: [
            runtime("runtime:h:r", {
              outputTokensPerSecond: observed(300),
              modelId: "m1",
              attributedGpuIds: ["gpu:h:0"],
            }),
          ],
        })
      );
      const g = atom(signals, "gpu:h:0");
      const r = atom(signals, "runtime:h:r");
      assert.equal(g.tokensPerSecond, null);
      assert.equal(g.gpuHasProvenThroughput, false);
      assert.equal(r.tokensPerSecond, 300);
      // The GPU still gets the verified model via attribution, but NOT the TPS.
      assert.deepEqual(g.modelIds, ["m1"]);
    });

    it("both present → each keeps its own value, never averaged", () => {
      // If a runtime TPS were (wrongly) split across its 2 attributed GPUs,
      // each GPU would show 300 / 2 = 150. The per-device values here (120 /
      // 90) prove each GPU is driven only by its own measurement.
      const signals = buildAtomSignals(
        reconciliation({
          gpuNodes: [
            gpu("gpu:h:0", { outputTokensPerSecond: observed(120) }),
            gpu("gpu:h:1", { outputTokensPerSecond: observed(90) }),
          ],
          runtimeNodes: [
            runtime("runtime:h:r", {
              outputTokensPerSecond: observed(300),
              attributedGpuIds: ["gpu:h:0", "gpu:h:1"],
            }),
          ],
        })
      );
      assert.equal(atom(signals, "runtime:h:r").tokensPerSecond, 300);
      assert.equal(atom(signals, "gpu:h:0").tokensPerSecond, 120);
      assert.equal(atom(signals, "gpu:h:1").tokensPerSecond, 90);
      assert.equal(atom(signals, "gpu:h:0").gpuHasProvenThroughput, true);
      assert.equal(atom(signals, "gpu:h:1").gpuHasProvenThroughput, true);
    });
  });

  describe("model→GPU derivation via attributedGpuIds (verified only)", () => {
    it("derives GPU models from runtime attribution, deduped and multi-GPU", () => {
      const signals = buildAtomSignals(
        reconciliation({
          gpuNodes: [gpu("gpu:h:0"), gpu("gpu:h:1")],
          runtimeNodes: [
            runtime("runtime:h:r1", { modelId: "m1", attributedGpuIds: ["gpu:h:0"] }),
            runtime("runtime:h:r2", { modelId: "m2", attributedGpuIds: ["gpu:h:0", "gpu:h:1"] }),
            // same model re-attributed to gpu0 → must not duplicate
            runtime("runtime:h:r3", { modelId: "m1", attributedGpuIds: ["gpu:h:0"] }),
            // no attribution → contributes no model to any GPU
            runtime("runtime:h:r4", { modelId: "m4", attributedGpuIds: [] }),
            // no modelId → contributes nothing
            runtime("runtime:h:r5", { attributedGpuIds: ["gpu:h:1"] }),
          ],
        })
      );
      assert.deepEqual(atom(signals, "gpu:h:0").modelIds, ["m1", "m2"]);
      assert.deepEqual(atom(signals, "gpu:h:1").modelIds, ["m2"]);
      // A runtime keeps its own verified model even with no attribution.
      assert.deepEqual(atom(signals, "runtime:h:r4").modelIds, ["m4"]);
    });

    it("provider atoms never get models even when a runtime claims attribution to none", () => {
      const signals = buildAtomSignals(
        reconciliation({
          providerNodes: [provider("provider:p")],
          runtimeNodes: [runtime("runtime:h:r", { modelId: "m1", attributedGpuIds: [] })],
        })
      );
      assert.deepEqual(atom(signals, "provider:p").modelIds, []);
    });
  });

  describe("edges + passthrough", () => {
    it("copies proven edges 1:1, preserving relation, basis and sampledAt", () => {
      const signals = buildAtomSignals(
        reconciliation({
          gpuNodes: [gpu("gpu:h:0")],
          runtimeNodes: [runtime("runtime:h:r")],
          providerNodes: [provider("provider:p")],
          edges: [
            edge("provider:p", "runtime:h:r", "provider_runtime", "conn", 555),
            edge("runtime:h:r", "gpu:h:0", "runtime_device", "attributed", 666),
            edge("runtime:h:r", "model:m1", "runtime_model", "sample", 777),
          ],
          providerCentricFallback: true,
          capturedAt: 12345,
        })
      );
      assert.deepEqual(signals.edges, [
        {
          sourceId: "provider:p",
          targetId: "runtime:h:r",
          relation: "provider_runtime",
          basis: "conn",
          sampledAt: 555,
        },
        {
          sourceId: "runtime:h:r",
          targetId: "gpu:h:0",
          relation: "runtime_device",
          basis: "attributed",
          sampledAt: 666,
        },
        {
          sourceId: "runtime:h:r",
          targetId: "model:m1",
          relation: "runtime_model",
          basis: "sample",
          sampledAt: 777,
        },
      ]);
      assert.equal(signals.providerCentricFallback, true);
      assert.equal(signals.capturedAt, 12345);
    });
  });
});

describe("mergeDemoSignals", () => {
  it("returns demo (atoms stamped 'demo') when demo carries atoms", () => {
    const live = buildAtomSignals(
      reconciliation({
        gpuNodes: [gpu("gpu:live:0", { outputTokensPerSecond: observed(11) })],
        capturedAt: 1,
      })
    );
    const demo = buildAtomSignals(
      reconciliation({
        gpuNodes: [gpu("gpu:demo:0", { outputTokensPerSecond: observed(99, { basis: "demo" }) })],
        capturedAt: 2,
      })
    );
    const merged = mergeDemoSignals(live, demo);
    assert.equal(merged.perAtom.size, 1);
    const demoAtom = merged.perAtom.get("gpu:demo:0");
    assert.ok(demoAtom);
    assert.equal(demoAtom.source, "demo");
    assert.equal(demoAtom.tokensPerSecond, 99);
    assert.equal(demoAtom.basis, "demo");
    assert.equal(merged.capturedAt, 2);
    assert.equal(merged.providerCentricFallback, false);
    // The live atom is not mixed in.
    assert.equal(merged.perAtom.has("gpu:live:0"), false);
    // The demo input is not mutated.
    assert.equal(demo.perAtom.get("gpu:demo:0")?.source, "live");
  });

  it("returns live (unchanged) when demo has no atoms", () => {
    const live = buildAtomSignals(
      reconciliation({
        gpuNodes: [gpu("gpu:live:0", { outputTokensPerSecond: observed(11) })],
        edges: [edge("provider:p", "runtime:h:r", "provider_runtime", "conn", 555)],
        capturedAt: 4242,
        providerCentricFallback: true,
      })
    );
    const demo = buildAtomSignals(reconciliation({}));
    const merged = mergeDemoSignals(live, demo);
    assert.equal(merged.perAtom.size, 1);
    assert.equal(merged.perAtom.get("gpu:live:0")?.source, "live");
    assert.equal(merged.capturedAt, 4242);
    assert.equal(merged.providerCentricFallback, true);
    assert.equal(merged.edges.length, 1);
  });
});
