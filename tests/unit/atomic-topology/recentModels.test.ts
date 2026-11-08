/**
 * Real observed model ids from call-log rows: deriveRecentProviderModels,
 * normalizeTopology `observedModels`, and descriptor/tooltip provenance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RECENT_MODELS_WINDOW_MS,
  deriveRecentProviderModels,
  recentModelsForEntry,
  recentModelsSignature,
  type RecentCallLogRow,
} from "../../../src/shared/topology/domain/recentModels";
import { normalizeTopology } from "../../../src/shared/topology/domain/normalizeTopology";
import { resolveAtomDescriptors, modelColor } from "../../../src/plugins/atomic-topology";
import { modelProvenanceRows } from "../../../src/plugins/atomic-topology/overlays/AtomicTooltip";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const row = (over: Partial<RecentCallLogRow>): RecentCallLogRow => ({
  provider: "openai",
  model: "gpt-4o",
  status: 200,
  timestamp: ago(1000),
  ...over,
});

test("ranks by count desc then id, caps at 3, canonicalizes", () => {
  const rows = [
    row({ model: " GPT-4o " }),
    row({ model: "gpt-4o" }),
    row({ model: "b-model" }),
    row({ model: "a-model" }),
    row({ model: "z-model" }),
  ];
  const tally = deriveRecentProviderModels(rows, { now: NOW }).get("openai");
  assert.deepEqual(tally?.models, ["gpt-4o", "a-model", "b-model"]);
});

test("is order-independent", () => {
  const rows = [row({ model: "x" }), row({ model: "y" }), row({ model: "y" }), row({ model: "w" })];
  const a = deriveRecentProviderModels(rows, { now: NOW }).get("openai");
  const b = deriveRecentProviderModels([...rows].reverse(), { now: NOW }).get("openai");
  assert.deepEqual(a?.models, b?.models);
  assert.deepEqual(a?.models, ["y", "w", "x"]);
});

test("drops errors, in-flight, test probes, stale, future and malformed rows", () => {
  const rows = [
    row({ status: 500 }),
    row({ status: 429 }),
    row({ error: "boom" }),
    row({ status: 0, active: true }),
    row({ model: "connection-test" }),
    row({ sourceFormat: "test" }),
    row({ timestamp: ago(RECENT_MODELS_WINDOW_MS + 1) }),
    row({ timestamp: new Date(NOW + 60_000).toISOString() }),
    row({ timestamp: "not-a-date" }),
    row({ model: "" }),
    row({ provider: "" }),
  ];
  assert.equal(deriveRecentProviderModels(rows, { now: NOW }).size, 0);
});

test("merges alias keys and returns null when nothing qualifies", () => {
  const tallies = deriveRecentProviderModels(
    [row({ provider: "alias-a", model: "m1" }), row({ provider: "openai", model: "m2" })],
    { now: NOW }
  );
  const merged = recentModelsForEntry(tallies, { provider: "openai", aliases: ["Alias-A"] });
  assert.deepEqual(merged?.models, ["m1", "m2"]);
  assert.equal(recentModelsForEntry(tallies, { provider: "other" }), null);
});

test("signature ignores timestamps but tracks the model set", () => {
  const a = recentModelsSignature([row({ timestamp: ago(1000) })], NOW);
  const b = recentModelsSignature([row({ timestamp: ago(5000) })], NOW);
  const c = recentModelsSignature([row({ model: "other" })], NOW);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

const providers = [
  { provider: "openai", status: "active" as const },
  { provider: "anthropic", status: "active" as const },
];

test("normalizeTopology: observedModels carries call-log provenance; absent otherwise", () => {
  const snap = normalizeTopology({
    providers,
    activeRequests: [],
    recentCallLogs: [row({ model: "gpt-4o" })],
    capturedAt: NOW,
  });
  const openai = snap.nodes.find((n) => n.providerId === "openai");
  assert.deepEqual(openai?.observedModels?.value, ["gpt-4o"]);
  assert.equal(openai?.observedModels?.source, "call-log");
  assert.equal(openai?.observedModels?.windowMs, RECENT_MODELS_WINDOW_MS);
  assert.ok(openai?.observedModels?.basis);
  const anthropic = snap.nodes.find((n) => n.providerId === "anthropic");
  assert.equal("observedModels" in (anthropic ?? {}), false);
  const hub = snap.nodes.find((n) => n.kind === "hub");
  assert.equal("observedModels" in (hub ?? {}), false);
});

test("normalizeTopology: snapshots without call logs are unchanged (no field)", () => {
  const without = normalizeTopology({ providers, activeRequests: [], capturedAt: NOW });
  const empty = normalizeTopology({
    providers,
    activeRequests: [],
    recentCallLogs: [],
    capturedAt: NOW,
  });
  assert.equal(JSON.stringify(without), JSON.stringify(empty));
  assert.equal(JSON.stringify(without).includes("observedModels"), false);
});

test("descriptors: provider ids + colors from in-flight first, then call-log, deduped, max 3", () => {
  const snap = normalizeTopology({
    providers,
    activeRequests: [{ provider: "openai", model: "Live-Model" }],
    recentCallLogs: [
      row({ model: "live-model" }),
      row({ model: "log-a" }),
      row({ model: "log-b" }),
      row({ model: "log-c" }),
    ],
    capturedAt: NOW,
  });
  const d = resolveAtomDescriptors(snap).find((x) => x.providerId === "openai");
  assert.deepEqual(d?.observedModelIds, ["live-model", "log-a", "log-b"]);
  assert.deepEqual(
    d?.modelColors,
    ["live-model", "log-a", "log-b"].map((m) => modelColor(m))
  );
  assert.deepEqual(d?.observedModelSources?.inFlight, ["live-model"]);
  assert.deepEqual(
    modelProvenanceRows(d!).map((r) => r.label),
    ["Models (live in-flight)", "Models (call-log, last 15 min)"]
  );
});

test("descriptors: no calls -> neutral, no ids, no fabricated model", () => {
  const snap = normalizeTopology({
    providers,
    activeRequests: [],
    recentCallLogs: [row({ status: 500 }), row({ timestamp: ago(RECENT_MODELS_WINDOW_MS + 5) })],
    capturedAt: NOW,
  });
  for (const d of resolveAtomDescriptors(snap)) {
    assert.equal(d.observedModelIds, undefined);
    assert.deepEqual(d.modelColors, []);
    assert.deepEqual(modelProvenanceRows(d), []);
  }
});

test("descriptors: hub never gets observed models", () => {
  const snap = normalizeTopology({
    providers,
    activeRequests: [],
    recentCallLogs: [row({ provider: "hub" })],
    capturedAt: NOW,
  });
  const hub = resolveAtomDescriptors(snap).find((x) => x.kind === "hub");
  assert.equal(hub?.observedModelIds, undefined);
});
