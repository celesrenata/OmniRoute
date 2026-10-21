/**
 * Regression tests — home-topology pure helpers: custom provider nodes
 * (withProviderNodeEntries), active-request mapping, alias-aware set
 * matching, and label resolution; plus complementary canonical-id and
 * lane-derivation pins (OR-ATOM-001 v2).
 *
 * Complements (does not duplicate) the root-level suites
 * `topology-active-requests-3507`, `topology-label-3198`,
 * `topology-provider-nodes-arc` and the in-place
 * `layoutIdentity.test.ts` / `lane.test.ts`: re-pins the host-helper
 * contracts the renderer-neutral snapshot pipeline consumes from inside
 * `tests/unit/topology/`, including the branches those suites leave
 * un-pinned (name fallback chain, prefix alias-merge, gpu id shapes,
 * mixed-lane basis, set-matching on aliases without a provider hit).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  selectActiveRequests,
  withProviderNodeEntries,
  isTopologyEntryInSet,
  type TopologyEntry,
  type TopologyNodeRow,
} from "@/app/(dashboard)/home/topologyUtils";
import { resolveTopologyNodeLabel } from "@/app/(dashboard)/home/topologyLabel";
import {
  HUB_NODE_ID,
  providerNodeId,
  gpuNodeId,
  providerRouteLinkId,
  parseAtomId,
} from "@/shared/topology/domain/layoutIdentity";
import { deriveLaneFromModel, deriveLaneForProvider } from "@/shared/topology/domain/lane";

/* ------------------------------------------------------------------ */
/* selectActiveRequests                                                */
/* ------------------------------------------------------------------ */

test("selectActiveRequests: maps in-flight requests to fresh {provider, model} rows", () => {
  const requests: Array<{ provider: string; model: string; id?: string; startedAt?: number }> = [
    { provider: "openai", model: "gpt-4o", id: "req-1", startedAt: 1 },
    { provider: "anthropic", model: "claude-sonnet-4" },
  ];
  const mapped = selectActiveRequests(requests);
  assert.deepEqual(mapped, [
    { provider: "openai", model: "gpt-4o" },
    { provider: "anthropic", model: "claude-sonnet-4" },
  ]);
  assert.notEqual(mapped[0], requests[0], "mapped rows are fresh objects, not input references");
  assert.equal(
    "id" in (mapped[0] as Record<string, unknown>),
    false,
    "extra input fields are dropped, not carried along"
  );
  assert.equal(requests[0].id, "req-1", "input rows are not mutated");
});

test("selectActiveRequests: empty input → empty array (no fabricated requests)", () => {
  assert.deepEqual(selectActiveRequests([]), []);
});

/* ------------------------------------------------------------------ */
/* isTopologyEntryInSet — alias-aware matching (entry side lowercased)  */
/* ------------------------------------------------------------------ */

test("isTopologyEntryInSet: matches by provider id, lowercasing the entry side", () => {
  const entry = { provider: "OpenAI" };
  assert.equal(isTopologyEntryInSet(entry, new Set(["openai"])), true);
  assert.equal(isTopologyEntryInSet(entry, new Set(["anthropic"])), false);
});

test("isTopologyEntryInSet: matches by any alias, even when the provider id misses", () => {
  const entry = { provider: "audio-synth", aliases: ["Arc-Whisper"] };
  assert.equal(isTopologyEntryInSet(entry, new Set(["arc-whisper"])), true);
  assert.equal(isTopologyEntryInSet(entry, new Set(["audio-synth"])), true);
  assert.equal(isTopologyEntryInSet(entry, new Set(["other"])), false);
});

test("isTopologyEntryInSet: no aliases → only the provider id can match", () => {
  assert.equal(isTopologyEntryInSet({ provider: "openai" }, new Set(["other"])), false);
  assert.equal(
    isTopologyEntryInSet({ provider: "openai", aliases: [] }, new Set(["openai"])),
    true
  );
});

/* ------------------------------------------------------------------ */
/* withProviderNodeEntries — custom (connectionless) provider nodes     */
/* ------------------------------------------------------------------ */

