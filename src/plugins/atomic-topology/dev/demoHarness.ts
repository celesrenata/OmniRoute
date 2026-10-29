/**
 * Developer-only demo harness — deterministic fleet-telemetry scenario fixtures
 * (OR-ATOM-009 / Phase 2, W3).
 *
 * PURE module: no DOM, no WebGL, no React, no `Math.random` — every value is a
 * function of `(scenario, now)`, seeded by the caller-supplied `now` epoch-ms
 * (a counter or hash is fine). `build()` NEVER mutates the scenario or the
 * resources it returns (a second `build(now)` yields an independent copy).
 *
 * The fixtures are shaped to flow through the REAL telemetry data path:
 * `GET /api/telemetry/fleet` response shape → `FleetTelemetryPoller` (which
 * keeps last-good on transient error and marks a response stale once its
 * `capturedAt` is older than `staleWindowMs`, default 10 000 ms) →
 * `snapshot.fleetTelemetry` on `TopologySceneSnapshot` →
 * `resolveAtomDescriptors()` in
 * `src/plugins/atomic-topology/AtomicTopologyRenderer.tsx`. They are valid
 * `FleetResourceObservation[]` payloads (see
 * `src/shared/topology/telemetry/types.ts`) whose `resourceId` is built ONLY
 * through `buildCanonicalResourceId()` — `gpu:<hostId>:<deviceUuid>`,
 * `runtime:<hostId>:<runtimeId>`, `provider:<providerKey>`. No display labels,
 * no bare PCI indices, no guessed identities.
 *
 * Scenario ids map 1:1 to the rows of `OR_ATOM_009/VALIDATION_MATRIX.md`:
 * idle, unknown-stale, tps-20, tps-80, queued-jobs, mixed-lanes, completion,
 * failed-request, multi-runtime-gpu.
 *
 * `expectedSignals` is written so Phase 4 can assert that the RENDERED signals
 * match the snapshot: per-resource-id `{ tokensPerSecond, queuedJobs,
 * modelIds, gpuHasProvenThroughput }`. `value` is the literal `Observed.value`
 * the snapshot carries (`null` = observed-absent — strictly different from the
 * field not existing on the resource — a literal `0` is a real measured
 * zero). `modelIds: null` asserts the field is ABSENT; `[]` asserts present
 * but empty. `gpuHasProvenThroughput: true` asserts the resource has an
 * `Observed` throughput whose source is proven live data (an explicit `false`
 * is also allowed). `expectedReconciled` additionally pins what
 * `reconcileSnapshot()` must emit (device-edge counts, node facts,
 * `providerCentricFallback`) so the provenance panel's edge counts can be
 * asserted without re-deriving the rule.
 */
import type {
  FleetResourceObservation,
  FleetTelemetrySnapshot,
} from "@/shared/topology/telemetry/types";
import { buildCanonicalResourceId } from "@/shared/topology/telemetry/types";
import type { ReconciliationEdge } from "@/shared/topology/telemetry/reconcile";

/** The scenario ids, in VALIDATION_MATRIX row order. */
export const DEMO_SCENARIO_IDS = [
  "idle",
  "unknown-stale",
  "tps-20",
  "tps-80",
  "queued-jobs",
  "mixed-lanes",
  "completion",
  "failed-request",
  "multi-runtime-gpu",
] as const;

export type DemoScenarioId = (typeof DEMO_SCENARIO_IDS)[number];

/** One canonical id + the per-resource-id signal expectations for a scenario. */
export interface DemoSignalExpectation {
  /** Measured TPS — the literal `Observed.outputTokensPerSecond.value`, or
   * `null` when the snapshot carries the field as observed-absent. */
  tokensPerSecond: number | null;
  /** Measured queued jobs — the literal `Observed.queuedJobs.value`, or `null`
   * when the snapshot carries the field as observed-absent. */
  queuedJobs: number | null;
  /** `null` → the `modelId` fact is ABSENT on the resource; an array → the
   * exact value (one id per runtime row, by the snapshot's one-row-per-runtime
   * convention). */
  modelIds: string[] | null;
  /** `true` → the resource's throughput `Observed` is present AND its source
   * is proven live data (`"omniroute-live"` / `"omniroute-call-log"` /
   * `"runtime"`). The default (absent) asserts nothing about the source. */
  gpuHasProvenThroughput?: boolean;
}

/**
 * A per-scenario expectation: `resourceId → DemoSignalExpectation`, written so
 * Phase 4 asserts the rendered signals equal the snapshot's own `Observed`
 * values (no W1 contract required — the harness is self-checking).
 */
