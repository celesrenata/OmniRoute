// tests/unit/video-bridge-memory-suppression.test.ts
// P1b of #12150 (Video Bridge transcript retention) — surface 3 (Memory sink).
//
// chatCore.ts's two Memory-extraction call sites (non-streaming + streaming)
// now each delegate to a single `runMemoryExtractionGate` (extracted so this
// wiring — not just the underlying `shouldExtractMemory` decision — is
// unit-testable against the REAL extractMemoryTextFromRequestBody/
// extractMemoryTextFromResponse, same god-file-decomposition convention as
// chatCore/attemptLogging.ts, chatCore/nonStreamingUsageStats.ts, etc.).
//
// #12150 fix round 1 (adversarial review, Important): a video-bridge-observed
// request must populate NO durable memory from EITHER source — the
// request-derived text (a flattened transcript description) AND the
// response-derived text (the model's own reply, which also received the full
// transcript and can echo it back). Both are gated by the same
// shouldExtractMemory() decision inside runMemoryExtractionGate.
import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldExtractMemory,
  runMemoryExtractionGate,
} from "../../open-sse/handlers/chatCore/memoryExtraction.ts";

// ─── shouldExtractMemory: pure decision table ──────────────────────────────

test("shouldExtractMemory: videoBridgeObserved=true skips extraction even when memory is otherwise enabled", () => {
  assert.equal(
    shouldExtractMemory({
      enabled: true,
      maxTokens: 2000,
      memoryOwnerId: "key-1",
      videoBridgeObserved: true,
    }),
    false
  );
});

test("shouldExtractMemory: videoBridgeObserved=false extracts when memory is enabled (unaffected non-video path)", () => {
  assert.equal(
    shouldExtractMemory({
      enabled: true,
      maxTokens: 2000,
      memoryOwnerId: "key-1",
      videoBridgeObserved: false,
    }),
    true
  );
});

test("shouldExtractMemory: videoBridgeObserved omitted (undefined) behaves like false — additive param default", () => {
  assert.equal(
    shouldExtractMemory({
      enabled: true,
      maxTokens: 2000,
      memoryOwnerId: "key-1",
    }),
    true
  );
});

test("shouldExtractMemory: still false when memory disabled, regardless of videoBridgeObserved", () => {
  assert.equal(
    shouldExtractMemory({
      enabled: false,
      maxTokens: 2000,
      memoryOwnerId: "key-1",
      videoBridgeObserved: false,
    }),
    false
  );
});

test("shouldExtractMemory: still false when maxTokens <= 0, regardless of videoBridgeObserved", () => {
  assert.equal(
    shouldExtractMemory({
      enabled: true,
      maxTokens: 0,
      memoryOwnerId: "key-1",
      videoBridgeObserved: false,
    }),
    false
  );
});

test("shouldExtractMemory: still false when memoryOwnerId is null, regardless of videoBridgeObserved", () => {
  assert.equal(
    shouldExtractMemory({
      enabled: true,
      maxTokens: 2000,
      memoryOwnerId: null,
      videoBridgeObserved: false,
    }),
    false
  );
});

// ─── runMemoryExtractionGate: the REAL chatCore.ts call-site wiring ────────
// No hand-mirrored stub — this imports and calls the exact function both
// chatCore.ts completion paths call. Only `extractFacts` (the DB-writing,
// fire-and-forget side effect) is injected as a spy; extraction of the
// request/response text runs through the real
// extractMemoryTextFromRequestBody/extractMemoryTextFromResponse.

const flattenedVideoRequestBody = {
  messages: [
    {
      role: "user",
      content: "[Video 1]: A person talks. transcript[00:00-00:02]: secret words",
    },
  ],
};

const modelReplyEchoingTranscript = {
  choices: [
    {
      message: {
        content: "Sure — the video shows: secret words",
      },
    },
  ],
};

function spy() {
  const calls: Array<[string, string, string, string?]> = [];
  return {
    calls,
    fn: (
      text: string,
      ownerId: string,
      sessionId: string,
      source?: "user-message" | "assistant-response"
    ) => {
      calls.push([text, ownerId, sessionId, source]);
    },
  };
}

test("runMemoryExtractionGate: zero extractFacts calls (request AND response) for a video-bridge-observed request", () => {
  const extractFacts = spy();
  runMemoryExtractionGate({
    memoryOwnerId: "key-1",
    memorySettings: { enabled: true, maxTokens: 2000 },
    videoBridgeObserved: true,
    pipelineSessionId: "session-1",
    requestBody: flattenedVideoRequestBody,
    responseBody: modelReplyEchoingTranscript,
    extractFacts: extractFacts.fn,
  });
  assert.equal(
    extractFacts.calls.length,
    0,
    "extractFacts must not be called for either source when videoBridgeObserved=true"
  );
});