test("withProviderNodeEntries: null/undefined/empty nodes → a copy of the entries, unmutated", () => {
  const entries: TopologyEntry[] = [{ id: "row-1", provider: "openai" }];
  for (const nodes of [null, undefined, []]) {
    const result = withProviderNodeEntries(entries, nodes);
    assert.notEqual(result, entries, "returns a new array, never the input");
    assert.deepEqual(result, entries, "no node rows → same content");
  }
  assert.deepEqual(entries, [{ id: "row-1", provider: "openai" }], "input untouched");
});

test("withProviderNodeEntries: an embeddings node becomes an idle entry keyed by prefix", () => {
  const result = withProviderNodeEntries(
    [{ id: "row-1", provider: "openai" }],
    [{ id: "node-42", prefix: "arc-embed", name: "Arc Embeddings", apiType: "embeddings" }]
  );
  assert.equal(result.length, 2);
  const added = result[1];
  assert.equal(added.provider, "arc-embed", "the prefix is the live-event key");
  assert.equal(added.id, "arc-embed");
  assert.equal(added.name, "Arc Embeddings");
  assert.equal(added.status, "idle", "connectionless nodes start idle");
  assert.deepEqual(added.aliases, ["node-42"], "node id kept as alias (id-keyed events)");
  assert.equal(added.routeId, "node-42", "node id is the click-through route id");
});

test("withProviderNodeEntries: only embeddings/audio node types light up", () => {
  const nodes: TopologyNodeRow[] = [
    { id: "a1", prefix: "kokoro", name: "Kokoro", apiType: "audio-speech" },
    { id: "a2", prefix: "arc-asr", name: "Arc ASR", apiType: "audio-transcriptions" },
    { id: "c1", prefix: "chat-node", name: "Chat", apiType: "chat" },
    { id: "i1", prefix: "image-node", name: "Image", apiType: "image" },
    { id: "n1", prefix: "no-type", name: "NoType" },
    { id: "n2", prefix: "null-type", name: "NullType", apiType: null },
  ];
  const result = withProviderNodeEntries([], nodes);
  assert.deepEqual(
    result.map((e) => e.provider),
    ["kokoro", "arc-asr"],
    "chat / image / missing / null api types are excluded"
  );
});

test("withProviderNodeEntries: name falls back to the trimmed prefix when the node has no name", () => {
  const result = withProviderNodeEntries(
    [],
    [{ id: "n1", prefix: "  spaced  ", apiType: "embeddings" }]
  );
  assert.equal(result[0].name, "spaced", "trimmed prefix is the display-name fallback");
});

test("withProviderNodeEntries: node already covered by its prefix is skipped (no duplicate)", () => {
  const result = withProviderNodeEntries(
    [{ id: "row-1", provider: "ArcEmbed" }],
    [{ id: "node-1", prefix: "arcembed", name: "Arc", apiType: "embeddings" }]
  );
  assert.equal(result.length, 1, "prefix already taken → no duplicate entry");
});

test("withProviderNodeEntries: node without a usable prefix is skipped", () => {
  const result = withProviderNodeEntries(
    [],
    [
      { id: "n1", prefix: "   ", name: "Blank", apiType: "embeddings" },
      { id: "n2", name: "NoPrefix", apiType: "embeddings" },
    ]
  );
  assert.deepEqual(result, []);
});

test("withProviderNodeEntries: node covered by an alias → prefix merged as alias on a copy", () => {
  const original: TopologyEntry = {
    id: "row-9",
    provider: "audio-synth",
    aliases: ["arc-whisper"],
  };
  const result = withProviderNodeEntries(
    [original],
    [{ id: "arc-whisper", prefix: "arc-ws", name: "Arc Whisper", apiType: "audio-transcriptions" }]
  );
  assert.equal(result.length, 1, "no new entry — the existing one already covers this node");
  assert.notEqual(result[0], original, "the merged entry is a copy, not the input object");
  assert.deepEqual(result[0].aliases, ["arc-whisper", "arc-ws"], "prefix appended to aliases");
  assert.deepEqual(original.aliases, ["arc-whisper"], "input entry is not mutated");
});

test("withProviderNodeEntries: does not mutate its input entries", () => {
  const entries: TopologyEntry[] = [{ id: "row-1", provider: "openai", aliases: ["oai"] }];
  const before = JSON.stringify(entries);
  withProviderNodeEntries(entries, [
    { id: "node-1", prefix: "arc-embed", name: "A", apiType: "embeddings" },
  ]);
  assert.equal(JSON.stringify(entries), before, "inputs survive byte-for-byte");
});