export type DemoExpectedSignals = Record<string, DemoSignalExpectation>;

/**
 * Pinned `reconcileSnapshot()` facts for a scenario (all optional — only what
 * the scenario's provenance rule actually exercises).
 */
export interface DemoReconciledExpectation {
  /** Exact `(relation, source, target)` tuples emitted by `reconcileSnapshot`. */
  edges: Array<{ relation: ReconciliationEdge["relation"]; source: string; target: string }>;
  /** Proven-GPU count (0 → provider-centric fallback). */
  gpuNodeCount: number;
  /** Exact runtime-node facts (present when a scenario must prove attribution). */
  runtimeNodes?: Array<{
    resourceId: string;
    attributedGpuIds: string[];
    outputTokensPerSecond: number | null;
    modelId?: string;
  }>;
  /** `ReconciliationResult.providerCentricFallback` (true when no GPU observed). */
  providerCentricFallback: boolean;
}

/** One deterministic demo scenario. */
export interface DemoScenario {
  /** Stable scenario id (see `DEMO_SCENARIO_IDS`). */
  id: DemoScenarioId;
  /** Which VALIDATION_MATRIX row this scenario fills. */
  description: string;
  /** Deterministically build the snapshot's resource observations for `now`. */
  build(now: number): FleetResourceObservation[];
  /** The per-resource-id expectations Phase 4 asserts against the snapshot. */
  expectedSignals: DemoExpectedSignals;
  /** Pinned `reconcileSnapshot()` facts for this scenario. */
  expectedReconciled: DemoReconciledExpectation;
}

/* Shared demo identity facts (stable, canonical — never display labels). */
const HOST_ID = "demo-host";
const DEVICE_UUID_A = "dev-uuid-a";
const DEVICE_UUID_B = "dev-uuid-b";
const RUNTIME_ID_A = "rt-demo-a";
const RUNTIME_ID_B = "rt-demo-b";
const PROVIDER_KEY = "demo-provider";

/** Canonical ids (built through the ONLY sanctioned constructor). */
const GPU_ID_A = buildCanonicalResourceId("gpu", DEVICE_UUID_A, HOST_ID);
const GPU_ID_B = buildCanonicalResourceId("gpu", DEVICE_UUID_B, HOST_ID);
const RUNTIME_ID_A_CANON = buildCanonicalResourceId("runtime", RUNTIME_ID_A, HOST_ID);
const RUNTIME_ID_B_CANON = buildCanonicalResourceId("runtime", RUNTIME_ID_B, HOST_ID);
const PROVIDER_ID_CANON = buildCanonicalResourceId("provider", PROVIDER_KEY);

const PROVEN_LIVE_SOURCES = new Set(["omniroute-live", "omniroute-call-log", "runtime"]);

/** Build the full demo `FleetTelemetrySnapshot` (the wire shape the poller
 * consumes — `{ snapshot }` of `GET /api/telemetry/fleet`). */
export function buildDemoSnapshot(scenario: DemoScenario, now: number): FleetTelemetrySnapshot {
  return {
    schemaVersion: 1,
    capturedAt: now,
    resources: scenario.build(now),
  };
}

/** Human-readable scenario id → description map (for capture labeling). */
export function demoScenarioDescriptions(): Record<DemoScenarioId, string> {
  const out = {} as Record<DemoScenarioId, string>;
  for (const s of DEMO_SCENARIOS) out[s.id] = s.description;
  return out;
}

/* ------------------------------------------------------------------ */
/* Scenario builders — one VALIDATION_MATRIX row each                 */
/* ------------------------------------------------------------------ */

/**
 * Row "Idle (measured zero)": fresh snapshot with EXPLICIT zeros — the
 * zero-vs-unknown rule: a literal `0` is a real measurement (observed quiet),
 * never an "unknown" decay. GPU observed with a proven identity, runtime
 * attributed to it, provider quiet. `providerCentricFallback` is FALSE (a
 * proven GPU exists).
 */