test("runMemoryExtractionGate: response-derived extraction specifically is skipped when observed (fix round 1 regression)", () => {
  const extractFacts = spy();
  runMemoryExtractionGate({
    memoryOwnerId: "key-1",
    memorySettings: { enabled: true, maxTokens: 2000 },
    videoBridgeObserved: true,
    pipelineSessionId: "session-1",
    // No request-derived text at all (e.g. request body already consumed/
    // reshaped) — isolates the assertion to the response-derived source,
    // which is the one fix round 1 found still leaking into Memory.
    requestBody: { messages: [] },
    responseBody: modelReplyEchoingTranscript,
    extractFacts: extractFacts.fn,
  });
  assert.equal(
    extractFacts.calls.length,
    0,
    "the model's reply (which also received the full transcript) must not be extracted when observed"
  );
});

test("runMemoryExtractionGate: default — only request text is extracted (M4 gate, MEMORY_EXTRACT_ASSISTANT_RESPONSES off)", () => {
  const extractFacts = spy();
  // Ensure the M4 gate flag is off (the default)
  delete process.env.MEMORY_EXTRACT_ASSISTANT_RESPONSES;
  runMemoryExtractionGate({
    memoryOwnerId: "key-1",
    memorySettings: { enabled: true, maxTokens: 2000 },
    videoBridgeObserved: false,
    pipelineSessionId: "session-1",
    requestBody: flattenedVideoRequestBody,
    responseBody: { choices: [{ message: { content: "a normal reply" } }] },
    extractFacts: extractFacts.fn,
  });
  // M4: the assistant's own reply is not a user assertion, so the response path
  // is skipped by default — only the request (user-message) extraction runs.
  assert.equal(
    extractFacts.calls.length,
    1,
    "only request-derived extraction runs by default (M4 gate)"
  );
  assert.match(extractFacts.calls[0][0], /secret words/);
  assert.equal(extractFacts.calls[0][1], "key-1");
  assert.equal(extractFacts.calls[0][2], "session-1");
  // WP2: the source arg is "user-message"
  assert.equal(extractFacts.calls[0][3], "user-message");
});

test("runMemoryExtractionGate: flag ON — BOTH request and response text are extracted", () => {
  const extractFacts = spy();
  process.env.MEMORY_EXTRACT_ASSISTANT_RESPONSES = "true";
  try {
    runMemoryExtractionGate({
      memoryOwnerId: "key-1",
      memorySettings: { enabled: true, maxTokens: 2000 },
      videoBridgeObserved: false,
      pipelineSessionId: "session-1",
      requestBody: flattenedVideoRequestBody,
      responseBody: { choices: [{ message: { content: "a normal reply" } }] },
      extractFacts: extractFacts.fn,
    });
    assert.equal(
      extractFacts.calls.length,
      2,
      "both request- and response-derived extraction run when MEMORY_EXTRACT_ASSISTANT_RESPONSES is on"
    );
    assert.match(extractFacts.calls[0][0], /secret words/);
    assert.match(extractFacts.calls[1][0], /a normal reply/);
    assert.equal(extractFacts.calls[0][1], "key-1");
    assert.equal(extractFacts.calls[0][2], "session-1");
    // WP2: response path carries "assistant-response" source
    assert.equal(extractFacts.calls[1][3], "assistant-response");
  } finally {
    delete process.env.MEMORY_EXTRACT_ASSISTANT_RESPONSES;
  }
});

test("runMemoryExtractionGate: no-ops when memory is disabled, regardless of videoBridgeObserved", () => {
  const extractFacts = spy();
  runMemoryExtractionGate({
    memoryOwnerId: "key-1",
    memorySettings: { enabled: false, maxTokens: 2000 },
    videoBridgeObserved: false,
    pipelineSessionId: "session-1",
    requestBody: flattenedVideoRequestBody,
    responseBody: { choices: [{ message: { content: "a normal reply" } }] },
    extractFacts: extractFacts.fn,
  });
  assert.equal(extractFacts.calls.length, 0);
});

test("runMemoryExtractionGate: no-ops when memoryOwnerId is missing, regardless of videoBridgeObserved", () => {
  const extractFacts = spy();
  runMemoryExtractionGate({
    memoryOwnerId: null,
    memorySettings: { enabled: true, maxTokens: 2000 },
    videoBridgeObserved: false,
    pipelineSessionId: "session-1",
    requestBody: flattenedVideoRequestBody,
    responseBody: { choices: [{ message: { content: "a normal reply" } }] },
    extractFacts: extractFacts.fn,
  });
  assert.equal(extractFacts.calls.length, 0);
});
