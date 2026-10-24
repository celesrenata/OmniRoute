/**
 * Fleet telemetry gateway — behavioral tests (T005 / M2, OR-ATOM-001 v2).
 *
 * Covers the SERVER-SIDE guarantees end-to-end with fake providers (no live
 * infra): canonical identities survive the merge, provenance is validated,
 * stale data is marked, provider failures degrade to warnings, the short-TTL
 * cache serves repeats, host/gpu filtering drops the right rows, and the
 * OmniRoute-native adapter emits GPU facts as `null` with documented
 * unavailable provenance (never fabricated).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FleetTelemetryGateway,
  TelemetryQueryError,
} from "../../../src/shared/topology/telemetry/gateway";
import {
  buildOmnirouteTelemetryProvider,
  GPU_UNAVAILABLE_BASIS,
  QUEUED_JOBS_BASIS,
  ACTIVE_JOBS_BASIS,
  type OmnirouteProducers,
} from "../../../src/shared/topology/telemetry/providers/omniroute";
import type {
  FleetResourceObservation,
  FleetTelemetryProvider,
  FleetTelemetrySnapshot,
  Observed,
  TelemetryProviderStatus,
} from "../../../src/shared/topology/telemetry/types";

const NOW = 1_000_000;

function observed(
  value: number | null,
  sampledAt = NOW,
  opts: Partial<Observed<number>> = {}
): Observed<number> {
  const out: Observed<number> = {
    value,
    source: opts.source ?? "omniroute-live",
    sampledAt,
    ...(opts.windowMs != null ? { windowMs: opts.windowMs } : {}),
    ...(opts.basis != null ? { basis: opts.basis } : {}),
  };
  return out;
}

function providerRow(
  providerKey: string,
  fields: Partial<FleetResourceObservation> = {}
): FleetResourceObservation {
  const r: FleetResourceObservation = {
    resourceId: `provider:${providerKey}`,
    kind: "provider",
    providerId: providerKey,
  };
  Object.assign(r, fields);
  return r;
}

function gpuRow(
  hostId: string,
  deviceUuid: string,
  fields: Partial<FleetResourceObservation> = {}
) {
  const r: FleetResourceObservation = {
    resourceId: `gpu:${hostId}:${deviceUuid}`,
    kind: "gpu",
    hostId,
    deviceUuid,
  };
  Object.assign(r, fields);
  return r;
}

function fakeProvider(
  id: string,
  opts: {
    resources?: FleetResourceObservation[];
    fail?: string;
    delayMs?: number;
    capturedAtOverride?: number;
    onSnapshot?: (q: { windowMs: number }) => void;
    calls?: () => number;
  } = {}
): FleetTelemetryProvider & { snapshotCalls: number } {
  let snapshotCalls = 0;
  const provider: FleetTelemetryProvider = {
    id,
    kind: "omniroute",
    async probe(): Promise<TelemetryProviderStatus> {
      return { available: true, checkedAt: NOW };
    },
    async snapshot(query): Promise<FleetTelemetrySnapshot> {
      snapshotCalls += 1;
      if (opts.fail) throw new Error(opts.fail);
      if (opts.delayMs != null) await new Promise((r) => setTimeout(r, opts.delayMs));
      opts.onSnapshot?.(query);
      return {
        schemaVersion: 1,
        capturedAt: opts.capturedAtOverride ?? NOW,
        resources: opts.resources ?? [],
      };
    },
  };
  return Object.assign(provider, {
    get snapshotCalls() {
      return snapshotCalls;
    },
  });
}

function makeGateway(
  providers: FleetTelemetryProvider[],
  opts: { ttlMs?: number; now?: () => number; providerTimeoutMs?: number } = {}
) {
  let t = NOW;
  const gateway = new FleetTelemetryGateway({
    cacheTtlMs: opts.ttlMs ?? 10_000,
    providerTimeoutMs: opts.providerTimeoutMs ?? 5_000,
    now: opts.now ?? (() => t),
  });
  for (const p of providers) gateway.register(p);
  return { gateway, advance: (ms: number) => (t += ms) };
}

test("canonical identities: gpu/runtime/provider ids survive the merge untouched", async () => {
  const { gateway } = makeGateway([
    fakeProvider("omniroute", {
      resources: [
        providerRow("anthropic", { activeJobs: observed(3) }),
        gpuRow("host-a", "UUID-1", {
          temperatureC: observed(55.5, NOW, { source: "derived", basis: "sim" }),
        }),
        {
          resourceId: "runtime:host-a:vllm-0",
          kind: "runtime",
          hostId: "host-a",
          runtimeId: "vllm-0",
          queuedJobs: observed(2, NOW, { source: "runtime", basis: "runtime" }),
        },
      ],
    }),
  ]);
  const snap = await gateway.snapshot({ windowMs: 60_000 });
  assert.deepEqual(
    snap.resources.map((r) => r.resourceId).sort(),
    ["gpu:host-a:UUID-1", "provider:anthropic", "runtime:host-a:vllm-0"].sort()
  );
  const gpu = snap.resources.find((r) => r.resourceId === "gpu:host-a:UUID-1");
  assert.ok(gpu && gpu.kind === "gpu" && gpu.deviceUuid === "UUID-1");
});

test("provenance: a snapshot violating the observed schema is dropped wholesale, not merged", async () => {
  // basis with whitespace + credential-shaped token → observedSchema rejects the field;
  // snapshotSchema rejects the snapshot → the whole provider snapshot is dropped.
  const { gateway } = makeGateway([
    fakeProvider("bad", {
      resources: [providerRow("openai", { activeJobs: observed(1, NOW, { basis: "password=x" }) })],
    }),
    fakeProvider("good", { resources: [providerRow("glm", { activeJobs: observed(0) })] }),
  ]);
  const snap = await gateway.snapshot({ windowMs: 60_000 });
  assert.deepEqual(
    snap.resources.map((r) => r.resourceId),
    ["provider:glm"]
  );
  assert.equal(gateway.lastDiagnostics?.droppedInvalidSnapshots, 1);
});

test("provenance: NaN values and future-sampled rows are rejected by the gateway", async () => {
  // NaN value → field invalid → whole snapshot dropped.
  const nanProvider = fakeProvider("nan", {
    resources: [providerRow("openai", { activeJobs: observed(Number.NaN) })],
  });
  const futureProvider = fakeProvider("future", {
    // sampled AFTER capturedAt → merge drops the future snapshot.
    resources: [providerRow("anthropic", { activeJobs: observed(1, NOW + 5_000) })],
    capturedAtOverride: NOW,
  });
  const { gateway } = makeGateway([nanProvider, futureProvider]);
  const snap = await gateway.snapshot({ windowMs: 60_000 });
  assert.deepEqual(snap.resources, []);
  assert.equal(gateway.lastDiagnostics?.droppedInvalidSnapshots, 1);
  assert.equal(gateway.lastDiagnostics?.droppedFutureSnapshots, 1);
});

test("staleness: a sample older than 3x windowMs is marked stale (no windowMs → never stale)", async () => {
  // Staleness is evaluated against the provider's own capturedAt: age the
  // SAMPLE (sampledAt) relative to the capturedAt clock, not the gateway clock.
  const { gateway } = makeGateway([]);
  const stale = fakeProvider("stale", {
    resources: [
      providerRow("openai", {
        activeJobs: observed(4, NOW - (60_000 * 3 + 1), { windowMs: 60_000 }),
      }),
    ],
  });
  gateway.register(stale);
  const snap = await gateway.snapshot({ windowMs: 60_000, providerIds: ["stale"] });
  assert.equal(snap.resources[0].activeJobs?.stale, true);

  // A field WITHOUT windowMs is never marked stale, no matter its age.
  const noWindow = fakeProvider("nowin", {
    resources: [providerRow("glm", { activeJobs: observed(1, NOW - 600_000) })],
  });
  gateway.register(noWindow);
  const snap2 = await gateway.snapshot({ windowMs: 60_000, providerIds: ["nowin"] });
  assert.equal(snap2.resources[0].activeJobs?.stale, undefined);
});

test("provider failures degrade to warnings; the snapshot is still built from healthy providers", async () => {
  const warnings: string[] = [];
  const { gateway } = makeGateway([]);
  const failing = fakeProvider("boom", { fail: "producer exploded" });
  const healthy = fakeProvider("ok", {
    resources: [providerRow("mistral", { queuedJobs: observed(0) })],
  });
  const { FleetTelemetryGateway: GT } =
    await import("../../../src/shared/topology/telemetry/gateway");
  void gateway;
  const g2 = new GT({
    cacheTtlMs: 10_000,
    providerTimeoutMs: 5_000,
    now: () => NOW,
    onWarning: (w) => warnings.push(w),
  });
  g2.register(failing);
  g2.register(healthy);
  const snap = await g2.snapshot({ windowMs: 60_000 });
  assert.deepEqual(
    snap.resources.map((r) => r.resourceId),
    ["provider:mistral"]
  );
  assert.equal(g2.lastDiagnostics?.droppedInvalidSnapshots, 0);
  assert.ok(warnings.some((w) => w.includes("boom") && w.includes("producer exploded")));
});

test("provider timeout degrades to a warning, not an error", async () => {
  const warnings: string[] = [];
  const { FleetTelemetryGateway: GT } =
    await import("../../../src/shared/topology/telemetry/gateway");
  const slow = fakeProvider("slow", { delayMs: 200 });
  const fast = fakeProvider("fast", {
    resources: [providerRow("cohere", { activeJobs: observed(0) })],
  });
  const g = new GT({
    cacheTtlMs: 10_000,
    providerTimeoutMs: 20,
    now: () => NOW,
    onWarning: (w) => warnings.push(w),
  });
  g.register(slow);
  g.register(fast);
  const snap = await g.snapshot({ windowMs: 60_000 });
  assert.deepEqual(
    snap.resources.map((r) => r.resourceId),
    ["provider:cohere"]
  );
  assert.ok(warnings.some((w) => w.includes("slow") && /timeout/.test(w)));
});

test("cache: identical query within the TTL is served from cache; after TTL it re-runs", async () => {
  let calls = 0;
  const counting = fakeProvider("count", {
    resources: [providerRow("openai", { activeJobs: observed(1) })],
    onSnapshot: () => calls++,
  });
  const { gateway, advance } = makeGateway([counting]);
  const q = { windowMs: 60_000 };
  const first = await gateway.snapshot(q);
  const second = await gateway.snapshot(q);
  assert.equal(calls, 1, "second identical query must hit the cache");
  assert.equal(gateway.lastDiagnostics?.fromCache, true);
  assert.equal(second, first, "cached snapshot is the same object");

  advance(10_001); // past the default 10s TTL
  await gateway.snapshot(q);
  assert.equal(calls, 2, "query past the TTL must re-run the providers");
  assert.equal(gateway.lastDiagnostics?.fromCache, false);
});

test("filtering: hostIds drops resources without a hostId; gpuIds only filters kind=gpu by canonical id", async () => {
  const { gateway } = makeGateway([
    fakeProvider("omniroute", {
      resources: [
        providerRow("openai", { activeJobs: observed(0) }),
        gpuRow("host-a", "UUID-1", { temperatureC: observed(40) }),
        gpuRow("host-b", "UUID-2", { temperatureC: observed(41) }),
      ],
    }),
  ]);

  const byHost = await gateway.snapshot({ windowMs: 60_000, hostIds: ["host-a"] });
  assert.deepEqual(
    byHost.resources.map((r) => r.resourceId),
    ["gpu:host-a:UUID-1"]
  );

  const byGpu = await gateway.snapshot({
    windowMs: 60_000,
    gpuIds: ["gpu:host-b:UUID-2"],
  });
  assert.deepEqual(
    byGpu.resources.map((r) => r.resourceId),
    ["gpu:host-b:UUID-2"]
  );

  // gpu filter never matches provider/runtime rows.
  const noMatch = await gateway.snapshot({
    windowMs: 60_000,
    gpuIds: ["gpu:host-a:MISSING"],
  });
  assert.deepEqual(noMatch.resources, []);
});

test("query errors: invalid windowMs throws TelemetryQueryError; unknown provider ids warn, not throw", async () => {
  const { gateway } = makeGateway([
    fakeProvider("omniroute", { resources: [providerRow("openai", { activeJobs: observed(0) })] }),
  ]);
  await assert.rejects(() => gateway.snapshot({ windowMs: 0 } as never), TelemetryQueryError);
  await assert.rejects(() => gateway.snapshot({ windowMs: -5 } as never), TelemetryQueryError);
  // Unknown provider id: warning, empty selection, empty snapshot (no throw).
  const warnings: string[] = [];
  const { FleetTelemetryGateway: GT } =
    await import("../../../src/shared/topology/telemetry/gateway");
  void gateway;
  const g = new GT({ now: () => NOW, onWarning: (w) => warnings.push(w) });
  g.register(
    fakeProvider("omniroute", { resources: [providerRow("openai", { activeJobs: observed(0) })] })
  );
  const snap = await g.snapshot({ windowMs: 60_000, providerIds: ["does-not-exist"] });
  assert.deepEqual(snap.resources, []);
  assert.ok(warnings.some((w) => w.includes("does-not-exist")));
});

test("native adapter: canonical provider identity, real limiter counts, TTFT-excluded throughput", async () => {
  const producers: OmnirouteProducers = {
    now: () => NOW,
    providerConnections: async () => [
      { id: "c1", provider: "openai" },
      { id: "c2", provider: "openai" }, // dedup: same provider key → ONE row
      { id: "c3", provider: "anthropic" },
    ],
    circuitBreakerStatuses: async () => [{ name: "openai", state: "DEGRADED" }],
    rateLimitStatus: async () => ({
      "openai:conn-1": { queued: 2, running: 1, executing: 0 },
      "openai:conn-2": { queued: 3, running: 0, executing: 0 },
      "anthropic:conn-1": { queued: 0, running: 0, executing: 0 },
    }),
    inflightRequestCount: async () => 7,
    callLogRows: async (windowMs) => {
      assert.equal(windowMs, 60_000);
      return [
        // 120 tokens over a 60s generation (240s total minus 180s TTFT) → 2 tok/s
        { provider: "openai", duration: 240_000, ttft: 180_000, tokensOut: 120 },
        // 60 tokens over a 60s generation → 1 tok/s (not the max)
        { provider: "openai", duration: 60_000, ttft: 0, tokensOut: 60 },
      ];
    },
  };
  const provider = buildOmnirouteTelemetryProvider(producers);
  const snap = await provider.snapshot({ windowMs: 60_000 });

  assert.equal(snap.schemaVersion, 1);
  const ids = snap.resources.map((r) => r.resourceId).sort();
  assert.deepEqual(ids, ["provider:anthropic", "provider:openai"]);

  const openai = snap.resources.find((r) => r.resourceId === "provider:openai")!;
  assert.equal(openai.kind, "provider");
  assert.equal(openai.providerId, "openai");
  assert.equal(openai.activeJobs?.value, 7);
  // DEGRADED breaker appends the state tag to the basis (CLOSED/UNKNOWN do not).
  assert.equal(openai.activeJobs?.basis, `${ACTIVE_JOBS_BASIS};breakers:degraded`);
  assert.equal(openai.queuedJobs?.value, 5, "QUEUED counts sum across the provider's limiter keys");
  assert.equal(openai.queuedJobs?.basis, QUEUED_JOBS_BASIS);
  assert.equal(openai.outputTokensPerSecond?.value, 2, "TTFT-excluded max throughput");
  assert.equal(openai.outputTokensPerSecond?.windowMs, 60_000);
  assert.equal(openai.outputTokensPerSecond?.source, "omniroute-call-log");

  const anthropic = snap.resources.find((r) => r.resourceId === "provider:anthropic")!;
  assert.equal(anthropic.queuedJobs?.value, 0, "0 queued is a real measurement, not missing");
  assert.equal(anthropic.activeJobs?.basis, ACTIVE_JOBS_BASIS, "CLOSED breaker → no breaker tag");
  assert.equal(
    anthropic.outputTokensPerSecond?.value,
    null,
    "no derivable duration → null, not fabricated"
  );
});

test("native adapter: GPU/runtime device facts are ALWAYS null with unavailable provenance", async () => {
  const producers: OmnirouteProducers = {
    now: () => NOW,
    providerConnections: async () => [{ id: "c1", provider: "openai" }],
    circuitBreakerStatuses: async () => [],
    rateLimitStatus: async () => ({}),
    inflightRequestCount: async () => 0,
    callLogRows: async () => [],
  };
  const provider = buildOmnirouteTelemetryProvider(producers);
  const snap = await provider.snapshot({ windowMs: 60_000 });
  const row = snap.resources[0];
  for (const field of [
    "utilizationPercent",
    "vramUsedBytes",
    "vramTotalBytes",
    "temperatureC",
    "powerWatts",
  ] as const) {
    assert.equal(row[field]?.value, null, `${field} must be null`);
    assert.equal(
      row[field]?.basis,
      GPU_UNAVAILABLE_BASIS,
      `${field} must carry the unavailable basis`
    );
  }
  // No gpu/runtime rows are ever emitted by the native adapter.
  assert.ok(snap.resources.every((r) => r.kind === "provider"));
});

test("native adapter: malformed provider connections are skipped without breaking the snapshot", async () => {
  const producers: OmnirouteProducers = {
    now: () => NOW,
    providerConnections: async () => [
      { id: "ok", provider: "glm" },
      { id: "bad-colon", provider: "bad:provider" }, // canonical id forbids ':'
      { id: "bad-empty", provider: "   " },
    ],
    circuitBreakerStatuses: async () => ({}),
    rateLimitStatus: async () => ({}),
    inflightRequestCount: async () => 1,
    callLogRows: async () => [],
  };
  const provider = buildOmnirouteTelemetryProvider(producers);
  const snap = await provider.snapshot({ windowMs: 60_000 });
  assert.deepEqual(
    snap.resources.map((r) => r.resourceId),
    ["provider:glm"]
  );
});