const idleScenario: DemoScenario = {
  id: "idle",
  description: "Idle (measured zero) — explicit 0 values, fresh samples, proven GPU",
  build(now) {
    return [
      {
        resourceId: GPU_ID_A,
        kind: "gpu",
        hostId: HOST_ID,
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 0,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: idle — measured zero (explicit 0, not unknown)",
        },
      },
      {
        resourceId: RUNTIME_ID_A_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_A,
        modelId: "demo/idle-chat",
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: idle — measured zero (explicit 0, not unknown)",
        },
        queuedJobs: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: idle — measured zero (explicit 0, not unknown)",
        },
        activeJobs: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: idle — measured zero (explicit 0, not unknown)",
        },
      },
      {
        resourceId: PROVIDER_ID_CANON,
        kind: "provider",
        providerId: PROVIDER_KEY,
        outputTokensPerSecond: {
          value: 0,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: idle — measured zero (explicit 0, not unknown)",
        },
        queuedJobs: {
          value: 0,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: idle — measured zero (explicit 0, not unknown)",
        },
      },
    ];
  },
  expectedSignals: {
    [GPU_ID_A]: { tokensPerSecond: 0, queuedJobs: null, modelIds: null },
    [RUNTIME_ID_A_CANON]: {
      tokensPerSecond: 0,
      queuedJobs: 0,
      modelIds: ["demo/idle-chat"],
    },
    [PROVIDER_ID_CANON]: { tokensPerSecond: 0, queuedJobs: 0, modelIds: null },
  },
  expectedReconciled: {
    edges: [
      { relation: "runtime_device", source: RUNTIME_ID_A_CANON, target: GPU_ID_A },
      { relation: "runtime_model", source: RUNTIME_ID_A_CANON, target: "model:demo/idle-chat" },
    ],
    gpuNodeCount: 1,
    runtimeNodes: [
      {
        resourceId: RUNTIME_ID_A_CANON,
        attributedGpuIds: [GPU_ID_A],
        outputTokensPerSecond: 0,
        modelId: "demo/idle-chat",
      },
    ],
    providerCentricFallback: false,
  },
};

/**
 * Row "Unknown/stale": `capturedAt` is 15 s old (older than the poller's
 * 10 s `staleWindowMs` → the poller reports the feed stale; age 15 s >
 * 3 × `windowMs` 10 s → per the real stale rule the sample is also marked
 * `stale: true` upstream). Fields present are `null`-valued + `stale: true`
 * (observed-absent); `temperatureC`/`powerWatts` are MISSING entirely
 * (no fact). No GPU row → `providerCentricFallback` is TRUE.
 */
const STALE_AGE_MS = 15_000;
const unknownStaleScenario: DemoScenario = {
  id: "unknown-stale",
  description: "Unknown/stale — aged snapshot (15 s), null-valued + missing fields, no GPU",
  build(now) {
    const sampledAt = now - STALE_AGE_MS;
    return [
      {
        resourceId: RUNTIME_ID_A_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_A,
        // modelId deliberately ABSENT — the model identity is unknown too.
        outputTokensPerSecond: {
          value: null,
          source: "runtime",
          sampledAt,
          windowMs: 10_000,
          stale: true,
          basis: "demo: stale sample aged out — value decayed to unknown (null)",
        },
        queuedJobs: {
          value: null,
          source: "runtime",
          sampledAt,
          windowMs: 10_000,
          stale: true,
          basis: "demo: stale sample aged out — value decayed to unknown (null)",
        },
      },
      {
        resourceId: PROVIDER_ID_CANON,
        kind: "provider",
        providerId: PROVIDER_KEY,
        outputTokensPerSecond: {
          value: null,
          source: "omniroute-live",
          sampledAt,
          windowMs: 10_000,
          stale: true,
          basis: "demo: stale sample aged out — value decayed to unknown (null)",
        },
        queuedJobs: {
          value: null,
          source: "omniroute-live",
          sampledAt,
          windowMs: 10_000,
          stale: true,
          basis: "demo: stale sample aged out — value decayed to unknown (null)",
        },
      },
    ];
  },
  expectedSignals: {
    [RUNTIME_ID_A_CANON]: { tokensPerSecond: null, queuedJobs: null, modelIds: null },
    [PROVIDER_ID_CANON]: { tokensPerSecond: null, queuedJobs: null, modelIds: null },
  },
  expectedReconciled: {
    edges: [],
    gpuNodeCount: 0,
    providerCentricFallback: true,
  },
};

/**
 * Row "20 TPS": one runtime at 20 output TPS, attributed to GPU A via its
 * per-device fact; the proven device carries the attributed throughput
 * (NOT an even split — the reconcile rule).
 */
