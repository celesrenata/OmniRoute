// #T004 (OR-ATOM-001 v2 / M1) — snapshot normalization invariants.
//
// Covers AC7: alias matching, friendly labels, state precedence
// (active > recent > error/health), absent-vs-zero, stable IDs, and
// "no gpu kind emitted in M1".
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeTopology } from "../../../src/shared/topology/domain/normalizeTopology";
import type {
  TopologySceneNode,
  TopologySceneSnapshot,
} from "../../../src/shared/topology/domain/types";

const CAPTURED_AT = 1_700_000_000_000;

function makeSnapshot(partial: Partial<Parameters<typeof normalizeTopology>[0]> = {}) {
  return normalizeTopology({
    providers: [],
    activeRequests: [],
    lastProvider: "",
    errorProvider: "",
    capturedAt: CAPTURED_AT,
    ...partial,
  });
}

function nodeById(snapshot: TopologySceneSnapshot, id: string): TopologySceneNode {
  const node = snapshot.nodes.find((n) => n.id === id);
  assert.ok(node, `expected node with id "${id}"`);
  return node;
}

test("normalizeTopology: schema shape and stable canonical IDs", () => {
  const snap = makeSnapshot({
    providers: [
      { provider: "openai", name: "OpenAI", status: "active" },
      { provider: "anthropic", name: "Anthropic", status: "idle", routeId: "row-42" },
    ],
  });

  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.capturedAt, CAPTURED_AT);
  assert.equal(snap.nodes.length, 3); // hub + 2 providers
  assert.equal(snap.links.length, 2);

  const hub = snap.nodes[0];
  assert.equal(hub.id, "hub");
  assert.equal(hub.kind, "hub");
  assert.equal(hub.label, "OmniRoute");

  assert.equal(nodeById(snap, "provider:openai").id, "provider:openai");
  assert.equal(nodeById(snap, "provider:anthropic").id, "provider:anthropic");
  assert.equal(nodeById(snap, "provider:anthropic").routeId, "row-42");

  for (const link of snap.links) {
    assert.equal(link.kind, "route");
    assert.equal(link.source, "hub");
    assert.ok(link.target.startsWith("provider:"));
    assert.ok(link.id.startsWith("route:"));
  }
});

test("normalizeTopology: reordering providers does not change canonical ids", () => {
  const a = makeSnapshot({
    providers: [
      { provider: "openai", name: "A" },
      { provider: "anthropic", name: "B" },
    ],
  });
  const b = makeSnapshot({
    providers: [
      { provider: "anthropic", name: "B" },
      { provider: "openai", name: "A" },
    ],
  });
  assert.deepEqual(a.nodes.map((n) => n.id).sort(), b.nodes.map((n) => n.id).sort());
  assert.deepEqual(a.links.map((l) => l.id).sort(), b.links.map((l) => l.id).sort());
});

test("normalizeTopology: alias matching drives traffic state", () => {
  const snap = makeSnapshot({
    providers: [
      { provider: "openai", name: "OpenAI", aliases: ["gpt-route-77"] },
      { provider: "anthropic", name: "Anthropic" },
    ],
    activeRequests: [{ provider: "gpt-route-77", model: "gpt-4o" }],
  });

  assert.equal(nodeById(snap, "provider:openai").traffic, "active");
  assert.equal(nodeById(snap, "provider:anthropic").traffic, "idle");
  assert.equal(nodeById(snap, "hub").traffic, "active");
  assert.equal(nodeById(snap, "hub").activeRequests?.value, 1);
});

test("normalizeTopology: active wins over unhealthy status (precedence)", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai", name: "OpenAI", status: "error" }],
    activeRequests: [{ provider: "openai", model: "gpt-4o" }],
  });
  const node = nodeById(snap, "provider:openai");
  assert.equal(node.traffic, "active");
  assert.equal(node.health, "unhealthy");
});

test("normalizeTopology: recent wins over unhealthy status (precedence)", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai", name: "OpenAI", status: "error" }],
    lastProvider: "openai",
  });
  const node = nodeById(snap, "provider:openai");
  assert.equal(node.traffic, "recent");
  assert.equal(node.health, "unhealthy");
});

test("normalizeTopology: lastProvider maps to traffic=recent", () => {
  const snap = makeSnapshot({
    providers: [
      { provider: "openai", name: "OpenAI" },
      { provider: "anthropic", name: "Anthropic" },
    ],
    lastProvider: "anthropic",
  });
  assert.equal(nodeById(snap, "provider:anthropic").traffic, "recent");
  assert.equal(nodeById(snap, "provider:openai").traffic, "idle");
});

test("normalizeTopology: errorProvider maps to unhealthy + idle traffic", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai", name: "OpenAI" }],
    errorProvider: "openai",
  });
  const node = nodeById(snap, "provider:openai");
  assert.equal(node.health, "unhealthy");
  assert.equal(node.traffic, "idle");
});

test("normalizeTopology: status=active maps to healthy health", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai", name: "OpenAI", status: "active" }],
  });
  assert.equal(nodeById(snap, "provider:openai").health, "healthy");
});

test("normalizeTopology: no status -> unknown health (never fabricated)", () => {
  const snap = makeSnapshot({ providers: [{ provider: "openai", name: "OpenAI" }] });
  assert.equal(nodeById(snap, "provider:openai").health, "unknown");
});

test("normalizeTopology: friendly label prefers entry.name over provider id", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai-compatible-chat-uuid", name: "My Custom Node" }],
  });
  assert.equal(nodeById(snap, "provider:openai-compatible-chat-uuid").label, "My Custom Node");
});

