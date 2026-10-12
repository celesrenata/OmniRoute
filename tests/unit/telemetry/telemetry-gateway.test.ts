/**
 * Gateway tests (T005 / M2): one bounded snapshot, server-side merge,
 * short-TTL bounded cache, provider timeout + AbortSignal, invalid-query
 * rejection, provider-failure degradation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FleetTelemetryGateway,
  TelemetryAbortedError,
  TelemetryQueryError,
} from "../../../src/shared/topology/telemetry/gateway";
import {
  fixtureSnapshot,
  makeFakeProvider,
  providerResource,
  resetFixtureClock,
  runtimeResource,
  gpuResource,
  observedValue,
} from "./telemetry-fixtures";

const NOW = 1_700_000_000_000;

function makeGateway(
  opts: {
    now?: () => number;
    providerTimeoutMs?: number;
    cacheTtlMs?: number;
    cacheMaxEntries?: number;
    onWarning?: (w: string) => void;
  } = {}
): FleetTelemetryGateway {
  return new FleetTelemetryGateway({
    now: opts.now ?? (() => NOW),
    providerTimeoutMs: opts.providerTimeoutMs,
    cacheTtlMs: opts.cacheTtlMs,
    cacheMaxEntries: opts.cacheMaxEntries,
    onWarning: opts.onWarning,
  });
}

describe("gateway: one bounded snapshot, no browser fan-out", () => {
  it("merges multiple providers into ONE snapshot in a single call", async () => {
    let t = NOW;
    const gw = makeGateway({ now: () => t });
    const a = makeFakeProvider({
      id: "a",
      resources: () => [
        providerResource("openai", { activeJobs: observedValue(1, { sampledAt: t }) }),
      ],
    });
    const b = makeFakeProvider({
      id: "b",
      resources: () => [
        gpuResource("h1", "u", { utilizationPercent: observedValue(10, { sampledAt: t }) }),
      ],
    });
    gw.register(a.provider);
    gw.register(b.provider);

    const snap = await gw.snapshot({ windowMs: 60_000 });
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.resources.length, 2);
    assert.equal(a.snapshotCalls, 1);
    assert.equal(b.snapshotCalls, 1);
    assert.equal(gw.lastDiagnostics?.fromCache, false);
    assert.deepEqual(Object.keys(gw.lastDiagnostics?.providerLatencyMs ?? {}), ["a", "b"]);
  });
});

describe("gateway: bounded short-TTL cache", () => {
  it("serves from cache within the TTL (provider not re-queried)", async () => {
    let t = NOW;
    const gw = makeGateway({ now: () => t, cacheTtlMs: 10_000 });
    const a = makeFakeProvider({
      id: "a",
      resources: () => [providerResource("p", { activeJobs: observedValue(1, { sampledAt: t }) })],
    });
    gw.register(a.provider);

    await gw.snapshot({ windowMs: 60_000 });
    assert.equal(a.snapshotCalls, 1);
    t += 9_999; // still inside TTL
    await gw.snapshot({ windowMs: 60_000 });
    assert.equal(a.snapshotCalls, 1); // cache hit
    assert.equal(gw.lastDiagnostics?.fromCache, true);
  });

  it("re-queries after TTL expiry", async () => {
    let t = NOW;
    const gw = makeGateway({ now: () => t, cacheTtlMs: 10_000 });
    const a = makeFakeProvider({
      id: "a",
      resources: () => [providerResource("p", { activeJobs: observedValue(1, { sampledAt: t }) })],
    });
    gw.register(a.provider);
    await gw.snapshot({ windowMs: 60_000 });
    t += 10_001; // TTL expired
    await gw.snapshot({ windowMs: 60_000 });
    assert.equal(a.snapshotCalls, 2);
  });

  it("separate queries get separate cache entries; LRU evicts past the cap", async () => {
    let t = NOW;
    const gw = makeGateway({ now: () => t, cacheMaxEntries: 2, cacheTtlMs: 60_000 });
    const a = makeFakeProvider({
      id: "a",
      resources: () => [providerResource("p", { activeJobs: observedValue(1, { sampledAt: t }) })],
    });
    gw.register(a.provider);

    await gw.snapshot({ windowMs: 60_000 }); // entry 1
    t += 100;
    await gw.snapshot({ windowMs: 120_000 }); // entry 2
    t += 100;
    await gw.snapshot({ windowMs: 180_000 }); // evicts entry 1 (LRU)
    t += 100;
    await gw.snapshot({ windowMs: 60_000 }); // must re-query (evicted)
    assert.equal(a.snapshotCalls, 4); // every call was a miss
  });
});

describe("gateway: provider timeout + cancellation", () => {
  it("times out a slow provider and degrades to a warning (others still merge)", async () => {
    const warnings: string[] = [];
    const gw = makeGateway({ providerTimeoutMs: 30, onWarning: (w) => warnings.push(w) });
    const slow = makeFakeProvider({ id: "slow", delayMs: 200 });
    const fast = makeFakeProvider({
      id: "fast",
      resources: () => [
        providerResource("p", { activeJobs: observedValue(1, { sampledAt: NOW }) }),
      ],
    });
    gw.register(slow.provider);
    gw.register(fast.provider);

    const snap = await gw.snapshot({ windowMs: 60_000 });
    assert.equal(snap.resources.length, 1);
    assert.ok(warnings.some((w) => w.includes("slow") && w.includes("timeout")));
  });

  it("aborts the whole query when the AbortSignal fires", async () => {
    const gw = makeGateway({});
    const a = makeFakeProvider({ id: "a" });
    gw.register(a.provider);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => gw.snapshot({ windowMs: 60_000 }, ac.signal),
      (err: unknown) => err instanceof TelemetryAbortedError
    );
  });

  it("rejects a mid-run abort by the provider with TelemetryAbortedError", async () => {
    const gw = makeGateway({});
    const ac = new AbortController();
    const provider = makeFakeProvider({ id: "a" });
    // Wrap to abort once snapshot() starts.
    const original = provider.provider.snapshot;
    provider.provider.snapshot = async (q, signal) => {
      ac.abort();
      return original(q, signal);
    };
    gw.register(provider.provider);
    await assert.rejects(
      () => gw.snapshot({ windowMs: 60_000 }, ac.signal),
      (err: unknown) => err instanceof TelemetryAbortedError
    );
  });
});

describe("gateway: invalid query rejection (Zod)", () => {
  it("throws TelemetryQueryError on an invalid windowMs", async () => {
    const gw = makeGateway({});
    await assert.rejects(
      () => gw.snapshot({ windowMs: Number.NaN }),
      (err: unknown) => err instanceof TelemetryQueryError
    );
  });

  it("throws TelemetryQueryError on unknown keys", async () => {
    const gw = makeGateway({});
    await assert.rejects(
      () => gw.snapshot({ windowMs: 1000, extra: 1 }),
      (err: unknown) => err instanceof TelemetryQueryError
    );
  });

  it("throws TelemetryQueryError on non-object input", async () => {
    const gw = makeGateway({});
    await assert.rejects(
      () => gw.snapshot("not-a-query"),
      (err: unknown) => err instanceof TelemetryQueryError
    );
  });
});

describe("gateway: provider-failure degradation + schema drop", () => {
  it("keeps the healthy provider when one rejects", async () => {
    const warnings: string[] = [];
    const gw = makeGateway({ onWarning: (w) => warnings.push(w) });
    const bad = makeFakeProvider({ id: "bad", fail: "boom" });
    const good = makeFakeProvider({
      id: "good",
      resources: () => [
        providerResource("p", { activeJobs: observedValue(1, { sampledAt: NOW }) }),
      ],
    });
    gw.register(bad.provider);
    gw.register(good.provider);
    const snap = await gw.snapshot({ windowMs: 60_000 });
    assert.equal(snap.resources.length, 1);
    assert.equal(gw.lastDiagnostics?.droppedInvalidSnapshots, 0);
    assert.ok(warnings.some((w) => w.includes("bad") && w.includes("boom")));
  });

  it("drops a provider snapshot that fails the snapshot schema", async () => {
    const warnings: string[] = [];
    const gw = makeGateway({ onWarning: (w) => warnings.push(w) });
    const badSchema = {
      provider: {
        id: "bad-schema",
        kind: "omniroute" as const,
        async probe() {
          return { available: true, checkedAt: NOW };
        },
        async snapshot() {
          return fixtureSnapshot([providerResource("p", { queuedJobs: observedValue(-1) })]);
        },
      },
    };
    const good = makeFakeProvider({
      id: "good",
      resources: () => [
        runtimeResource("h1", "rt", { activeJobs: observedValue(2, { sampledAt: NOW }) }),
      ],
    });
    gw.register(badSchema.provider);
    gw.register(good.provider);
    const snap = await gw.snapshot({ windowMs: 60_000 });
    assert.equal(snap.resources.length, 1);
    assert.equal(gw.lastDiagnostics?.droppedInvalidSnapshots, 1);
    assert.ok(warnings.some((w) => w.includes("bad-schema")));
  });
});

describe("gateway: registration bounds + probe", () => {
  it("rejects duplicate provider ids", () => {
    const gw = makeGateway({});
    const a = makeFakeProvider({ id: "dup" });
    gw.register(a.provider);
    assert.throws(() => gw.register(a.provider), /duplicate/);
  });

  it("enforces the max-providers cap", () => {
    const gw = new FleetTelemetryGateway({ now: () => NOW, maxProviders: 1 });
    gw.register(makeFakeProvider({ id: "one" }).provider);
    assert.throws(() => gw.register(makeFakeProvider({ id: "two" }).provider), /max providers/);
  });

  it("probe returns per-provider status without querying snapshots", async () => {
    const gw = makeGateway({});
    const a = makeFakeProvider({ id: "a" });
    gw.register(a.provider);
    const status = await gw.probe();
    assert.equal(status.a.available, true);
    assert.equal(a.snapshotCalls, 0);
  });

  it("probe marks a failing provider unavailable with a message", async () => {
    const gw = makeGateway({});
    const provider = {
      id: "flaky",
      kind: "omniroute" as const,
      async probe() {
        throw new Error("no backend");
      },
      async snapshot() {
        return fixtureSnapshot([]);
      },
    };
    gw.register(provider);
    const status = await gw.probe();
    assert.equal(status.flaky.available, false);
    assert.match(status.flaky.message ?? "", /probe failed/);
  });

  it("unknown providerIds in a query warn and are skipped", async () => {
    const warnings: string[] = [];
    const gw = makeGateway({ onWarning: (w) => warnings.push(w) });
    const a = makeFakeProvider({
      id: "a",
      resources: () => [
        providerResource("p", { activeJobs: observedValue(1, { sampledAt: NOW }) }),
      ],
    });
    gw.register(a.provider);
    const snap = await gw.snapshot({ windowMs: 60_000, providerIds: ["a", "ghost"] });
    assert.equal(snap.resources.length, 1);
    assert.ok(warnings.some((w) => w.includes("ghost")));
  });

  it("query filters are applied to the merged snapshot (hostIds)", async () => {
    const gw = makeGateway({});
    const a = makeFakeProvider({
      id: "a",
      resources: () => [gpuResource("h1", "u"), gpuResource("h2", "u2")],
    });
    gw.register(a.provider);
    const snap = await gw.snapshot({ windowMs: 60_000, hostIds: ["h2"] });
    assert.deepEqual(
      snap.resources.map((r) => r.resourceId),
      ["gpu:h2:u2"]
    );
  });
});

resetFixtureClock(NOW);