const tps20Scenario: DemoScenario = {
  id: "tps-20",
  description: "20 TPS — runtime 20 out-TPS proven to GPU A via per-device attribution",
  build(now) {
    return [
      {
        resourceId: GPU_ID_A,
        kind: "gpu",
        hostId: HOST_ID,
        deviceUuid: DEVICE_UUID_A,
        utilizationPercent: {
          value: 55,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: runtime utilization sample",
        },
        outputTokensPerSecond: {
          value: 20,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: runtime per-device attribution → GPU A (not split)",
        },
      },
      {
        resourceId: RUNTIME_ID_A_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_A,
        modelId: "demo/20tps-chat",
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 20,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 20 output TPS",
        },
        queuedJobs: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured zero queue (explicit 0)",
        },
        activeJobs: {
          value: 2,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 2 in-flight jobs",
        },
      },
    ];
  },
  expectedSignals: {
    [GPU_ID_A]: {
      tokensPerSecond: 20,
      queuedJobs: null,
      modelIds: null,
      gpuHasProvenThroughput: true,
    },
    [RUNTIME_ID_A_CANON]: {
      tokensPerSecond: 20,
      queuedJobs: 0,
      modelIds: ["demo/20tps-chat"],
    },
  },
  expectedReconciled: {
    edges: [
      { relation: "runtime_device", source: RUNTIME_ID_A_CANON, target: GPU_ID_A },
      { relation: "runtime_model", source: RUNTIME_ID_A_CANON, target: "model:demo/20tps-chat" },
    ],
    gpuNodeCount: 1,
    runtimeNodes: [
      {
        resourceId: RUNTIME_ID_A_CANON,
        attributedGpuIds: [GPU_ID_A],
        outputTokensPerSecond: 20,
        modelId: "demo/20tps-chat",
      },
    ],
    providerCentricFallback: false,
  },
};

/**
 * Row "80 TPS": two runtimes, 40 TPS each, attributed to DIFFERENT GPUs —
 * the per-device attribution keeps each GPU's throughput proven, never an
 * even split of a single runtime metric.
 */
const tps80Scenario: DemoScenario = {
  id: "tps-80",
  description: "80 TPS — two runtimes (40+40) proven to two distinct GPUs",
  build(now) {
    return [
      {
        resourceId: GPU_ID_A,
        kind: "gpu",
        hostId: HOST_ID,
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 40,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: runtime A per-device attribution → GPU A",
        },
      },
      {
        resourceId: GPU_ID_B,
        kind: "gpu",
        hostId: HOST_ID,
        deviceUuid: DEVICE_UUID_B,
        outputTokensPerSecond: {
          value: 40,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: runtime B per-device attribution → GPU B",
        },
      },
      {
        resourceId: RUNTIME_ID_A_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_A,
        modelId: "demo/40tps-chat-a",
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 40,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 40 output TPS (runtime A)",
        },
        queuedJobs: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured zero queue (explicit 0)",
        },
      },
      {
        resourceId: RUNTIME_ID_B_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_B,
        modelId: "demo/40tps-chat-b",
        deviceUuid: DEVICE_UUID_B,
        outputTokensPerSecond: {
          value: 40,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 40 output TPS (runtime B)",
        },
        queuedJobs: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured zero queue (explicit 0)",
        },
      },
    ];
  },
  expectedSignals: {
    [GPU_ID_A]: {
      tokensPerSecond: 40,
      queuedJobs: null,
      modelIds: null,
      gpuHasProvenThroughput: true,
    },
    [GPU_ID_B]: {
      tokensPerSecond: 40,
      queuedJobs: null,
      modelIds: null,
      gpuHasProvenThroughput: true,
    },
    [RUNTIME_ID_A_CANON]: {
      tokensPerSecond: 40,
      queuedJobs: 0,
      modelIds: ["demo/40tps-chat-a"],
    },
    [RUNTIME_ID_B_CANON]: {
      tokensPerSecond: 40,
      queuedJobs: 0,
      modelIds: ["demo/40tps-chat-b"],
    },
  },
  expectedReconciled: {
    edges: [
      { relation: "runtime_device", source: RUNTIME_ID_A_CANON, target: GPU_ID_A },
      { relation: "runtime_device", source: RUNTIME_ID_B_CANON, target: GPU_ID_B },
      {
        relation: "runtime_model",
        source: RUNTIME_ID_A_CANON,
        target: "model:demo/40tps-chat-a",
      },
      {
        relation: "runtime_model",
        source: RUNTIME_ID_B_CANON,
        target: "model:demo/40tps-chat-b",
      },
    ],
    gpuNodeCount: 2,
    runtimeNodes: [
      {
        resourceId: RUNTIME_ID_A_CANON,
        attributedGpuIds: [GPU_ID_A],
        outputTokensPerSecond: 40,
        modelId: "demo/40tps-chat-a",
      },
      {
        resourceId: RUNTIME_ID_B_CANON,
        attributedGpuIds: [GPU_ID_B],
        outputTokensPerSecond: 40,
        modelId: "demo/40tps-chat-b",
      },
    ],
    providerCentricFallback: false,
  },
};

