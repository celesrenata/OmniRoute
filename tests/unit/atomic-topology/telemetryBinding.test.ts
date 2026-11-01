/**
 * Atomic topology — fleet-telemetry descriptor binding (OR-ATOM-005 — T5.4).
 *
 * Covers the `resolveAtomDescriptors` seam that binds the *measured* fleet
 * reconciliation to the visual descriptors:
 *   - NO reconciliation → byte-identical to the M1 baseline (honest
 *     "unavailable" spin/vibration, no device atoms, no fleetSampledAt);
 *   - measured provider TPS → provider spin `mode: "measured"` (the intended
 *     T5.4 behavior change — providers that previously spun "unavailable" now
 *     animate when real TPS is present);
 *   - measured provider queue → provider vibration `mode: "measured"`;
 *   - stale / null Observed facts → "unavailable" (never fabricated as 0);
 *   - device atoms appended in the outer band (rings beyond the providers)
 *     with proven `deviceFacts`; absent facts stay `null`, never `0`.
 *
 * OR-ATOM-009 W2 — proven attribution from `reconciliation.edges`:
 *   - a GPU with EXACTLY ONE proven runtime on it (runtime_device edge)
 *     inherits that runtime's model / queue / active-jobs / spin fallback;
 *   - multi-runtime GPUs never inherit aggregate values (no even split);
 *   - a runtime carries its providerId ONLY from a proven
 *     provider_runtime edge — GPUs stay provider-unattached;
 *   - absent / stale / unproven joins -> `null` / `"unknown"`, never invented.
 *
 * Pure — no DOM, no WebGL, no clock.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAtomDescriptors, resolveLinkDescriptors } from "@/plugins/atomic-topology";
import { SPIN_REFERENCE_TPS } from "@/plugins/atomic-topology/AtomicTopologyRenderer";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";
import type {
  ReconciliationResult,
  ReconciledGpuNode,
  ReconciledRuntimeNode,
} from "@/shared/topology/telemetry/reconcile";
import type { Observed } from "@/shared/topology/telemetry/types";

const T = 1_700_000_000_000;

function obs(value: number | null, opts: Partial<Observed<number>> = {}): Observed<number> {
  return {
    value,
    source: "derived",
    sampledAt: T,
    ...opts,
  };
}

/** The canonical hub + two provider snapshot (no reconciliation). */
function makeSnapshot(extra?: Partial<TopologySceneSnapshot>): TopologySceneSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: T,
    links: [
      {
        id: "route:openai",
        source: "hub",
        target: "provider:openai",
        kind: "route",
        health: "healthy",
        traffic: "active",
      },
      {
        id: "route:anthropic",
        source: "hub",
        target: "provider:anthropic",
        kind: "route",
        health: "healthy",
        traffic: "idle",
      },
    ],
    nodes: [
      { id: "hub", kind: "hub", label: "Router", health: "healthy", traffic: "idle" },
      {
        id: "provider:openai",
        kind: "provider",
        label: "OpenAI",
        providerId: "openai",
        health: "healthy",
        traffic: "active",
      },
      {
        id: "provider:anthropic",
        kind: "provider",
        label: "Anthropic",
        providerId: "anthropic",
        health: "healthy",
        traffic: "idle",
      },
    ],
    ...extra,
  };
}

/**
 * A reconciliation with one GPU, one runtime, and measured provider facts.
 * An explicit `null` in `opts` means "Observed with a null value" (a real
 * observation of absence); an omitted key means "field not present at all".
 * (A `?? default` here would conflate the two — hence the `!== undefined`.)
 */