test("normalizeTopology: friendly label falls back to providerId when no name", () => {
  const snap = makeSnapshot({ providers: [{ provider: "my-custom-provider" }] });
  assert.equal(nodeById(snap, "provider:my-custom-provider").label, "my-custom-provider");
});

test("normalizeTopology: absent data is undefined, not 0 (AC invariant)", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai", name: "OpenAI", status: "idle" }],
  });
  const node = nodeById(snap, "provider:openai");
  assert.equal("activeRequests" in node, false);
  assert.equal(node.activeRequests, undefined);
  assert.equal("lastRoutedAt" in node, false);
  assert.equal("latestErrorAt" in node, false);
  assert.equal(nodeById(snap, "hub").activeRequests, undefined);
});

test("normalizeTopology: activeRequests observation only for active, count>0", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai", name: "OpenAI" }],
    activeRequests: [
      { provider: "openai", model: "gpt-4o" },
      { provider: "openai", model: "gpt-4o-mini" },
    ],
  });
  const obs = nodeById(snap, "provider:openai").activeRequests;
  assert.ok(obs, "expected an activeRequests observation");
  assert.equal(obs!.value, 2);
  assert.equal(obs!.source, "live-event");
  assert.equal(obs!.sampledAt, CAPTURED_AT);
});

test("normalizeTopology: M1 never emits kind=gpu", () => {
  const snap = makeSnapshot({
    providers: [
      { provider: "openai", name: "OpenAI", status: "active" },
      { provider: "anthropic", name: "Anthropic", status: "error" },
    ],
    activeRequests: [{ provider: "openai", model: "gpt-4o" }],
    lastProvider: "anthropic",
    errorProvider: "anthropic",
  });
  for (const node of snap.nodes) {
    assert.notEqual(node.kind, "gpu");
    assert.ok(["hub", "provider"].includes(node.kind));
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Lane observation (M4-closure) — the single source of truth for
// `node.lane?: Observed<TopologyLane>`.
//
// The invariants are exactly the ones that keep the topology *honest*:
//   - hub never gets a lane (it's not a provider)
//   - provider with no in-flight models → lane field *absent* (not "unknown")
//   - provider with in-flight models that all classify to the same lane →
//     lane observation with `source: "live-event"`
//   - provider with in-flight models that span multiple lanes → observed
//     `unknown` with a per-model basis (the *one* honest "mixed" state)
//   - provider with only ordinary chat traffic (no classifiable models) →
//     lane field *absent* — the anti-fabrication contract.
// ──────────────────────────────────────────────────────────────────────────────
test("normalizeTopology: hub never gets a lane observation", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai", name: "OpenAI", status: "active" }],
    activeRequests: [{ provider: "openai", model: "whisper-1" }],
  });
  const hub = snap.nodes.find((n) => n.kind === "hub");
  assert.ok(hub, "hub should exist");
  assert.equal("lane" in (hub as object), false, "hub node must never have a lane field");
});

test("normalizeTopology: no in-flight traffic → provider lane field absent", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai", name: "OpenAI", status: "idle" }],
    activeRequests: [],
  });
  const openai = snap.nodes.find((n) => n.kind === "provider" && n.providerId === "openai");
  assert.ok(openai, "openai provider node should exist");
  assert.equal("lane" in (openai as object), false, "no in-flight traffic ⇒ no lane observation");
});

test("normalizeTopology: single-family in-flight traffic → observed lane with source", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai", name: "OpenAI", status: "active" }],
    activeRequests: [
      { provider: "openai", model: "whisper-1" },
      { provider: "openai", model: "whisper-large-v3" },
    ],
  });
  const openai = snap.nodes.find((n) => n.kind === "provider" && n.providerId === "openai");
  assert.ok(openai, "openai provider node should exist");
  assert.ok(openai.lane, "expected a lane observation on the provider node");
  assert.equal(openai.lane!.value, "audio");
  assert.equal(openai.lane!.source, "live-event");
  assert.equal(openai.lane!.sampledAt, CAPTURED_AT);
  assert.ok(typeof openai.lane!.basis === "string");
});

test("normalizeTopology: mixed-family in-flight traffic → observed `unknown` with a per-model basis", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai", name: "OpenAI", status: "active" }],
    activeRequests: [
      { provider: "openai", model: "whisper-1" },
      { provider: "openai", model: "text-embedding-3-small" },
    ],
  });
  const openai = snap.nodes.find((n) => n.kind === "provider" && n.providerId === "openai");
  assert.ok(openai.lane, "expected a lane observation (mixed state)");
  assert.equal(openai.lane!.value, "unknown", "mixed in-flight lanes ⇒ honest `unknown`");
  assert.ok(openai.lane!.basis.includes("whisper-1"), "basis must name the whisper model");
  assert.ok(
    openai.lane!.basis.includes("text-embedding-3-small"),
    "basis must name the embedding model"
  );
});

test("normalizeTopology: only ordinary chat traffic → no lane observation (anti-fabrication)", () => {
  const snap = makeSnapshot({
    providers: [{ provider: "openai", name: "OpenAI", status: "active" }],
    activeRequests: [
      { provider: "openai", model: "gpt-4" },
      { provider: "openai", model: "gpt-4o" },
    ],
  });
  const openai = snap.nodes.find((n) => n.kind === "provider" && n.providerId === "openai");
  assert.ok(openai, "openai provider node should exist");
  assert.equal(
    "lane" in (openai as object),
    false,
    "ordinary chat traffic (no family tokens) ⇒ no fabricated lane observation"
  );
});