/**
 * Row "Queued jobs": the runtime has a measured queue of 7 waiting jobs
 * (explicit 7 — a real count, never fabricated) while decoding.
 */
const queuedJobsScenario: DemoScenario = {
  id: "queued-jobs",
  description: "Queued jobs — runtime queue of 7 waiting jobs, 2 in flight, 20 TPS",
  build(now) {
    return [
      {
        resourceId: GPU_ID_A,
        kind: "gpu",
        hostId: HOST_ID,
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 20,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: runtime per-device attribution → GPU A",
        },
      },
      {
        resourceId: RUNTIME_ID_A_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_A,
        modelId: "demo/queue-chat",
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 20,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 20 output TPS",
        },
        queuedJobs: {
          value: 7,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 7 queued jobs (explicit count)",
        },
        activeJobs: {
          value: 2,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 2 in-flight jobs",
        },
      },
    ];
  },
  expectedSignals: {
    [GPU_ID_A]: {
      tokensPerSecond: 20,
      queuedJobs: null,
      modelIds: null,
      gpuHasProvenThroughput: true,
    },
    [RUNTIME_ID_A_CANON]: {
      tokensPerSecond: 20,
      queuedJobs: 7,
      modelIds: ["demo/queue-chat"],
    },
  },
  expectedReconciled: {
    edges: [
      { relation: "runtime_device", source: RUNTIME_ID_A_CANON, target: GPU_ID_A },
      { relation: "runtime_model", source: RUNTIME_ID_A_CANON, target: "model:demo/queue-chat" },
    ],
    gpuNodeCount: 1,
    runtimeNodes: [
      {
        resourceId: RUNTIME_ID_A_CANON,
        attributedGpuIds: [GPU_ID_A],
        outputTokensPerSecond: 20,
        modelId: "demo/queue-chat",
      },
    ],
    providerCentricFallback: false,
  },
};

/**
 * Row "2 mixed lanes": one provider with two in-flight runtimes — one
 * embedding model and one vision model. The provider atom's lane is derived
 * by `deriveLaneForProvider()` from the in-flight model ids (the real lane
 * rule in `src/shared/topology/domain/lane.ts`): mixed → the provider's lane
 * is `unknown`; each runtime keeps its own model fact (embedding / vision).
 * The demo rows therefore must carry model ids that the REAL classifier maps
 * to `embedding` and `vision` respectively.
 */
const mixedLanesScenario: DemoScenario = {
  id: "mixed-lanes",
  description:
    "2 mixed lanes — provider with in-flight embedding + vision runtimes (provider lane mixed)",
  build(now) {
    return [
      {
        resourceId: GPU_ID_A,
        kind: "gpu",
        hostId: HOST_ID,
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 12,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: runtime per-device attribution → GPU A",
        },
      },
      {
        resourceId: RUNTIME_ID_A_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_A,
        modelId: "demo/text-embedding-3-small",
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 12,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 12 output TPS (embedding runtime)",
        },
        queuedJobs: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured zero queue (explicit 0)",
        },
      },
      {
        resourceId: RUNTIME_ID_B_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_B,
        modelId: "demo/qwen2-vl-7b-vision",
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 8,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 8 output TPS (vision runtime)",
        },
        queuedJobs: {
          value: 1,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 1 queued job (explicit count)",
        },
      },
      {
        resourceId: PROVIDER_ID_CANON,
        kind: "provider",
        providerId: PROVIDER_KEY,
        outputTokensPerSecond: {
          value: 20,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: provider aggregate throughput (20 out-TPS)",
        },
        queuedJobs: {
          value: 1,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: provider aggregate queue (1 waiting)",
        },
      },
    ];
  },
  expectedSignals: {
    [GPU_ID_A]: {
      tokensPerSecond: 12,
      queuedJobs: null,
      modelIds: null,
      gpuHasProvenThroughput: true,
    },
    [RUNTIME_ID_A_CANON]: {
      tokensPerSecond: 12,
      queuedJobs: 0,
      modelIds: ["demo/text-embedding-3-small"],
    },
    [RUNTIME_ID_B_CANON]: {
      tokensPerSecond: 8,
      queuedJobs: 1,
      modelIds: ["demo/qwen2-vl-7b-vision"],
    },
    [PROVIDER_ID_CANON]: { tokensPerSecond: 20, queuedJobs: 1, modelIds: null },
  },
  expectedReconciled: {
    edges: [
      { relation: "runtime_device", source: RUNTIME_ID_A_CANON, target: GPU_ID_A },
      { relation: "runtime_device", source: RUNTIME_ID_B_CANON, target: GPU_ID_A },
      {
        relation: "runtime_model",
        source: RUNTIME_ID_A_CANON,
        target: "model:demo/text-embedding-3-small",
      },
      {
        relation: "runtime_model",
        source: RUNTIME_ID_B_CANON,
        target: "model:demo/qwen2-vl-7b-vision",
      },
    ],
    gpuNodeCount: 1,
    runtimeNodes: [
      {
        resourceId: RUNTIME_ID_A_CANON,
        attributedGpuIds: [GPU_ID_A],
        outputTokensPerSecond: 12,
        modelId: "demo/text-embedding-3-small",
      },
      {
        resourceId: RUNTIME_ID_B_CANON,
        attributedGpuIds: [GPU_ID_A],
        outputTokensPerSecond: 8,
        modelId: "demo/qwen2-vl-7b-vision",
      },
    ],
    providerCentricFallback: false,
  },
};