function makeReconciliation(
  opts: {
    gpuStale?: boolean;
    runtimeStale?: boolean;
    providerTps?: number | null;
    providerQueue?: number | null;
    runtimeQueue?: number | null;
    gpuTps?: number | null;
  } = {}
): ReconciliationResult {
  const gpu: ReconciledGpuNode = {
    resourceId: "gpu:h1:uuid-1",
    hostId: "h1",
    deviceUuid: "uuid-1",
    utilizationPercent: obs(66),
    vramUsedBytes: obs(4e9),
    vramTotalBytes: obs(16e9),
    temperatureC: obs(55),
    powerWatts: obs(220),
    outputTokensPerSecond: obs(opts.gpuTps !== undefined ? opts.gpuTps : 12),
    stale: opts.gpuStale ?? false,
  };
  const runtime: ReconciledRuntimeNode = {
    resourceId: "runtime:h1:cuda-0",
    hostId: "h1",
    runtimeId: "cuda-0",
    modelId: "llama-3-70b",
    outputTokensPerSecond: obs(9),
    queuedJobs: obs(opts.runtimeQueue !== undefined ? opts.runtimeQueue : 3),
    activeJobs: obs(2),
    attributedGpuIds: ["gpu:h1:uuid-1"],
    stale: opts.runtimeStale ?? false,
  };
  return {
    schemaVersion: 1,
    capturedAt: T + 1000,
    gpuNodes: [gpu],
    runtimeNodes: [runtime],
    providerNodes: [
      {
        resourceId: "provider:openai",
        providerId: "openai",
        outputTokensPerSecond: obs(opts.providerTps !== undefined ? opts.providerTps : 12),
        queuedJobs: obs(opts.providerQueue !== undefined ? opts.providerQueue : 2),
        stale: false,
      },
    ],
    edges: [
      {
        source: "provider:openai",
        target: "runtime:h1:cuda-0",
        relation: "provider_runtime",
        basis: "metrics-join",
        sampledAt: T,
      },
      {
        source: "runtime:h1:cuda-0",
        target: "gpu:h1:uuid-1",
        relation: "runtime_device",
        basis: "metrics-join",
        sampledAt: T,
      },
    ],
    providerCentricFallback: false,
  };
}

function fingerprint(descriptors: ReturnType<typeof resolveAtomDescriptors>): unknown {
  return descriptors.map((d) => ({
    id: d.id,
    kind: d.kind,
    label: d.label,
    providerId: d.providerId ?? null,
    position: d.position,
    color: d.color,
    modelColors: d.modelColors,
    lane: d.lane,
    laneHue: d.laneHue,
    spin: d.spin,
    vibration: d.vibration,
    visualState: d.visualState,
    activeRequests: d.activeRequests,
    ringIndex: d.ringIndex,
    deviceFacts: d.deviceFacts ?? null,
    fleetSampledAt: d.fleetSampledAt ?? null,
  }));
}

/* ------------------------------------------------------------------ */
/* No reconciliation → byte-identical M1 baseline                     */
/* ------------------------------------------------------------------ */

test("no reconciliation: spin/vibration are 'unavailable', no device atoms, no fleetSampledAt", () => {
  const snapshot = makeSnapshot();
  const base = resolveAtomDescriptors(snapshot);

  assert.equal(base.length, 3, "hub + 2 providers, no device atoms");
  assert.ok(
    base.every((d) => d.kind !== "gpu" && d.kind !== "runtime"),
    "no device descriptors without a reconciliation"
  );

  for (const d of base) {
    assert.deepEqual(
      d.spin,
      { value: 0.1, mode: "unavailable" },
      `${d.id} spin is the honest M1 'unavailable' baseline`
    );
    assert.deepEqual(
      d.vibration,
      { amplitude: 0, frequencyHz: 0, mode: "unavailable" },
      `${d.id} vibration is the honest M1 'unavailable' baseline`
    );
    assert.equal(d.fleetSampledAt, null, `${d.id} has no fleet sample anchor`);
    assert.equal(d.deviceFacts, undefined, `${d.id} has no device facts`);
  }
});

test("no reconciliation: snapshot.fleetTelemetry = null behaves identically to absent", () => {
  const a = resolveAtomDescriptors(makeSnapshot());
  const b = resolveAtomDescriptors(makeSnapshot({ fleetTelemetry: null }));
  assert.deepEqual(fingerprint(b), fingerprint(a), "null reconciliation === absent");
});

/* ------------------------------------------------------------------ */
/* Measured provider binding (the intended T5.4 behavior change)      */
/* ------------------------------------------------------------------ */

test("measured provider TPS → provider spin is 'measured' (T5.4 behavior change)", () => {
  const snapshot = makeSnapshot({ fleetTelemetry: makeReconciliation({ providerTps: 12 }) });
  const descriptors = resolveAtomDescriptors(snapshot);

  const openai = descriptors.find((d) => d.id === "provider:openai")!;
  assert.equal(openai.spin.mode, "measured", "openai spin bound to measured TPS");
  assert.ok(
    openai.spin.value > 0.1 && openai.spin.value < 0.1 + 1.65,
    "measured spin within [0.1, 1.75]"
  );
  // Monotonic: a faster provider spins faster than a slower one.
  const slow = makeReconciliation({ providerTps: 2 });
  const descriptorsSlow = resolveAtomDescriptors(makeSnapshot({ fleetTelemetry: slow }));
  const slowOpenai = descriptorsSlow.find((d) => d.id === "provider:openai")!;
  assert.ok(openai.spin.value > slowOpenai.spin.value, "TPS 12 spins faster than TPS 2");
});

