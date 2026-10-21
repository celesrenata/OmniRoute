/**
 * normalizeTopology regression tests (OR-ATOM-001 v2, T004 / M1) —
 * snapshot normalization from provider entries / active requests /
 * last+error, provider aliases and custom nodes, click-through route ids,
 * empty state, active/recent/error precedence and health-vs-traffic
 * separation.
 *
 * Independent of the suite in `normalizeTopology.test.ts`: re-pins the same
 * invariants through the host-facing entry shapes (custom nodes, alias
 * matching, hub in-flight counting) plus the parts that suite does not
 * cover (capturedAt default, invalid-entry filtering, hub active count =
 * distinct providers, lane observations for alias-keyed traffic).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTopology,
  type TopologyNormalizeInput,
} from "@/shared/topology/domain/normalizeTopology";
import type { TopologySceneNode, TopologySceneSnapshot } from "@/shared/topology/domain/types";

const CAPTURED_AT = 1_700_000_000_000;

function normalize(overrides: Partial<TopologyNormalizeInput> = {}): TopologySceneSnapshot {
  return normalizeTopology({
    providers: [],
    activeRequests: [],
    lastProvider: "",
    errorProvider: "",
    capturedAt: CAPTURED_AT,
    ...overrides,
  });
}

function byId(snapshot: TopologySceneSnapshot, id: string): TopologySceneNode {
  const node = snapshot.nodes.find((n) => n.id === id);
  assert.ok(node, `expected node "${id}" in snapshot`);
  return node;
}

test("normalizeTopology: empty input → hub-only snapshot, no links (empty state)", () => {
  const snap = normalize();
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.capturedAt, CAPTURED_AT);
  assert.equal(snapshotNodeCount(snap), 1);
  assert.deepEqual(snap.links, []);
  const hub = snap.nodes[0];
  assert.equal(hub.id, "hub");
  assert.equal(hub.kind, "hub");
  assert.equal(hub.health, "unknown", "hub health is never fabricated");
  assert.equal(hub.traffic, "idle");
  assert.equal(hub.activeRequests, undefined, "absent is never 0");
});

function snapshotNodeCount(snapshot: TopologySceneSnapshot): number {
  return snapshot.nodes.length;
}

test("normalizeTopology: capturedAt defaults to now when omitted", () => {
  const before = Date.now();
  const snap = normalizeTopology({ providers: [] });
  const after = Date.now();
  assert.ok(snap.capturedAt >= before && snap.capturedAt <= after);
});

test("normalizeTopology: provider entries become canonical provider:<id> nodes with hub route links", () => {
  const snap = normalize({ providers: [{ provider: "openai" }, { provider: "anthropic" }] });
  assert.equal(snapshotNodeCount(snap), 3, "hub + 2 providers");
  const node = byId(snap, "provider:openai");
  assert.equal(node.kind, "provider");
  assert.equal(node.providerId, "openai");
  assert.equal(node.health, "unknown", "no status → unknown, never fabricated");
  assert.equal(node.traffic, "idle");
  const link = snap.links.find((l) => l.target === "provider:anthropic");
  assert.ok(link, "route link exists");
  assert.equal(link.id, "route:anthropic", "canonical route id");
  assert.equal(link.source, "hub");
  assert.equal(link.kind, "route");
});

test("normalizeTopology: custom provider node (no built-in config) labels by id; entry name wins", () => {
  const snap = normalize({
    providers: [{ provider: "custom-node-uuid-1", name: "My Custom Whisper" }],
  });
  const node = byId(snap, "provider:custom-node-uuid-1");
  assert.equal(node.label, "My Custom Whisper", "custom name is preserved, not the raw id");

  const snap2 = normalize({ providers: [{ provider: "custom-node-uuid-2" }] });
  assert.equal(byId(snap2, "provider:custom-node-uuid-2").label, "custom-node-uuid-2");
});

test("normalizeTopology: built-in provider label falls back to the config name", () => {
  const snap = normalize({ providers: [{ provider: "openai" }] });
  assert.equal(byId(snap, "provider:openai").label, "OpenAI");
});

test("normalizeTopology: active requests mark traffic=active with an in-flight observation", () => {
  const snap = normalize({
    providers: [{ provider: "openai" }],
    activeRequests: [{ provider: "openai", model: "gpt-4o" }],
  });
  const node = byId(snap, "provider:openai");
  assert.equal(node.traffic, "active");
  assert.equal(node.health, "unknown", "traffic must not fabricate connection health");
  assert.deepEqual(node.activeRequests, {
    value: 1,
    source: "live-event",
    sampledAt: CAPTURED_AT,
    basis: "in-flight request set (WS live requests channel)",
  });
  assert.equal(
    node.lane,
    undefined,
    "ordinary chat traffic → no lane observation (anti-fabrication)"
  );
});

test("normalizeTopology: active matching is case-insensitive and alias-driven", () => {
  const snap = normalize({
    providers: [{ provider: "ArcEmbed", aliases: ["arc-embeddings"] }],
    activeRequests: [
      { provider: "ARCEMBED", model: "text-embedding-3-small" },
      { provider: "arc-embeddings", model: "text-embedding-3-small" },
    ],
  });
  const node = byId(snap, "provider:ArcEmbed");
  assert.equal(node.traffic, "active");
  assert.equal(node.activeRequests?.value, 2, "both the id-keyed and alias-keyed requests count");
  assert.equal(node.activeRequests?.source, "live-event");
  assert.equal(node.lane?.value, "embedding");
  assert.equal(node.lane?.source, "live-event");
  assert.equal(node.lane?.sampledAt, CAPTURED_AT);
  assert.ok(node.lane?.basis?.includes("text-embedding-3-small"));
});

test("normalizeTopology: active wins over recent (lastProvider) and error (errorProvider)", () => {
  const snap = normalize({
    providers: [{ provider: "openai", status: "idle" }],
    activeRequests: [{ provider: "openai", model: "gpt-4o" }],
    lastProvider: "openai",
    errorProvider: "openai",
  });
  const node = byId(snap, "provider:openai");
  assert.equal(node.traffic, "active", "active > recent > error for traffic state");
  assert.equal(node.health, "unknown", "errorProvider only matters when not active");
});

test("normalizeTopology: recent (last) wins over idle, idle wins over nothing", () => {
  const snap = normalize({
    providers: [{ provider: "a" }, { provider: "b" }, { provider: "c" }],
    lastProvider: "B",
  });
  assert.equal(byId(snap, "provider:a").traffic, "idle");
  assert.equal(byId(snap, "provider:b").traffic, "recent", "lastProvider is case-insensitive");
  assert.equal(byId(snap, "provider:b").health, "unknown");
  assert.equal(byId(snap, "provider:c").traffic, "idle");
});

test("normalizeTopology: traffic error (errorProvider) → unhealthy + idle traffic (not active/recent)", () => {
  const snap = normalize({
    providers: [{ provider: "openai" }],
    errorProvider: "OPENAI",
    lastProvider: "openai",
  });
  const node = byId(snap, "provider:openai");
  assert.equal(
    node.health,
    "unhealthy",
    "traffic error records unhealthy (no separate dimension in M1)"
  );
  assert.equal(node.traffic, "idle", "error does not light up recent/active traffic");
  assert.equal(node.activeRequests, undefined);
});

test("normalizeTopology: status=error → unhealthy even with in-flight traffic (health vs traffic separation)", () => {
  const snap = normalize({
    providers: [{ provider: "openai", status: "error" }],
    activeRequests: [{ provider: "openai", model: "gpt-4o" }],
  });
  const node = byId(snap, "provider:openai");
  assert.equal(node.health, "unhealthy");
  assert.equal(node.traffic, "active", "traffic state is independent of connection health");
});

test("normalizeTopology: status=active → healthy health with idle traffic (healthy base state)", () => {
  const snap = normalize({ providers: [{ provider: "openai", status: "active" }] });
  const node = byId(snap, "provider:openai");
  assert.equal(node.health, "healthy");
  assert.equal(node.traffic, "idle", "a healthy connection without traffic stays idle");
  assert.equal(node.activeRequests, undefined);
});

test("normalizeTopology: status=error beats a healthy-looking alias key (error is the health base)", () => {
  const snap = normalize({
    providers: [{ provider: "openai", status: "error" }],
    errorProvider: "openai",
  });
  assert.equal(byId(snap, "provider:openai").health, "unhealthy");
});

test("normalizeTopology: click-through routeId and aliases are carried onto the node (or absent)", () => {
  const snap = normalize({
    providers: [{ provider: "a", routeId: "row-7", aliases: ["a-alias", "a2"] }, { provider: "b" }],
  });
  const a = byId(snap, "provider:a");
  assert.equal(a.routeId, "row-7");
  assert.deepEqual(a.aliases, ["a-alias", "a2"]);
  const b = byId(snap, "provider:b");
  assert.equal(b.routeId, undefined);
  assert.equal(b.aliases, undefined, "absent metadata stays absent (never empty arrays)");
});

test("normalizeTopology: invalid entries (null / missing provider) are skipped, order preserved", () => {
  const snap = normalize({
    providers: [
      null,
      { provider: "" },
      { provider: "openai" },
      { name: "no provider field" },
      { provider: "anthropic" },
    ] as never,
  });
  assert.equal(snapshotNodeCount(snap), 3);
  assert.deepEqual(
    snap.nodes.map((n) => n.id),
    ["hub", "provider:openai", "provider:anthropic"]
  );
});

test("normalizeTopology: hub active state counts distinct in-flight providers", () => {
  const snap = normalize({
    activeRequests: [
      { provider: "openai", model: "gpt-4o" },
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "anthropic", model: "claude-sonnet" },
      { model: "orphan-no-provider" },
    ],
  });
  const hub = snap.nodes[0];
  assert.equal(hub.traffic, "active");
  assert.equal(hub.activeRequests?.value, 2, "distinct providers, not request count");
  assert.equal(hub.activeRequests?.source, "live-event");
  assert.match(hub.activeRequests?.basis ?? "", /in-flight provider set/);
});

test("normalizeTopology: lastRoutedAt / latestErrorAt timestamps are never fabricated (absent in M1)", () => {
  const snap = normalize({
    providers: [{ provider: "openai" }],
    lastProvider: "openai",
    errorProvider: "openai",
  });
  const node = byId(snap, "provider:openai");
  assert.equal(node.lastRoutedAt, undefined);
  assert.equal(node.latestErrorAt, undefined);
});