/**
 * Row "Completion": the runtime just completed a job — the queue drained to
 * a measured zero and a completion lifecycle event fired. The demo telemetry
 * carries the drained queue (explicit 0) plus the completed job count on the
 * runtime (basis documents the completion); the one-shot completion impulse
 * in the scene is driven by the lifecycle event, which the demo does NOT
 * synthesize (it is not a snapshot field).
 */
const completionScenario: DemoScenario = {
  id: "completion",
  description:
    "Completion — job finished: queue drained to measured 0, in-flight back to 1, completion basis",
  build(now) {
    return [
      {
        resourceId: GPU_ID_A,
        kind: "gpu",
        hostId: HOST_ID,
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 20,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: runtime per-device attribution → GPU A",
        },
      },
      {
        resourceId: RUNTIME_ID_A_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_A,
        modelId: "demo/complete-chat",
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 20,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 20 output TPS",
        },
        queuedJobs: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: queue drained after completion (explicit 0)",
        },
        activeJobs: {
          value: 1,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: completion — one job just finished, one remains",
        },
      },
    ];
  },
  expectedSignals: {
    [GPU_ID_A]: {
      tokensPerSecond: 20,
      queuedJobs: null,
      modelIds: null,
      gpuHasProvenThroughput: true,
    },
    [RUNTIME_ID_A_CANON]: {
      tokensPerSecond: 20,
      queuedJobs: 0,
      modelIds: ["demo/complete-chat"],
    },
  },
  expectedReconciled: {
    edges: [
      { relation: "runtime_device", source: RUNTIME_ID_A_CANON, target: GPU_ID_A },
      {
        relation: "runtime_model",
        source: RUNTIME_ID_A_CANON,
        target: "model:demo/complete-chat",
      },
    ],
    gpuNodeCount: 1,
    runtimeNodes: [
      {
        resourceId: RUNTIME_ID_A_CANON,
        attributedGpuIds: [GPU_ID_A],
        outputTokensPerSecond: 20,
        modelId: "demo/complete-chat",
      },
    ],
    providerCentricFallback: false,
  },
};

/**
 * Row "Failed request": the provider's last request failed — the snapshot
 * carries the provider's measured steady state (queue back to a measured 0,
 * no in-flight jobs) with a `basis` that documents the failed request; the
 * jagged red discharge is driven by the lifecycle FAILED event (not a
 * snapshot field), so the telemetry here is the honest post-failure quiet
 * state, never an invented error metric.
 */
const failedRequestScenario: DemoScenario = {
  id: "failed-request",
  description:
    "Failed request — provider last request failed; measured post-failure quiet state (0 queue, 0 in-flight)",
  build(now) {
    return [
      {
        resourceId: GPU_ID_A,
        kind: "gpu",
        hostId: HOST_ID,
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 0,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: failed request — GPU measured zero after the dropped request (explicit 0)",
        },
      },
      {
        resourceId: RUNTIME_ID_A_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_A,
        modelId: "demo/failed-chat",
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: post-failure quiet — measured zero throughput (explicit 0)",
        },
        queuedJobs: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: failed request dropped — queue back to measured 0 (explicit 0)",
        },
        activeJobs: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: failed request dropped — 0 in-flight (explicit 0)",
        },
      },
      {
        resourceId: PROVIDER_ID_CANON,
        kind: "provider",
        providerId: PROVIDER_KEY,
        outputTokensPerSecond: {
          value: 0,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: failed request — provider quiet after the dropped request (explicit 0)",
        },
        queuedJobs: {
          value: 0,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: failed request — provider queue measured 0 (explicit 0)",
        },
        activeJobs: {
          value: 0,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: failed request — 0 in-flight on the provider (explicit 0)",
        },
      },
    ];
  },
  expectedSignals: {
    [GPU_ID_A]: { tokensPerSecond: 0, queuedJobs: null, modelIds: null },
    [RUNTIME_ID_A_CANON]: {
      tokensPerSecond: 0,
      queuedJobs: 0,
      modelIds: ["demo/failed-chat"],
    },
    [PROVIDER_ID_CANON]: { tokensPerSecond: 0, queuedJobs: 0, modelIds: null },
  },
  expectedReconciled: {
    edges: [
      { relation: "runtime_device", source: RUNTIME_ID_A_CANON, target: GPU_ID_A },
      {
        relation: "runtime_model",
        source: RUNTIME_ID_A_CANON,
        target: "model:demo/failed-chat",
      },
    ],
    gpuNodeCount: 1,
    runtimeNodes: [
      {
        resourceId: RUNTIME_ID_A_CANON,
        attributedGpuIds: [GPU_ID_A],
        outputTokensPerSecond: 0,
        modelId: "demo/failed-chat",
      },
    ],
    providerCentricFallback: false,
  },
};