test("measured provider queue → provider vibration is 'measured'", () => {
  const snapshot = makeSnapshot({
    fleetTelemetry: makeReconciliation({ providerQueue: 4 }),
  });
  // The reconciliation only carries provider:openai; its queuedJobs is 2.
  // (providerQueued controls the RUNTIME's queue; provider queued is fixed 2 here.)
  const descriptors = resolveAtomDescriptors(snapshot);
  const openai = descriptors.find((d) => d.id === "provider:openai")!;
  assert.equal(openai.vibration.mode, "measured", "openai vibration bound to measured queue");
  assert.ok(openai.vibration.amplitude > 0, "nonzero queue → nonzero amplitude");
  // Providers without a reconciliation entry keep the honest baseline.
  const anthropic = descriptors.find((d) => d.id === "provider:anthropic")!;
  assert.equal(anthropic.vibration.mode, "unavailable", "no entry → still unavailable");
});

test("provider with null Observed value → stays 'unavailable' (never fabricated 0)", () => {
  const snapshot = makeSnapshot({
    fleetTelemetry: makeReconciliation({ providerTps: null, providerQueue: null }),
  });
  const descriptors = resolveAtomDescriptors(snapshot);
  const openai = descriptors.find((d) => d.id === "provider:openai")!;
  assert.equal(openai.spin.mode, "unavailable", "null value → unavailable, not measured-zero");
  assert.equal(openai.vibration.mode, "unavailable");
});

test("measured-zero provider TPS → spin 'measured-zero' (observed quiet, not unavailable)", () => {
  const snapshot = makeSnapshot({ fleetTelemetry: makeReconciliation({ providerTps: 0 }) });
  const descriptors = resolveAtomDescriptors(snapshot);
  const openai = descriptors.find((d) => d.id === "provider:openai")!;
  assert.equal(openai.spin.mode, "measured-zero", "real 0 → observed quiet");
  assert.equal(openai.spin.value, 0.1);
});

/* ------------------------------------------------------------------ */
/* Device atoms                                                        */
/* ------------------------------------------------------------------ */

test("device atoms appended in the outer band with proven facts", () => {
  const snapshot = makeSnapshot({ fleetTelemetry: makeReconciliation() });
  const descriptors = resolveAtomDescriptors(snapshot);

  assert.equal(descriptors.length, 5, "3 + 1 gpu + 1 runtime");
  const gpu = descriptors.find((d) => d.id === "gpu:h1:uuid-1");
  const runtime = descriptors.find((d) => d.id === "runtime:h1:cuda-0");
  assert.ok(gpu, "gpu device atom present");
  assert.ok(runtime, "runtime device atom present");

  // Devices are beyond every provider ring.
  const providerRings = descriptors.filter((d) => d.kind === "provider").map((d) => d.ringIndex);
  assert.ok(
    Math.max(gpu!.ringIndex, runtime!.ringIndex) > Math.max(...providerRings, 0) ||
      (Math.min(...providerRings) === 0 && gpu!.ringIndex === 0),
    "device ring is at least the max provider ring"
  );

  // Proven GPU facts: own measured fields, plus the single-runtime
  // attribution (W2 — one runtime_device edge proves unambiguous ownership,
  // so the GPU inherits that runtime's queue/jobs/model; never a split).
  assert.deepEqual(gpu!.deviceFacts, {
    kind: "gpu",
    utilizationPercent: 66,
    vramUsedBytes: 4e9,
    vramTotalBytes: 16e9,
    temperatureC: 55,
    powerWatts: 220,
    queuedJobs: 3,
    activeJobs: 2,
    modelId: "llama-3-70b",
  });
  // Proven runtime facts + model color.
  assert.equal(runtime!.deviceFacts?.kind, "runtime");
  assert.equal(runtime!.deviceFacts?.queuedJobs, 3);
  assert.equal(runtime!.deviceFacts?.activeJobs, 2);
  assert.equal(runtime!.deviceFacts?.modelId, "llama-3-70b");
  assert.ok(runtime!.modelColors.length === 1, "runtime nucleus colored by its model");

  // W2 / S9.1 proven linkage: the runtime carries its proven
  // provider_runtime edge; the GPU stays provider-unattached (its provider
  // connection is only transitive through its runtime — never drawn directly).
  assert.equal(runtime!.providerId, "openai", "runtime proven to provider:openai");
  assert.equal(gpu!.providerId, undefined, "gpu stays provider-unattached");
  // W2 / S9.3: the gpu's model identity comes from the proven on-GPU
  // runtime; an unclassifiable model id keeps the honest "unknown" lane.
  assert.deepEqual(gpu!.observedModelIds, ["llama-3-70b"], "gpu models from proven residency");
  assert.equal(gpu!.modelColors.length, 1, "gpu nucleus colored by the proven model");
  assert.equal(gpu!.lane, "unknown", "unclassifiable model -> unknown lane (never fabricated)");

  // Device spin/vibration bound to their own measured facts.
  assert.equal(gpu!.spin.mode, "measured", "gpu spin from its measured TPS");
  assert.equal(runtime!.vibration.mode, "measured", "runtime vibration from its pending queue");

  // Fleet sample anchor on every descriptor.
  assert.ok(descriptors.every((d) => d.fleetSampledAt === T + 1000));
});

