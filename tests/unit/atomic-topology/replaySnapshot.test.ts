/**
 * Step 12: the replay snapshot is built ONLY from recorded requests. Live telemetry is
 * suspended, layout/membership is unchanged, and nothing is invented.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAtomDescriptors, resolveLinkDescriptors } from "@/plugins/atomic-topology";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";
import type { ReconciliationResult } from "@/shared/topology/telemetry/reconcile";
import { buildTraceTimeline } from "@/shared/topology/telemetry/traceHistory";
import {
  REPLAY_RESULT_HOLD_MS,
  buildReplayRequests,
  buildReplaySnapshot,
  neutralizeFleetTelemetry,
  replaySnapshotKey,
  trafficHeat,
} from "../../../src/plugins/atomic-topology/scene/replaySnapshot.ts";

const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const obs = (value: number | null) => ({
  value,
  source: "derived" as const,
  sampledAt: T0,
});

function liveSnapshot(withFleet = false): TopologySceneSnapshot {
  const fleet: ReconciliationResult = {
    schemaVersion: 1,
    capturedAt: T0,
    gpuNodes: [
      {
        resourceId: "gpu:h1:uuid-1",
        hostId: "h1",
        deviceUuid: "uuid-1",
        utilizationPercent: obs(66),
        vramUsedBytes: obs(4e9),
        vramTotalBytes: obs(16e9),
        temperatureC: obs(55),
        powerWatts: obs(220),
        outputTokensPerSecond: obs(12),
        stale: false,
      },
    ],
    runtimeNodes: [],
    providerNodes: [
      {
        resourceId: "provider:openai",
        providerId: "openai",
        outputTokensPerSecond: obs(40),
        queuedJobs: obs(5),
        stale: false,
      },
    ],
    edges: [],
    providerCentricFallback: false,
  };
  return {
    schemaVersion: 1,
    capturedAt: T0 + 999_999,
    nodes: [
      { id: "hub", kind: "hub", label: "Router", health: "unknown", traffic: "active" },
      {
        id: "provider:openai",
        kind: "provider",
        label: "OpenAI",
        providerId: "openai",
        health: "healthy",
        traffic: "active",
        activeRequests: { value: 7, source: "live-event", sampledAt: T0 },
        inFlightModels: { value: ["live-only-model"], source: "live-event", sampledAt: T0 },
      },
      {
        id: "provider:anthropic",
        kind: "provider",
        label: "Anthropic",
        providerId: "anthropic",
        aliases: ["claude"],
        health: "unhealthy",
        traffic: "idle",
        latestErrorAt: T0,
      },
    ],
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
        health: "unhealthy",
        traffic: "idle",
      },
    ],
    lifecycle: [{ phase: "started", requestId: "live-1", provider: "openai", observedAt: T0 }],
    ...(withFleet ? { fleetTelemetry: fleet } : {}),
  };
}

const rows = [
  // openai: in flight 1000..4000, ok
  {
    id: "o1",
    timestamp: iso(T0 + 1000),
    provider: "openai",
    model: "gpt-4o",
    status: 200,
    duration: 3000,
  },
  // anthropic (alias "claude"): fails at 6000+500
  {
    id: "a1",
    timestamp: iso(T0 + 6000),
    provider: "claude",
    model: "claude-3-5-sonnet",
    status: 529,
    duration: 500,
  },
];
const timeline = buildTraceTimeline(rows, { sinceMs: T0, untilMs: T0 + 60_000 });
const reqs = buildReplayRequests(timeline.records);
const node = (s: TopologySceneSnapshot, id: string) => s.nodes.find((n) => n.id === id)!;

test("before any record: everything idle, live-only facts are gone", () => {
  const s = buildReplaySnapshot(liveSnapshot(), reqs, T0);
  const o = node(s, "provider:openai");
  assert.equal(o.traffic, "idle");
  assert.equal(o.activeRequests, undefined);
  assert.equal(o.inFlightModels, undefined);
  assert.equal(o.lane, undefined);
  assert.equal(o.observedModels, undefined);
  assert.equal(node(s, "hub").traffic, "idle");
  assert.equal(s.capturedAt, T0);
  assert.equal(s.lifecycle, undefined, "live lifecycle stream is suspended");
});

test("a recorded in-flight request makes exactly that provider (and the hub) active", () => {
  const s = buildReplaySnapshot(liveSnapshot(), reqs, T0 + 2000);
  const o = node(s, "provider:openai");
  assert.equal(o.traffic, "active");
  assert.equal(o.activeRequests?.value, 1);
  assert.equal(o.activeRequests?.source, "call-log");
  assert.deepEqual(o.inFlightModels?.value, ["gpt-4o"]);
  assert.equal(node(s, "provider:anthropic").traffic, "idle");
  assert.equal(node(s, "hub").traffic, "active");
  assert.equal(node(s, "hub").activeRequests?.value, 1);
  assert.equal(s.links.find((l) => l.id === "route:openai")!.traffic, "active");
});

test("after completion: recent for the hold window, then idle; recent models feed the nucleus", () => {
  const justDone = buildReplaySnapshot(liveSnapshot(), reqs, T0 + 4000 + 100);
  assert.equal(node(justDone, "provider:openai").traffic, "recent");
  assert.deepEqual(node(justDone, "provider:openai").observedModels?.value, ["gpt-4o"]);
  const later = buildReplaySnapshot(liveSnapshot(), reqs, T0 + 4000 + REPLAY_RESULT_HOLD_MS + 1);
  assert.equal(node(later, "provider:openai").traffic, "idle");
  // the model stays a recent model (call-log window) so the nucleus colour and afterglow persist
  assert.deepEqual(node(later, "provider:openai").observedModels?.value, ["gpt-4o"]);
});

test("a recorded failure shows the error state through an alias, then clears", () => {
  const during = buildReplaySnapshot(liveSnapshot(), reqs, T0 + 6600);
  const a = node(during, "provider:anthropic");
  assert.equal(a.latestErrorAt, T0 + 6500);
  assert.equal(a.health, "unhealthy");
  const links = resolveLinkDescriptors(during);
  assert.equal(links.find((l) => l.id === "route:anthropic")!.visualState.state, "error");
  const after = buildReplaySnapshot(liveSnapshot(), reqs, T0 + 6500 + REPLAY_RESULT_HOLD_MS + 1);
  const b = node(after, "provider:anthropic");
  assert.equal(b.latestErrorAt, undefined);
  // a live "unhealthy" is not a recorded fact: it reads as unknown, never asserted
  assert.equal(b.health, "unknown");
});

test("the same inputs give the same snapshot; the change key ignores the clock only", () => {
  const a = buildReplaySnapshot(liveSnapshot(), reqs, T0 + 2000);
  const b = buildReplaySnapshot(liveSnapshot(), reqs, T0 + 2500);
  assert.deepEqual(buildReplaySnapshot(liveSnapshot(), reqs, T0 + 2000), a);
  assert.equal(replaySnapshotKey(a), replaySnapshotKey(b));
  const c = buildReplaySnapshot(liveSnapshot(), reqs, T0 + 5000);
  assert.notEqual(replaySnapshotKey(a), replaySnapshotKey(c));
});

test("empty history: no activity is ever invented", () => {
  const none = buildReplayRequests([]);
  for (const at of [T0, T0 + 5000, T0 + 59_000]) {
    const s = buildReplaySnapshot(liveSnapshot(), none, at);
    for (const n of s.nodes) assert.equal(n.traffic, "idle");
    for (const l of s.links) assert.equal(l.traffic, "idle");
  }
});

test("live telemetry is suspended: fleet measurements read 'no data' but atoms and layout stay", () => {
  const live = liveSnapshot(true);
  const replay = buildReplaySnapshot(live, reqs, T0 + 2000);
  const liveD = resolveAtomDescriptors(live);
  const repD = resolveAtomDescriptors(replay);
  assert.deepEqual(
    repD.map((d) => [d.id, d.position]),
    liveD.map((d) => [d.id, d.position]),
    "same atoms at the same positions (the camera framing must not move)"
  );
  const liveOpenAi = liveD.find((d) => d.id === "provider:openai")!;
  assert.equal(liveOpenAi.spin.mode, "measured", "precondition: live data does drive spin");
  const rep = repD.find((d) => d.id === "provider:openai")!;
  assert.notEqual(rep.spin.mode, "measured");
  assert.equal(rep.measuredTps, null);
  assert.notEqual(rep.vibration.mode, "measured");
  const gpu = repD.find((d) => d.kind === "gpu")!;
  assert.equal(gpu.deviceFacts?.kind, "gpu");
  if (gpu.deviceFacts?.kind === "gpu") {
    assert.equal(gpu.deviceFacts.utilizationPercent, null);
    assert.equal(gpu.deviceFacts.temperatureC, null);
    assert.equal(gpu.deviceFacts.powerWatts, null);
  }
  // the live input is never mutated
  assert.equal(live.fleetTelemetry!.gpuNodes[0].utilizationPercent!.value, 66);
  assert.deepEqual(
    resolveLinkDescriptors(replay).map((l) => [l.id, l.proven]),
    resolveLinkDescriptors(live).map((l) => [l.id, l.proven])
  );
});

test("neutralizeFleetTelemetry nulls every Observed and marks nodes stale, keeping identities", () => {
  const n = neutralizeFleetTelemetry({
    id: "x",
    stale: false,
    a: { value: 5, source: "derived", sampledAt: 1 },
    list: [{ value: 0, source: "derived", sampledAt: 1 }],
  });
  assert.equal(n.id, "x");
  assert.equal(n.stale, true);
  assert.equal(n.a.value, null);
  assert.equal(n.a.stale, true);
  assert.equal(n.list[0].value, null, "a measured zero is not kept either");
});

test("trafficHeat: zero without records, decays with age, saturates, ignores the future", () => {
  const ev = [
    { at: T0, providerId: "openai" },
    { at: T0 + 1000, providerId: "openai" },
    { at: T0 + 500, providerId: "anthropic" },
  ];
  assert.equal(trafficHeat([], "openai", T0), 0);
  assert.equal(trafficHeat(null, "openai", T0), 0);
  assert.equal(trafficHeat(ev, "nobody", T0 + 1000), 0);
  assert.equal(trafficHeat(ev, "openai", T0 - 1), 0, "future events contribute nothing");
  const h1 = trafficHeat(ev, "openai", T0 + 1000);
  const h2 = trafficHeat(ev, "openai", T0 + 30_000);
  const h3 = trafficHeat(ev, "openai", T0 + 300_000);
  assert.ok(h1 > h2 && h2 > h3 && h3 >= 0);
  assert.ok(h1 < 1);
  const many = Array.from({ length: 500 }, () => ({ at: T0, providerId: "openai" }));
  assert.ok(trafficHeat(many, "openai", T0) <= 1);
  assert.equal(trafficHeat(ev, "OpenAI", T0 + 1000), h1, "provider join is case-insensitive");
});