/**
 * Row "Multi-runtime GPU": TWO runtimes attributed to the SAME proven device
 * (GPU A) via per-device facts — the reconcile rule sums their attributed
 * throughput onto the device (60+30=90) while each runtime keeps its own
 * proven model + TPS. GPU B is present but unattributed (no runtime points
 * at it) → its throughput stays unknown (absent), never split from A.
 */
const multiRuntimeGpuScenario: DemoScenario = {
  id: "multi-runtime-gpu",
  description:
    "Multi-runtime GPU — two runtimes (60+30 TPS) both attributed to the same proven GPU A; GPU B unattributed",
  build(now) {
    return [
      {
        resourceId: GPU_ID_A,
        kind: "gpu",
        hostId: HOST_ID,
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 90,
          source: "omniroute-live",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: two runtime per-device attributions → GPU A (60+30, not split)",
        },
      },
      {
        // Present + observed, but NO runtime is attributed to it → throughput
        // stays unknown (the field is deliberately ABSENT, not null, not 0).
        resourceId: GPU_ID_B,
        kind: "gpu",
        hostId: HOST_ID,
        deviceUuid: DEVICE_UUID_B,
        utilizationPercent: {
          value: 12,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: idle device observed (no attributed throughput)",
        },
      },
      {
        resourceId: RUNTIME_ID_A_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_A,
        modelId: "demo/multi-rt-a",
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 60,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 60 output TPS (runtime A)",
        },
        queuedJobs: {
          value: 0,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured zero queue (explicit 0)",
        },
      },
      {
        resourceId: RUNTIME_ID_B_CANON,
        kind: "runtime",
        hostId: HOST_ID,
        runtimeId: RUNTIME_ID_B,
        modelId: "demo/multi-rt-b",
        deviceUuid: DEVICE_UUID_A,
        outputTokensPerSecond: {
          value: 30,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 30 output TPS (runtime B)",
        },
        queuedJobs: {
          value: 2,
          source: "runtime",
          sampledAt: now,
          windowMs: 10_000,
          stale: false,
          basis: "demo: measured 2 queued jobs (explicit count)",
        },
      },
    ];
  },
  expectedSignals: {
    [GPU_ID_A]: {
      tokensPerSecond: 90,
      queuedJobs: null,
      modelIds: null,
      gpuHasProvenThroughput: true,
    },
    // GPU B carries NO throughput fact → expected `null` is a type sentinel:
    // the test treats `null` on an ABSENT field as "observed-absent" too
    // (see `expectSignalsMatch` — absent field ⇒ `null`).
    [GPU_ID_B]: {
      tokensPerSecond: null,
      queuedJobs: null,
      modelIds: null,
    },
    [RUNTIME_ID_A_CANON]: {
      tokensPerSecond: 60,
      queuedJobs: 0,
      modelIds: ["demo/multi-rt-a"],
    },
    [RUNTIME_ID_B_CANON]: {
      tokensPerSecond: 30,
      queuedJobs: 2,
      modelIds: ["demo/multi-rt-b"],
    },
  },
  expectedReconciled: {
    edges: [
      { relation: "runtime_device", source: RUNTIME_ID_A_CANON, target: GPU_ID_A },
      { relation: "runtime_device", source: RUNTIME_ID_B_CANON, target: GPU_ID_A },
      {
        relation: "runtime_model",
        source: RUNTIME_ID_A_CANON,
        target: "model:demo/multi-rt-a",
      },
      {
        relation: "runtime_model",
        source: RUNTIME_ID_B_CANON,
        target: "model:demo/multi-rt-b",
      },
    ],
    gpuNodeCount: 2,
    runtimeNodes: [
      {
        resourceId: RUNTIME_ID_A_CANON,
        attributedGpuIds: [GPU_ID_A],
        outputTokensPerSecond: 60,
        modelId: "demo/multi-rt-a",
      },
      {
        resourceId: RUNTIME_ID_B_CANON,
        attributedGpuIds: [GPU_ID_A],
        outputTokensPerSecond: 30,
        modelId: "demo/multi-rt-b",
      },
    ],
    providerCentricFallback: false,
  },
};