test("stale device node → spin/vibration 'unavailable' and facts null (never decayed values)", () => {
  const snapshot = makeSnapshot({
    fleetTelemetry: makeReconciliation({ gpuStale: true }),
  });
  const descriptors = resolveAtomDescriptors(snapshot);
  const gpu = descriptors.find((d) => d.id === "gpu:h1:uuid-1")!;
  assert.equal(gpu.spin.mode, "unavailable", "stale gpu → unavailable spin");
  assert.equal(gpu.deviceFacts?.utilizationPercent, null, "stale → fact is null, not a value");
  assert.equal(gpu.deviceFacts?.vramUsedBytes, null);
  assert.equal(gpu.deviceFacts?.temperatureC, null);
  // The runtime is fresh: it keeps its measured queue.
  const runtime = descriptors.find((d) => d.id === "runtime:h1:cuda-0")!;
  assert.equal(runtime.vibration.mode, "measured");
  assert.equal(runtime.deviceFacts?.queuedJobs, 3);
});

test("device facts with null Observed values → null (absent facts are not 0)", () => {
  const recon = makeReconciliation();
  recon.gpuNodes[0].utilizationPercent = obs(null);
  delete recon.gpuNodes[0].powerWatts;
  const snapshot = makeSnapshot({ fleetTelemetry: recon });
  const descriptors = resolveAtomDescriptors(snapshot);
  const gpu = descriptors.find((d) => d.id === "gpu:h1:uuid-1")!;
  assert.equal(gpu.deviceFacts?.utilizationPercent, null, "obs(null) → null");
  assert.equal(gpu.deviceFacts?.powerWatts, null, "missing field → null");
  assert.equal(gpu.deviceFacts?.temperatureC, 55, "other facts unaffected");
});

test("reorder of reconciliation arrays → identical device descriptors (determinism)", () => {
  const recon = makeReconciliation();
  const gpu2 = { ...recon.gpuNodes[0], resourceId: "gpu:h2:uuid-2", deviceUuid: "uuid-2" };
  const rt2 = {
    ...recon.runtimeNodes[0],
    resourceId: "runtime:h2:cuda-1",
    runtimeId: "cuda-1",
  };
  recon.gpuNodes = [gpu2, recon.gpuNodes[0]];
  recon.runtimeNodes = [rt2, recon.runtimeNodes[0]];

  const a = resolveAtomDescriptors(makeSnapshot({ fleetTelemetry: recon }));
  const reconB = structuredClone(recon);
  reconB.gpuNodes.reverse();
  reconB.runtimeNodes.reverse();
  const b = resolveAtomDescriptors(makeSnapshot({ fleetTelemetry: reconB }));

  const fingerprintDevices = (ds: typeof a) =>
    ds
      .filter((d) => d.kind === "gpu" || d.kind === "runtime")
      .map((d) => [d.id, d.position, d.ringIndex, d.spin, d.vibration])
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  assert.deepEqual(fingerprintDevices(b), fingerprintDevices(a), "reorder → same devices");
});

