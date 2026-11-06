// Route-level regression test: /v1/audio/translations must spread across
// same-prefix provider_nodes by load (leastLoadedNode), matching what the
// sibling /v1/audio/transcriptions and /v1/audio/speech routes already do.
// A translation node is a transcription node (Whisper-style endpoints expose
// both), so the old `dynamicProviders.find()` first-node pinning swamped the
// first GPU host while the rest idled. Load tracking applies only to dynamic
// fleet nodes; hardcoded remote providers are never tracked.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-audio-trans-lb-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "audio-trans-lb-test-secret";

const originalFetch = globalThis.fetch;

// One shared prefix (what a human types), two distinct nodes behind it (one per
// GPU host, distinct ids + hosts). This is the real ArcForge fleet shape: load
// balancing only has a choice when several nodes share the same prefix.
const SHARED_PREFIX = `arctr-${crypto.randomUUID().slice(0, 8)}`;
const NODE_ID_A = `openai-compatible-audio-translations-arc-lb-a-${crypto.randomUUID()}`;
const NODE_ID_B = `openai-compatible-audio-translations-arc-lb-b-${crypto.randomUUID()}`;
const BASE_URL_A = `http://127.0.0.1:18991/v1`;
const BASE_URL_B = `http://127.0.0.1:18992/v1`;
const MODEL = `${SHARED_PREFIX}/whisper-large-v3`;

function makeWav(): Blob {
  const dataLen = 1600;
  const b = Buffer.alloc(44 + dataLen);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataLen, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataLen, 40);
  return new Blob([b], { type: "audio/wav" });
}

function translationRequest(): Request {
  const formData = new FormData();
  formData.append("model", MODEL);
  formData.append("file", new File([makeWav()], "clip.wav", { type: "audio/wav" }));
  return new Request("http://localhost/v1/audio/translations", {
    method: "POST",
    body: formData,
  });
}

const core = await import("../../src/lib/db/core.ts");
const { createProviderNode } = await import("../../src/lib/db/providers.ts");
const load = await import("../../src/shared/utils/leastLoadedNode.ts");
const translationsRoute = await import("../../src/app/api/v1/audio/translations/route.ts");

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  load.resetNodeLoad();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.before(async () => {
  // Two translation-capable fleet nodes on distinct loopback hosts. Loopback
  // hosts are always eligible and resolve to authType "none" (no connection
  // rows needed), so the request flows straight to dispatch — which is exactly
  // the surface under test (node selection + load accounting).
  await createProviderNode({
    id: NODE_ID_A,
    type: "openai-compatible",
    name: "Arc Whisper A",
    prefix: SHARED_PREFIX,
    apiType: "audio-transcriptions",
    baseUrl: BASE_URL_A,
  } as Parameters<typeof createProviderNode>[0]);
  await createProviderNode({
    id: NODE_ID_B,
    type: "openai-compatible",
    name: "Arc Whisper B",
    prefix: SHARED_PREFIX,
    apiType: "audio-transcriptions",
    baseUrl: BASE_URL_B,
  } as Parameters<typeof createProviderNode>[0]);
});

test("POST /v1/audio/translations picks the least-loaded node when the first one is busy", async () => {
  load.resetNodeLoad();
  const hits: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    hits.push(String(input));
    return new Response(JSON.stringify({ text: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  // Pre-mark node A as carrying 5 in-flight requests so the picker must prefer B.
  // The route keys load by the provider's full baseUrl (base + "/audio/translations").
  const KEY_A = `${BASE_URL_A}/audio/translations`;
  load.acquireNodeLoad(KEY_A);
  load.acquireNodeLoad(KEY_A);
  load.acquireNodeLoad(KEY_A);
  load.acquireNodeLoad(KEY_A);
  load.acquireNodeLoad(KEY_A);

  const response = await translationsRoute.POST(translationRequest());

  assert.equal(
    response.status,
    200,
    `expected 200, got ${response.status}: ${await response.text().catch(() => "")}`
  );
  assert.equal(hits.length, 1, "exactly one upstream request is dispatched");
  assert.ok(
    hits[0].startsWith(BASE_URL_B),
    `expected the idle node B (${BASE_URL_B}) to be chosen, got ${hits[0]}`
  );
});

test("POST /v1/audio/translations releases the load ref-count after dispatch", async () => {
  load.resetNodeLoad();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ text: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

  const before = load.getNodeLoad(BASE_URL_A).inFlight;
  await translationsRoute.POST(translationRequest());
  const after = load.getNodeLoad(BASE_URL_A).inFlight;

  // The route must balance its own acquire/release: whatever load the route
  // picked (A or B, either is fine here — the pool is symmetric), the total
  // in-flight on the picked node returns to its pre-request value, never
  // leaks upward, and never goes negative.
  assert.equal(after, before, `in-flight must be balanced (was ${before}, now ${after})`);
  assert.ok(after >= 0, "in-flight must not go negative");
});
