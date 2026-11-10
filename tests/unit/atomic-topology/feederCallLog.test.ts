/**
 * Directives 40/41: feeder traces driven by REAL call-log rows (the live lifecycle feed can be
 * unavailable, e.g. a rejected websocket origin). Root cause covered here: the feeder call rate
 * read only the live event pool, so real completed requests in the call log never lit feeders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RECENT_CALLS_MAX,
  RECENT_CALLS_WINDOW_MS,
  deriveRecentCallTimes,
  recentCallsForEntry,
  recentCallsSignature,
  recentModelsSignature,
  type RecentCallLogRow,
} from "../../../src/shared/topology/domain/recentModels";
import { normalizeTopology } from "../../../src/shared/topology/domain/normalizeTopology";
import { resolveAtomDescriptors } from "../../../src/plugins/atomic-topology";
import {
  atomFeederSignal,
  callLogPerMinute,
  feederTarget,
} from "../../../src/plugins/atomic-topology/scene/feederUsage";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
let seq = 0;
const row = (over: Partial<RecentCallLogRow>): RecentCallLogRow => ({
  id: `r${(seq += 1)}`,
  provider: "openai",
  model: "gpt-4o",
  status: 200,
  timestamp: ago(1000),
  ...over,
});
const providers = [
  { provider: "openai", status: "active" as const },
  { provider: "anthropic", status: "active" as const },
];

test("deriveRecentCallTimes: completed real rows in the last minute, deduped, newest first", () => {
  const rows = [
    row({ timestamp: ago(5_000) }),
    row({ timestamp: ago(30_000), status: 500, error: "upstream" }), // a failed call is still usage
    row({ timestamp: ago(61_000) }), // outside the window
    row({ timestamp: ago(2_000), active: true }), // still in flight: not a completed call
    row({ timestamp: ago(3_000), completed: false }),
    row({ timestamp: ago(4_000), model: "connection-test" }), // health probe
    row({ timestamp: ago(4_000), path: "/api/providers/test" }),
    row({ timestamp: new Date(NOW + 5_000).toISOString() }), // future
    row({ timestamp: "garbage" }),
    row({ provider: "" }),
  ];
  const dup = row({ timestamp: ago(10_000) });
  rows.push(dup, { ...dup });
  const m = deriveRecentCallTimes(rows, { now: NOW });
  assert.deepEqual(m.get("openai"), [NOW - 5_000, NOW - 10_000, NOW - 30_000]);
  assert.equal(m.size, 1);
  assert.equal(RECENT_CALLS_WINDOW_MS, 60_000);
});

test("deriveRecentCallTimes: an in-memory entry and its persisted row are one call", () => {
  // Shape observed live on /api/usage/call-logs: start-stamped in-memory row + completion-stamped DB row.
  const start = NOW - 20_000;
  const inMem = row({
    timestamp: new Date(start).toISOString(),
    duration: 6126,
    connectionId: "c1",
    detailState: "in-memory",
  });
  const persisted = row({
    timestamp: new Date(start + 6126).toISOString(),
    duration: 6126,
    connectionId: "c1",
  });
  assert.deepEqual(deriveRecentCallTimes([inMem, persisted], { now: NOW }).get("openai"), [
    start + 6126,
  ]);
  // Before the DB write lands, the in-memory entry alone counts (completion time).
  assert.deepEqual(deriveRecentCallTimes([inMem], { now: NOW }).get("openai"), [start + 6126]);
  // A different call with the same duration but far apart in time is not collapsed.
  const other = row({
    timestamp: new Date(start + 15_000).toISOString(),
    duration: 6126,
    connectionId: "c1",
  });
  assert.equal(deriveRecentCallTimes([inMem, other], { now: NOW }).get("openai")?.length, 2);
});

test("recentCallsForEntry merges aliases and caps the sample", () => {
  const m = new Map<string, number[]>([
    ["openai", [NOW - 1, NOW - 3]],
    ["oai", [NOW - 2]],
  ]);
  assert.deepEqual(recentCallsForEntry(m, { provider: "openai", aliases: ["oai"] }), [
    NOW - 1,
    NOW - 2,
    NOW - 3,
  ]);
  assert.equal(recentCallsForEntry(m, { provider: "anthropic" }), null);
  const many = new Map([["x", Array.from({ length: 500 }, (_, i) => NOW - i)]]);
  assert.equal(recentCallsForEntry(many, { provider: "x" })?.length, RECENT_CALLS_MAX);
});

test("normalizeTopology: recentCalls only where real calls exist (call-log provenance)", () => {
  const snap = normalizeTopology({
    providers,
    activeRequests: [],
    recentCallLogs: [row({ timestamp: ago(2_000) }), row({ timestamp: ago(9_000) })],
    capturedAt: NOW,
  });
  const openai = snap.nodes.find((n) => n.providerId === "openai");
  assert.deepEqual(openai?.recentCalls?.value, [NOW - 2_000, NOW - 9_000]);
  assert.equal(openai?.recentCalls?.source, "call-log");
  assert.equal(openai?.recentCalls?.windowMs, 60_000);
  assert.equal(
    "recentCalls" in (snap.nodes.find((n) => n.providerId === "anthropic") ?? {}),
    false
  );
  assert.equal("recentCalls" in (snap.nodes.find((n) => n.kind === "hub") ?? {}), false);
  const none = normalizeTopology({ providers, activeRequests: [], capturedAt: NOW });
  assert.equal(JSON.stringify(none).includes("recentCalls"), false);
});

test("signatures: models ignore call timing; calls change only on a real new call", () => {
  const a = [row({ timestamp: ago(5_000) })];
  const b = [...a, row({ timestamp: ago(1_000) })];
  assert.equal(recentModelsSignature(a, NOW), recentModelsSignature(b, NOW));
  assert.notEqual(recentCallsSignature(a, NOW), recentCallsSignature(b, NOW));
  // Same rows, a new poll array: unchanged.
  assert.equal(recentCallsSignature([...b], NOW), recentCallsSignature(b, NOW));
  assert.equal(recentCallsSignature([], NOW), "");
});

test("descriptors + feeder: provider and hub lit by real call-log rows; others stay zero", () => {
  const snap = normalizeTopology({
    providers,
    activeRequests: [],
    recentCallLogs: Array.from({ length: 12 }, (_, i) =>
      row({ timestamp: ago(2_000 + i * 4_000) })
    ),
    capturedAt: NOW,
  });
  const ds = resolveAtomDescriptors(snap);
  const ctx = { events: null, nowMs: NOW, inFlightStale: true };
  const openai = ds.find((d) => d.providerId === "openai")!;
  const anthropic = ds.find((d) => d.providerId === "anthropic")!;
  const hub = ds.find((d) => d.kind === "hub")!;
  const so = atomFeederSignal(openai, ctx);
  assert.equal(so.basis, "calls");
  assert.equal(so.value, 12);
  assert.ok(feederTarget(so) > 0);
  const sh = atomFeederSignal(hub, ctx);
  assert.equal(sh.basis, "calls");
  assert.equal(sh.value, 12);
  const sa = atomFeederSignal(anthropic, ctx);
  assert.equal(feederTarget(sa), 0, "no call-log rows -> no feeder effect");
  // The rate decays on the renderer clock without a new snapshot: 70 s later nothing is left.
  assert.equal(feederTarget(atomFeederSignal(openai, { ...ctx, nowMs: NOW + 70_000 })), 0);
  // Replay never reads live call-log rows.
  assert.equal(feederTarget(atomFeederSignal(openai, { ...ctx, callLog: false })), 0);
});

test("live events and call-log rows describe the same requests: max, never summed", () => {
  const d = {
    kind: "provider" as const,
    providerId: "openai",
    measuredTps: null,
    activeRequests: null,
    recentCallTimes: [NOW - 1_000, NOW - 2_000],
  };
  const events = [1, 2, 3].map((i) => ({
    at: NOW - i * 1_000,
    kind: "request-started",
    providerId: "openai",
  }));
  const s = atomFeederSignal(d, { events, nowMs: NOW, inFlightStale: true });
  assert.equal(s.basis, "calls");
  assert.equal(s.value, 3);
  assert.equal(callLogPerMinute(null, NOW), null);
  assert.equal(callLogPerMinute([], NOW), 0);
  assert.equal(callLogPerMinute([NOW - 59_000, NOW - 61_000, NOW + 5], NOW), 1);
});
