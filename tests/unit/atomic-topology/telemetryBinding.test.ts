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
 * Pure — no DOM, no WebGL, no clock.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAtomDescriptors } from "@/plugins/atomic-topology";
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

  // Proven GPU facts (measured — not fabricated).
  assert.deepEqual(gpu!.deviceFacts, {
    kind: "gpu",
    utilizationPercent: 66,
    vramUsedBytes: 4e9,
    vramTotalBytes: 16e9,
    temperatureC: 55,
    powerWatts: 220,
    queuedJobs: null,
    activeJobs: null,
    modelId: null,
  });
  // Proven runtime facts + model color.
  assert.equal(runtime!.deviceFacts?.kind, "runtime");
  assert.equal(runtime!.deviceFacts?.queuedJobs, 3);
  assert.equal(runtime!.deviceFacts?.activeJobs, 2);
  assert.equal(runtime!.deviceFacts?.modelId, "llama-3-70b");
  assert.ok(runtime!.modelColors.length === 1, "runtime nucleus colored by its model");

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