test("spin reference constant is the module's documented value", () => {
  assert.equal(SPIN_REFERENCE_TPS, 24);
});

/* ------------------------------------------------------------------ */
/* OR-ATOM-009 W2 — proven attribution from reconciliation edges       */
/* ------------------------------------------------------------------ */

test("W2: classifiable on-GPU model -> gpu + runtime carry the lane and the model color", () => {
  const recon = makeReconciliation();
  recon.runtimeNodes[0].modelId = "text-embedding-3-small";
  const snapshot = makeSnapshot({ fleetTelemetry: recon });
  const descriptors = resolveAtomDescriptors(snapshot);
  const gpu = descriptors.find((d) => d.id === "gpu:h1:uuid-1")!;
  const runtime = descriptors.find((d) => d.id === "runtime:h1:cuda-0")!;

  assert.deepEqual(gpu.observedModelIds, ["text-embedding-3-small"]);
  assert.deepEqual(runtime.observedModelIds, ["text-embedding-3-small"]);
  assert.equal(gpu.lane, "embedding", "lane derived from the proven on-GPU model");
  assert.equal(gpu.laneHue, "#A78BFA", "embedding lane hue (pinned palette)");
  assert.equal(runtime.lane, "embedding", "runtime lane from its own model");
  assert.equal(gpu.deviceFacts?.modelId, "text-embedding-3-small");
  // Both nuclei share the single proven model color.
  assert.deepEqual(gpu.modelColors, runtime.modelColors);
  assert.equal(gpu.modelColors.length, 1);
});

test("W2: multi-runtime gpu -> no even split (proven model union, own facts only)", () => {
  const recon = makeReconciliation({ gpuTps: null });
  const rt2: ReconciledRuntimeNode = {
    resourceId: "runtime:h1:cuda-1",
    hostId: "h1",
    runtimeId: "cuda-1",
    modelId: "gpt-4o-mini",
    outputTokensPerSecond: obs(15),
    queuedJobs: obs(4),
    activeJobs: obs(1),
    attributedGpuIds: ["gpu:h1:uuid-1"],
    stale: false,
  };
  recon.runtimeNodes.push(rt2);
  // Prove BOTH runtimes on the SAME gpu (attribution is ambiguous).
  recon.edges.push({
    source: "runtime:h1:cuda-1",
    target: "gpu:h1:uuid-1",
    relation: "runtime_device",
    basis: "metrics-join",
    sampledAt: T,
  });
  const gpu = resolveAtomDescriptors(makeSnapshot({ fleetTelemetry: recon })).find(
    (d) => d.id === "gpu:h1:uuid-1"
  )!;

  // Models: the proven union of both runtimes (sorted; capped at 3 elsewhere).
  assert.deepEqual(gpu.observedModelIds, ["gpt-4o-mini", "llama-3-70b"]);
  assert.equal(gpu.modelColors.length, 2, "nucleus shows both proven models");
  // Queue/jobs: NOT split across the two runtimes — the gpu has no own
  // measurement, so it shows null (unavailable), never an averaged value.
  assert.equal(gpu.deviceFacts?.queuedJobs, null, "multi-runtime -> no queue split");
  assert.equal(gpu.deviceFacts?.activeJobs, null, "multi-runtime -> no active-job split");
  // Spin/vibration: no own TPS + ambiguous attribution -> unavailable (never a split).
  assert.equal(gpu.spin.mode, "unavailable", "multi-runtime -> no spin split");
  assert.equal(gpu.vibration.mode, "unavailable", "multi-runtime -> no vibration split");
});

test("W2: unproven joins -> no attribution (absent edges are never invented)", () => {
  const recon = makeReconciliation();
  recon.edges = []; // strip EVERY proven edge
  const snapshot = makeSnapshot({ fleetTelemetry: recon });
  const descriptors = resolveAtomDescriptors(snapshot);
  const gpu = descriptors.find((d) => d.id === "gpu:h1:uuid-1")!;
  const runtime = descriptors.find((d) => d.id === "runtime:h1:cuda-0")!;

  // No runtime_device edge -> the runtime's model/queue is NOT attributed
  // to the gpu, even though the runtime itself still shows its own facts.
  assert.deepEqual(gpu.observedModelIds, [], "no proven residency -> no gpu models");
  assert.equal(gpu.deviceFacts?.queuedJobs, null);
  assert.equal(gpu.deviceFacts?.activeJobs, null);
  assert.equal(gpu.deviceFacts?.modelId, null);
  assert.equal(gpu.lane, "unknown");
  // The runtime keeps its OWN measured facts (own facts are not attribution).
  assert.equal(runtime.deviceFacts?.queuedJobs, 3);
  assert.equal(runtime.deviceFacts?.modelId, "llama-3-70b");
  assert.deepEqual(runtime.observedModelIds, ["llama-3-70b"]);
  // No provider_runtime edge -> the runtime stays provider-unattached.
  assert.equal(runtime.providerId, undefined, "no edge -> no provider attribution");
});

