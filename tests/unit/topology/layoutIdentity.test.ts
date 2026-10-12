/**
 * Stable canonical layout-identity tests (OR-ATOM-001 v2, T004 / M1).
 *
 * Pure TS / node:test — the identity helpers must survive reorder, snapshot
 * transitions and alias renames so any renderer can diff / persist / focus on
 * a stable key (AC7: stable IDs).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  HUB_NODE_ID,
  gpuNodeId,
  parseAtomId,
  providerNodeId,
  providerRouteLinkId,
} from "@/shared/topology/domain/layoutIdentity";

test('HUB_NODE_ID is the literal canonical id "hub"', () => {
  assert.equal(HUB_NODE_ID, "hub");
});

test("providerNodeId emits the canonical provider:<id> shape", () => {
  assert.equal(providerNodeId("openai"), "provider:openai");
  assert.equal(providerNodeId("openai-compatible-abc"), "provider:openai-compatible-abc");
});

test("gpuNodeId emits the forward-compatible gpu:<id> shape", () => {
  assert.equal(gpuNodeId("dev-1"), "gpu:dev-1");
});

test("providerRouteLinkId emits the canonical route:<id> shape", () => {
  assert.equal(providerRouteLinkId("openai"), "route:openai");
  assert.equal(providerRouteLinkId("anthropic"), "route:anthropic");
});

test("parseAtomId round-trips the hub id", () => {
  assert.deepEqual(parseAtomId(HUB_NODE_ID), { kind: "hub", value: HUB_NODE_ID });
});

test("parseAtomId round-trips provider ids", () => {
  const node = providerNodeId("anthropic");
  assert.deepEqual(parseAtomId(node), { kind: "provider", value: "anthropic" });
});

test("parseAtomId round-trips gpu ids", () => {
  const node = gpuNodeId("dev-2");
  assert.deepEqual(parseAtomId(node), { kind: "gpu", value: "dev-2" });
});

test("parseAtomId: canonical prefix with empty value resolves to empty string (never throws)", () => {
  // Defensive edge: a renderer must not crash on degenerate canonical ids;
  // the parsed value is just empty, and consumers skip empty values.
  assert.deepEqual(parseAtomId("provider:"), { kind: "provider", value: "" });
  assert.deepEqual(parseAtomId("gpu:"), { kind: "gpu", value: "" });
});

test("parseAtomId returns null for foreign / non-canonical ids (defensive)", () => {
  assert.equal(parseAtomId(""), null);
  assert.equal(parseAtomId("hubX"), null);
  assert.equal(parseAtomId("provider-legacy"), null);
  assert.equal(parseAtomId("route:openai"), null);
  assert.equal(parseAtomId("router"), null);
  assert.equal(parseAtomId("gpu-dev-1"), null);
});

test("parseAtomId is stable under re-ordering of the provider set (AC7)", () => {
  const a = providerNodeId("openai");
  const b = providerNodeId("anthropic");
  // Identity must not depend on the order the set is iterated in.
  const ids = [b, a, b].map((id) => parseAtomId(id));
  const openai = ids.find((p) => p !== null && p.value === "openai");
  const anthropic = ids.find((p) => p !== null && p.value === "anthropic");
  assert.equal(openai?.kind, "provider");
  assert.equal(anthropic?.kind, "provider");
});