/** Every demo scenario, in VALIDATION_MATRIX row order. */
export const DEMO_SCENARIOS: DemoScenario[] = [
  idleScenario,
  unknownStaleScenario,
  tps20Scenario,
  tps80Scenario,
  queuedJobsScenario,
  mixedLanesScenario,
  completionScenario,
  failedRequestScenario,
  multiRuntimeGpuScenario,
];

/**
 * Look up a scenario by id. Returns `null` for unknown ids (the controller
 * treats that as "no demo", never an error thrown into the normal UI).
 */
export function getDemoScenario(id: string): DemoScenario | null {
  return DEMO_SCENARIOS.find((s) => s.id === id) ?? null;
}

/**
 * Assert the snapshot's OWN `Observed` values satisfy the scenario's
 * `expectedSignals` (the "W1 contract is NOT required" rule — the harness is
 * self-checking). Returns `true` when every expectation holds; `false`
 * otherwise (a mismatch is a harness bug, not a runtime error).
 *
 * Semantics:
 * - `tokensPerSecond` / `queuedJobs`: `null` ⇒ the field is absent OR its
 *   `Observed.value` is `null`; a number ⇒ the field is present with that
 *   exact `value`.
 * - `modelIds`: `null` ⇒ `modelId` absent; an array ⇒ the exact set of model
 *   ids for the resources that carry the `resourceId` (one per runtime row).
 * - `gpuHasProvenThroughput: true` ⇒ the throughput `Observed` is present AND
 *   its source is in `{omniroute-live, omniroute-call-log, runtime}`.
 */
export function expectSignalsMatch(
  snapshot: FleetTelemetrySnapshot,
  scenario: DemoScenario
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const byId = new Map<string, FleetResourceObservation[]>();
  for (const r of snapshot.resources) {
    const arr = byId.get(r.resourceId) ?? [];
    arr.push(r);
    byId.set(r.resourceId, arr);
  }

  for (const [resourceId, expected] of Object.entries(scenario.expectedSignals)) {
    const rows = byId.get(resourceId);
    if (!rows || rows.length === 0) {
      mismatches.push(`missing resource ${resourceId}`);
      continue;
    }

    // The harness convention: one row per canonical id per scenario. Assert
    // the throughput/queue on the FIRST row (the others are checked for
    // modelIds, which are per-row).
    const first = rows[0];
    const tpsObs = first.outputTokensPerSecond;
    const qObs = first.queuedJobs;

    const tpsActual = tpsObs === undefined ? null : tpsObs.value;
    if (tpsActual !== expected.tokensPerSecond) {
      mismatches.push(
        `${resourceId}: tokensPerSecond expected ${expected.tokensPerSecond}, got ${tpsActual}`
      );
    }
    const qActual = qObs === undefined ? null : qObs.value;
    if (qActual !== expected.queuedJobs) {
      mismatches.push(`${resourceId}: queuedJobs expected ${expected.queuedJobs}, got ${qActual}`);
    }

    // modelIds: `null` → absent on EVERY row; array → the multiset of the
    // rows' `modelId` values matches (order-insensitive; the snapshot
    // convention is one runtime row per model).
    if (expected.modelIds === null) {
      for (const r of rows) {
        if (r.modelId !== undefined && r.modelId.length > 0) {
          mismatches.push(`${resourceId}: modelId expected absent, got "${r.modelId}"`);
          break;
        }
      }
    } else {
      const actual = rows
        .map((r) => r.modelId)
        .filter((m): m is string => typeof m === "string" && m.length > 0)
        .sort();
      const want = [...expected.modelIds].sort();
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        mismatches.push(
          `${resourceId}: modelIds expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`
        );
      }
    }

    if (expected.gpuHasProvenThroughput === true) {
      if (!tpsObs || tpsObs.value === null) {
        mismatches.push(`${resourceId}: gpuHasProvenThroughput expected, but no proven throughput`);
      } else if (!PROVEN_LIVE_SOURCES.has(tpsObs.source)) {
        mismatches.push(
          `${resourceId}: gpuHasProvenThroughput expected, but source is "${tpsObs.source}"`
        );
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
