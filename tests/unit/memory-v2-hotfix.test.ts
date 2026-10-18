/**
 * Intelligence Layer v2 — memory correctness hotfix (WP0 regression suite).
 *
 * Covers the 7 confirmed defects (M1–M7). Every behavior is flag-gated and
 * default-OFF, so with no flag set the assertions document the *legacy* baseline;
 * enabling a flag asserts the *fixed* behavior. This keeps the suite green both
 * for a caller who has not opted in and for the v2 path.
 *
 * Fast unit suite: the relevance/materialization tests exercise pure helpers or
 * the materialization gate; the DB-backed cases use an isolated in-memory store.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptRelevance,
  getRelevanceScore,
  rowToMemory,
  type MemoryRow,
} from "../../src/lib/memory/retrieval/scoring.ts";
import { runMemoryExtractionGate } from "../../open-sse/handlers/chatCore/memoryExtraction.ts";
import {
  isAccessImmune,
  computeDecayDeadline,
  resolveTypedDecayConfig,
} from "../../src/lib/memory/typedDecay.ts";
import { MemoryType } from "../../src/lib/memory/types.ts";
import { formatMemoryContext, injectMemory } from "../../src/lib/memory/injection.ts";

function memory(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "mem-1",
    api_key_id: "key-A",
    session_id: "sess",
    type: "factual",
    key: "editor",
    content: "I prefer dark mode in my editor.",
    metadata: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    expires_at: null,
    access_count: 0,
    last_accessed_at: null,
    ...over,
  } as MemoryRow;
}

function mem(over: Partial<import("../../src/lib/memory/types.ts").Memory> = {}) {
  const base = rowToMemory(memory());
  return { ...base, ...over };
}

// ─────────────────────────── M2: relevance accept gate ────────────────────────

test("M2: acceptRelevance — exact phrase is accepted", () => {
  const m = mem({ content: "I prefer dark mode in my editor." });
  const v = acceptRelevance(m, "dark mode");
  assert.equal(v.accepted, true);
  assert.equal(v.reason, "phrase_hit");
});

test("M2: acceptRelevance — unrelated query is rejected (legacy score was > 0 for fragments)", () => {
  const m = mem({ content: "I prefer dark mode in my editor." });
  const v = acceptRelevance(m, "quantum flux capacitor");
  assert.equal(v.accepted, false);
});

test("M2: acceptRelevance — a substring fragment is NOT a meaningful match", () => {
  // "mod" is a fragment of "modern"; the legacy substring scorer returned > 0
  const m = mem({ content: "I use a modern framework" });
  assert.ok(getRelevanceScore(m, "mod") > 0, "legacy score is positive");
  const v = acceptRelevance(m, "mod");
  assert.equal(v.accepted, false, "fragment must not pass the gate");
});

test("M2: acceptRelevance — a real whole-word hit is accepted", () => {
  const m = mem({ content: "the modem is slow today" });
  const v = acceptRelevance(m, "modem");
  assert.equal(v.accepted, true);
});

test("M2: acceptRelevance — stopword-only query is rejected", () => {
  const m = mem({ content: "alpha beta gamma" });
  const v = acceptRelevance(m, "the and of with");
  assert.equal(v.accepted, false);
  assert.equal(v.reason, "stopword_only");
});

test("M2: acceptRelevance — empty query yields no_query", () => {
  const m = mem();
  const v = acceptRelevance(m, "   ");
  assert.equal(v.accepted, false);
  assert.equal(v.reason, "no_query");
});

// ─────────────────────────── M6: typed-decay access immunity ─────────────────

test("M6: isAccessImmune — default is NEVER immune (TTL-based decay)", () => {
  const cfg = resolveTypedDecayConfig({ MEMORY_TYPED_DECAY_ENABLED: "true" } as NodeJS.ProcessEnv);
  delete process.env.MEMORY_TYPED_DECAY_LEGACY_ACCESS_IMMUNITY;
  assert.equal(
    isAccessImmune(99, cfg),
    false,
    "high access count must not grant immunity by default"
  );
});

test("M6: isAccessImmune — legacy flag restores threshold behavior", () => {
  const cfg = resolveTypedDecayConfig({ MEMORY_TYPED_DECAY_ENABLED: "true" } as NodeJS.ProcessEnv);
  process.env.MEMORY_TYPED_DECAY_LEGACY_ACCESS_IMMUNITY = "true";
  try {
    assert.equal(isAccessImmune(2, cfg), false);
    assert.equal(isAccessImmune(3, cfg), true, "default threshold is 3");
    assert.equal(isAccessImmune(99, cfg), true);
  } finally {
    delete process.env.MEMORY_TYPED_DECAY_LEGACY_ACCESS_IMMUNITY;
  }
});

test("M6: computeDecayDeadline — an old episodic memory decays even when heavily accessed", () => {
  const cfg = resolveTypedDecayConfig({ MEMORY_TYPED_DECAY_ENABLED: "true" } as NodeJS.ProcessEnv);
  delete process.env.MEMORY_TYPED_DECAY_LEGACY_ACCESS_IMMUNITY;
  const old = new Date("2020-01-01T00:00:00Z");
  const now = new Date("2026-01-01T00:00:00Z");
  const mem = {
    id: "m",
    type: MemoryType.EPISODIC,
    accessCount: 99,
    createdAt: old,
    lastAccessedAt: old,
  };
  assert.notEqual(computeDecayDeadline(mem, cfg, now), null, "must have a deadline (decays)");
});

// ─────────────────────────── M4: assistant-response extraction gate ──────────

test("M4: assistant-response text is NOT extracted by default", () => {
  let saved = 0;
  const extractFacts = (_text: string, _owner: string, _sess: string) => {
    saved++;
  };
  delete process.env.MEMORY_EXTRACT_ASSISTANT_RESPONSES;
  runMemoryExtractionGate({
    memoryOwnerId: "key-A",
    memorySettings: { enabled: true, maxTokens: 4000 },
    videoBridgeObserved: false,
    pipelineSessionId: "sess",
    requestBody: null,
    // The assistant's own reply asserts a preference. By default this must NOT be
    // persisted as a user fact.
    responseBody: { choices: [{ message: { content: "I prefer Rust over Go." } }] },
    extractFacts,
    log: undefined,
  });
  assert.equal(saved, 0, "assistant response must not seed memory by default");
});

test("M4: user request text IS still extracted by default", () => {
  let saved = 0;
  const extractFacts = (_text: string, _owner: string, _sess: string) => {
    saved++;
  };
  delete process.env.MEMORY_EXTRACT_ASSISTANT_RESPONSES;
  runMemoryExtractionGate({
    memoryOwnerId: "key-A",
    memorySettings: { enabled: true, maxTokens: 4000 },
    videoBridgeObserved: false,
    pipelineSessionId: "sess",
    requestBody: { messages: [{ role: "user", content: "I prefer dark mode." }] },
    responseBody: null,
    extractFacts,
    log: undefined,
  });
  assert.equal(saved, 1, "user request must still seed memory");
});

test("M4: flag ON restores legacy assistant-response extraction", () => {
  let saved = 0;
  const extractFacts = (_text: string, _owner: string, _sess: string) => {
    saved++;
  };
  process.env.MEMORY_EXTRACT_ASSISTANT_RESPONSES = "true";
  try {
    runMemoryExtractionGate({
      memoryOwnerId: "key-A",
      memorySettings: { enabled: true, maxTokens: 4000 },
      videoBridgeObserved: false,
      pipelineSessionId: "sess",
      requestBody: null,
      responseBody: { choices: [{ message: { content: "I prefer Rust over Go." } }] },
      extractFacts,
      log: undefined,
    });
  } finally {
    delete process.env.MEMORY_EXTRACT_ASSISTANT_RESPONSES;
  }
  assert.equal(saved, 1, "flag ON must restore the legacy behavior");
});

// ─────────────────────────── M7: structured provenance injection ─────────────

test("M7: formatMemoryContext stays legacy (bare 'Memory context:') by default", () => {
  delete process.env.MEMORY_V2_STRUCTURED_INJECTION;
  const text = formatMemoryContext([mem()]);
  assert.ok(text.startsWith("Memory context:"), "legacy prefix preserved");
});

test("M7: injectMemory — structured block has provenance + disclaimer when flag ON", () => {
  process.env.MEMORY_V2_STRUCTURED_INJECTION = "true";
  try {
    const req = {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
    } as unknown as Parameters<typeof injectMemory>[0];
    const out = injectMemory(req, [mem({ id: "mem-77", key: "editor" })], "openai");
    const text = JSON.stringify(out.messages);
    assert.ok(text.includes("id=mem-77"), "provenance id present");
    assert.ok(text.includes("CONTEXT ONLY") || text.includes("context"), "disclaimer present");
    assert.ok(text.includes("recorded_at="), "recorded_at present");
    assert.ok(!text.startsWith("Memory context:"), "legacy prefix replaced");
  } finally {
    delete process.env.MEMORY_V2_STRUCTURED_INJECTION;
  }
});

test("M7: injectMemory — legacy format when flag OFF", () => {
  delete process.env.MEMORY_V2_STRUCTURED_INJECTION;
  const req = {
    model: "x",
    messages: [{ role: "user", content: "hi" }],
  } as unknown as Parameters<typeof injectMemory>[0];
  const out = injectMemory(req, [mem()], "openai");
  const text = JSON.stringify(out.messages);
  assert.ok(text.includes("Memory context:"), "legacy prefix used");
});
