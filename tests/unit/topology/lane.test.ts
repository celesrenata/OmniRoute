// #T010 (OR-ATOM-001 v2 / M4) — lane classification invariants.
//
// Covers the pure classifier in `src/shared/topology/domain/lane.ts`:
//   - per-family keyword matching (embedding, rerank, vision, image, audio)
//   - the **anti-fabrication** contract: an unrecognizable model id is *not*
//     a lane observation (null), and a provider with no in-flight traffic
//     also has no lane observation.
//   - the *only* case `unknown` appears as an observed lane: mixed in-flight
//     lanes (the classifier refuses to silently pick one).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TOPOLOGY_LANES,
  deriveLaneFromModel,
  deriveLaneForProvider,
} from "../../../src/shared/topology/domain/lane";

test("TOPOLOGY_LANES: exact set (no chat/prefill/decode — anti-fabrication)", () => {
  // The domain emits only what it can actually derive from observed model ids.
  // `chat`, `prefill`, and `decode` are deliberately absent: "every model
  // that isn't clearly a specialist is a chat model" would be exactly the
  // anti-fabrication contract this module exists to enforce.
  assert.deepEqual(
    [...TOPOLOGY_LANES].sort(),
    ["audio", "embedding", "image", "rerank", "unknown", "vision"].sort()
  );
});

test("deriveLaneFromModel: embedding family (substring `embed`, case-insensitive)", () => {
  assert.equal(deriveLaneFromModel("text-embedding-3-small"), "embedding");
  assert.equal(deriveLaneFromModel("openai/v3-large"), null); // no "embed" token
  assert.equal(
    deriveLaneFromModel("cohere/aic-embed-v3"),
    "embedding",
    "substring match — the classifier is deliberately loose here"
  );
});

test("deriveLaneFromModel: rerank family (re-rank and rerank spellings)", () => {
  assert.equal(deriveLaneFromModel("bge-reranker-v2-m3"), "rerank");
  assert.equal(deriveLaneFromModel("cohere-rerank-3"), "rerank");
  assert.equal(deriveLaneFromModel("cross-encoder/ms-marco-MiniLM-L-8-v2"), null); // no rerank token — not a reranker by id alone
});

test("deriveLaneFromModel: vision family (anchored, not bare `vl`)", () => {
  assert.equal(deriveLaneFromModel("gpt-4o-vision-alpha"), "vision");
  assert.equal(
    deriveLaneFromModel("llava-v1.6-7b"),
    null,
    "llava has no bare `vl`/`vision` token — id alone is not enough (anti-fabrication)"
  );
  assert.equal(deriveLaneFromModel("meta-llama/Llama-3.2-11B-Vision"), "vision");
  assert.equal(deriveLaneFromModel("qwen-vl-max"), "vision");
  assert.equal(deriveLaneFromModel("my-vllm-server"), null); // bare `vl` inside "vllm" must NOT match
});

test("deriveLaneFromModel: image family (brand-anchored, not mid-id `image`)", () => {
  assert.equal(deriveLaneFromModel("dall-e-3"), "image");
  assert.equal(deriveLaneFromModel("flux-pro-1.1"), "image");
  assert.equal(deriveLaneFromModel("stabilityai/sdxl-1.0"), "image");
  assert.equal(deriveLaneFromModel("my-model-uses-image-segments"), null); // mid-id `image` is not a generator
  assert.equal(deriveLaneFromModel("my-image-reader"), null); // no brand token
});

test("deriveLaneFromModel: audio family (whisper / tts / speech-N / -asr / -sts)", () => {
  assert.equal(deriveLaneFromModel("whisper-1"), "audio");
  assert.equal(deriveLaneFromModel("whisper-large-v3"), "audio");
  assert.equal(deriveLaneFromModel("tts-1"), "audio");
  assert.equal(deriveLaneFromModel("openai/speech-001"), "audio");
  assert.equal(deriveLaneFromModel("model-x-asr"), "audio");
  assert.equal(deriveLaneFromModel("model-y-sts"), "audio");
  // Deliberately NOT classified: bare `audio` is too broad — a multimodal
  // chat id like `gpt-4o-audio` is not an audio-only generator.
  assert.equal(deriveLaneFromModel("gpt-4o-audio"), null);
  assert.equal(deriveLaneFromModel("my-audio-model"), null);
});

test("deriveLaneFromModel: no fabricated lane for ordinary chat model ids", () => {
  // The no-fabrication contract: these are all *chat* models by any other
  // metric, but the classifier must not label them as such.
  assert.equal(deriveLaneFromModel("gpt-4"), null);
  assert.equal(deriveLaneFromModel("gpt-4o"), null);
  assert.equal(deriveLaneFromModel("claude-3.5-sonnet"), null);
  assert.equal(deriveLaneFromModel("llama-3.1-70b-instruct"), null);
  assert.equal(deriveLaneFromModel("llama-3.1-70B"), null);
  assert.equal(deriveLaneFromModel("meta-llama/Llama-2-70b"), null);
  assert.equal(deriveLaneFromModel("mistral-large"), null);
  assert.equal(deriveLaneFromModel(""), null);
  assert.equal(deriveLaneFromModel(undefined), null);
  assert.equal(
    deriveLaneFromModel("my-mystery-model-9000"),
    null,
    "custom id with no family token ⇒ no lane observation"
  );
});

test("deriveLaneForProvider: no in-flight models → null (no fabrication)", () => {
  assert.equal(deriveLaneForProvider([]), null);
  assert.equal(deriveLaneForProvider([undefined, undefined]), null);
});

test("deriveLaneForProvider: all same lane → that lane + a stable basis string", () => {
  // Two in-flight embedding models → one embedding observation.
  const r = deriveLaneForProvider(["text-embedding-3-small", "openai/text-embedding-3-large"]);
  assert.equal(r?.lane, "embedding");
  assert.equal(typeof r?.basis, "string");
  assert.ok(r?.basis.includes("text-embedding-3-small"), "basis names the models");
});

test("deriveLaneForProvider: mixed lanes → observed `unknown` with per-model basis (the ONE honest exception)", () => {
  // Two different in-flight lanes is a real, nameable state. The *only*
  // place `unknown` appears as an observed value is here, with a basis that
  // lists each (model, lane) pair.
  const r = deriveLaneForProvider(["text-embedding-3-small", "whisper-1"]);
  assert.equal(r?.lane, "unknown");
  assert.ok(r?.basis.includes("text-embedding-3-small"));
  assert.ok(r?.basis.includes("whisper-1"));
  assert.ok(r?.basis.includes("embedding"));
  assert.ok(r?.basis.includes("audio"));
});

test("deriveLaneForProvider: all models unrecognizable → null (never fabricated)", () => {
  const r = deriveLaneForProvider(["gpt-4", "claude-3.5-sonnet", "llama-3.1"]);
  assert.equal(r, null);
});

test("TopologyLane: every member is a valid JobLane renderer value (compile-time subsumption)", () => {
  // At the type level: any `TopologyLane` is assignable to the renderer's
  // `JobLane` (see `asJobLane` in `visualEncoding.ts`). This test just pins the
  // *runtime* values the domain emits.
  const allowed = new Set<string>([
    "chat",
    "prefill",
    "decode",
    "embedding",
    "rerank",
    "vision",
    "image",
    "audio",
    "system",
    "unknown",
  ]);
  for (const lane of TOPOLOGY_LANES) {
    assert.equal(allowed.has(lane), true, `${String(lane)} must be a valid JobLane`);
  }
});