test("W2: stale runtime -> its attribution to the gpu is never shown (stale -> unavailable)", () => {
  const snapshot = makeSnapshot({
    fleetTelemetry: makeReconciliation({ runtimeStale: true }),
  });
  const descriptors = resolveAtomDescriptors(snapshot);
  const gpu = descriptors.find((d) => d.id === "gpu:h1:uuid-1")!;

  // The gpu is FRESH: it still spins from its own measured TPS.
  assert.equal(gpu.spin.mode, "measured", "fresh gpu keeps its own spin");
  // ...but the stale runtime contributes nothing to it.
  assert.deepEqual(gpu.observedModelIds, [], "stale runtime -> no model attribution");
  assert.equal(gpu.deviceFacts?.queuedJobs, null, "stale runtime queue is not shown on the gpu");
  assert.equal(gpu.deviceFacts?.activeJobs, null);
  assert.equal(gpu.deviceFacts?.modelId, null);
  assert.equal(gpu.vibration.mode, "unavailable");
  // The stale runtime itself also reads unavailable.
  const runtime = descriptors.find((d) => d.id === "runtime:h1:cuda-0")!;
  assert.equal(runtime.spin.mode, "unavailable");
  assert.equal(runtime.deviceFacts?.queuedJobs, null);
  assert.equal(runtime.deviceFacts?.modelId, null);
});

/* ------------------------------------------------------------------ */
/* OR-ATOM-009 S9.2 — measuredTps (the raw measured TPS the nucleus    */
/* smoothing binds to)                                                 */
/* ------------------------------------------------------------------ */

test("S9.2: measuredTps carries the raw measured TPS — the value the scene smooths", () => {
  const snapshot = makeSnapshot({ fleetTelemetry: makeReconciliation({ providerTps: 12 }) });
  const descriptors = resolveAtomDescriptors(snapshot);

  // Provider: the joined provider sample, verbatim.
  const openai = descriptors.find((d) => d.id === "provider:openai")!;
  assert.equal(openai.measuredTps, 12, "provider measuredTps = joined provider TPS");
  // Idle provider with no sample: unknown (never a fabricated 0).
  const anthropic = descriptors.find((d) => d.id === "provider:anthropic")!;
  assert.equal(anthropic.measuredTps, null, "no sample → null, not 0");
  // The hub carries no measured throughput.
  const hub = descriptors.find((d) => d.id === "hub")!;
  assert.equal(hub.measuredTps, null, "hub → null");

  // GPU: its own per-device measured TPS (unambiguous own attribution).
  const gpu = descriptors.find((d) => d.id === "gpu:h1:uuid-1")!;
  assert.equal(gpu.measuredTps, 12, "gpu measuredTps = own measured TPS");
  // Runtime: its own measured TPS.
  const runtime = descriptors.find((d) => d.id === "runtime:h1:cuda-0")!;
  assert.equal(runtime.measuredTps, 9, "runtime measuredTps = own measured TPS");
});