/* ------------------------------------------------------------------ */
/* resolveTopologyNodeLabel — entry name > config name > provider id    */
/* ------------------------------------------------------------------ */

test("resolveTopologyNodeLabel: the pre-resolved entry name wins over the config fallback", () => {
  assert.equal(resolveTopologyNodeLabel("Custom Name", "OpenAI", "openai"), "Custom Name");
});

test("resolveTopologyNodeLabel: blank entry name falls back to the trimmed config name", () => {
  assert.equal(resolveTopologyNodeLabel("   ", "  Config Name  ", "openai"), "Config Name");
  assert.equal(resolveTopologyNodeLabel(null, "Config", "openai"), "Config");
});

test("resolveTopologyNodeLabel: no usable name → the provider id (never empty)", () => {
  assert.equal(resolveTopologyNodeLabel(undefined, null, "my-custom-uuid"), "my-custom-uuid");
  assert.equal(resolveTopologyNodeLabel("", "", "my-custom-uuid"), "my-custom-uuid");
});

/* ------------------------------------------------------------------ */
/* Complementary canonical-id pins (layoutIdentity)                     */
/* ------------------------------------------------------------------ */

test("canonical ids: gpu:<id> shape and parse round-trip (forward-compatible kind)", () => {
  assert.equal(HUB_NODE_ID, "hub");
  assert.equal(gpuNodeId("dev-1"), "gpu:dev-1");
  assert.deepEqual(parseAtomId(gpuNodeId("dev-1")), { kind: "gpu", value: "dev-1" });
  assert.equal(providerNodeId("openai"), "provider:openai");
  assert.equal(providerRouteLinkId("openai"), "route:openai");
});

test("parseAtomId: foreign ids return null (defensive — never throws)", () => {
  assert.equal(parseAtomId(""), null);
  assert.equal(parseAtomId("router"), null);
  assert.equal(parseAtomId("device:dev-1"), null, "non-canonical prefix is foreign");
  assert.deepEqual(parseAtomId("provider:a:b"), { kind: "provider", value: "a:b" });
});

/* ------------------------------------------------------------------ */
/* Complementary lane-derivation pins (lane.ts)                        */
/* ------------------------------------------------------------------ */

test("deriveLaneForProvider: no in-flight models → null (no observation at all)", () => {
  assert.equal(deriveLaneForProvider([]), null);
});

test("deriveLaneForProvider: all in-flight models unrecognizable → null (never fabricated)", () => {
  assert.equal(deriveLaneForProvider(["gpt-4o", "claude-sonnet-4"]), null);
});

test("deriveLaneForProvider: unrecognizable ids never drag a recognized lane to `unknown`", () => {
  // gpt-4o is unrecognizable, dall-e-3 is image → the single recognized
  // lane wins; mixing in unrecognized models is not a "mixed lane" state.
  const derived = deriveLaneForProvider(["gpt-4o", "dall-e-3"]);
  assert.equal(derived?.lane, "image");
  assert.ok(derived?.basis.includes("in-flight models all classify as image"));
});

test("deriveLaneForProvider: uniform recognized lane → that lane + model-listing basis", () => {
  const derived = deriveLaneForProvider(["text-embedding-3-small", "text-embedding-3-large"]);
  assert.equal(derived?.lane, "embedding");
  assert.ok(derived?.basis.includes("text-embedding-3-small"), "basis names the observed models");
});

test("deriveLaneForProvider: mixed recognized lanes → observed `unknown` (the one honest exception)", () => {
  const derived = deriveLaneForProvider(["dall-e-3", "whisper-1"]);
  assert.equal(derived?.lane, "unknown");
  assert.ok(derived?.basis.includes("mixed in-flight lanes"), "basis explains the mix");
  assert.ok(derived?.basis.includes("dall-e-3") && derived?.basis.includes("whisper-1"));
});

test("deriveLaneFromModel: ordinary chat / unknown model ids → null (anti-fabrication)", () => {
  assert.equal(deriveLaneFromModel("gpt-4o"), null);
  assert.equal(deriveLaneFromModel("claude-sonnet-4"), null);
  assert.equal(deriveLaneFromModel("my-vllm-server"), null);
});