test("S9.2: measuredTps is null when nothing fresh is attributable", () => {
  // Provider sample observed as absent → unknown.
  const snapshot = makeSnapshot({
    fleetTelemetry: makeReconciliation({ providerTps: null }),
  });
  const openai = resolveAtomDescriptors(snapshot).find((d) => d.id === "provider:openai")!;
  assert.equal(openai.measuredTps, null, "null Observed → null (never fabricated 0)");
  assert.equal(openai.spin.mode, "unavailable");

  // GPU with no own per-device TPS → the single proven runtime's TPS (no split).
  const gpuSingle = resolveAtomDescriptors(
    makeSnapshot({ fleetTelemetry: makeReconciliation({ gpuTps: null }) })
  ).find((d) => d.id === "gpu:h1:uuid-1")!;
  assert.equal(gpuSingle.measuredTps, 9, "single-runtime gpu inherits the runtime's TPS");
  assert.equal(gpuSingle.spin.mode, "measured");

  // Multi-runtime GPU: attribution is ambiguous → no measuredTps (no split).
  const recon = makeReconciliation({ gpuTps: null });
  recon.runtimeNodes.push({
    resourceId: "runtime:h1:cuda-1",
    hostId: "h1",
    runtimeId: "cuda-1",
    modelId: "gpt-4o-mini",
    outputTokensPerSecond: obs(15),
    queuedJobs: obs(4),
    activeJobs: obs(1),
    attributedGpuIds: ["gpu:h1:uuid-1"],
    stale: false,
  });
  recon.edges.push({
    source: "runtime:h1:cuda-1",
    target: "gpu:h1:uuid-1",
    relation: "runtime_device",
    basis: "metrics-join",
    sampledAt: T,
  });
  const gpuMulti = resolveAtomDescriptors(makeSnapshot({ fleetTelemetry: recon })).find(
    (d) => d.id === "gpu:h1:uuid-1"
  )!;
  assert.equal(gpuMulti.measuredTps, null, "multi-runtime gpu → no measuredTps (no split)");
  assert.equal(gpuMulti.spin.mode, "unavailable");
});

test("S9.2: a stale device sample decays to null (the nucleus spins down, never holds a fake speed)", () => {
  const gpu = resolveAtomDescriptors(
    makeSnapshot({ fleetTelemetry: makeReconciliation({ gpuStale: true }) })
  ).find((d) => d.id === "gpu:h1:uuid-1")!;
  assert.equal(gpu.measuredTps, null, "stale gpu sample → null");
  assert.equal(gpu.spin.mode, "unavailable", "stale → the spin mode decays too");
});

/* ------------------------------------------------------------------ */
/* OR-ATOM-009 S9.4 — proven pulse gate on the route links            */
/* ------------------------------------------------------------------ */

test("S9.4: every route link whose target provider atom exists is proven (call-log basis)", () => {
  const links = resolveLinkDescriptors(makeSnapshot());
  const openai = links.find((l) => l.id === "route:openai")!;
  const anthropic = links.find((l) => l.id === "route:anthropic")!;
  assert.equal(openai.proven, true, "openai route is proven (atom present)");
  assert.equal(openai.provenBasis, "call-log route");
  assert.equal(anthropic.proven, true, "anthropic route is proven (atom present)");
  assert.equal(anthropic.provenBasis, "call-log route");
});

test("S9.4: a route link without its target provider atom is unproven (never a guess)", () => {
  // Defensively: drop the anthropic atom from the node set — its route link
  // must be unproven (no pulse may ride it), while openai stays proven.
  const snapshot = makeSnapshot();
  snapshot.nodes = snapshot.nodes.filter((n) => n.id !== "provider:anthropic");
  const links = resolveLinkDescriptors(snapshot);
  assert.equal(links.find((l) => l.id === "route:openai")!.proven, true);
  const anthropic = links.find((l) => l.id === "route:anthropic")!;
  assert.equal(anthropic.proven, false, "no target atom → unproven");
  assert.equal(anthropic.provenBasis, "unproven (no target provider atom)");
});

test("S9.4: a fleet-telemetry provider sample strengthens the basis (corroboration, not the basis)", () => {
  const links = resolveLinkDescriptors(makeSnapshot({ fleetTelemetry: makeReconciliation() }));
  const openai = links.find((l) => l.id === "route:openai")!;
  assert.equal(openai.proven, true);
  assert.equal(openai.provenBasis, "call-log route + fleet-metrics");
  // anthropic has a route atom but NO fleet provider sample → call-log basis.
  const anthropic = links.find((l) => l.id === "route:anthropic")!;
  assert.equal(anthropic.proven, true);
  assert.equal(anthropic.provenBasis, "call-log route");
});

test("S9.4: a no-reconciliation snapshot still proves the call-log routes (primary proven segment)", () => {
  const links = resolveLinkDescriptors(makeSnapshot());
  for (const l of links) {
    assert.equal(l.proven, true, `${l.id} is proven from the call-log route alone`);
    assert.equal(l.provenBasis, "call-log route");
  }
});
