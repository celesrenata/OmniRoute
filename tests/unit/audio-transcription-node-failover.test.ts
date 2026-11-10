import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audioNodeCandidates,
  audioNodeRoot,
  resolveAudioResponseStartTimeoutMs,
  probeAudioNodeHealth,
  fetchWithResponseStartTimeout,
  ResponseStartTimeoutError,
} from "@omniroute/open-sse/utils/audioNodeFailover.ts";
import { buildDynamicAudioProvider } from "@omniroute/open-sse/config/audioRegistry.ts";
import { handleAudioTranscription } from "@omniroute/open-sse/handlers/audioTranscription.ts";

/**
 * Regression: the ArcForge STT fleet is one provider prefix (`arcforge-stt`)
 * backed by N provider_node rows (one per GPU host). The deployed build pinned
 * the prefix to the first node (10.1.1.12) with a plain `.find()` and no
 * response-start ceiling — when that node's GPU context wedged (process alive,
 * 34% CPU spin, zero bytes on the wire, even /healthz unresponsive), every
 * dictation request burned the route's full 300s budget and the user saw
 * "the provider is down" while the sibling (10.1.1.13) answered in <1s.
 *
 * The fix: the default (openai-compatible multipart) transcription path
 * resolves the sibling dynamic nodes for the same prefix, health-probes
 * candidates (`GET /healthz`, any HTTP answer = alive, only a timeout is
 * dead), and gives every NON-LAST candidate a bounded response-start ceiling
 * derived from the estimated audio duration. The last candidate keeps the
 * full route budget so a legitimate long transcription is never cut short.
 */

const AUDIO_PATH = "/v1/audio/transcriptions";

// buildDynamicAudioProvider consults the allowlist env per call, so set it
// before constructing the providers: these hosts must be credential-less
// (the deployed nodes are auth-free) for the handler to skip its 401 gate.
const PREV_LOCAL_AUDIO_HOSTS = process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS;
process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS = "10.1.1.12,10.1.1.13";
process.on("exit", () => {
  if (PREV_LOCAL_AUDIO_HOSTS === undefined) delete process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS;
  else process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS = PREV_LOCAL_AUDIO_HOSTS;
});

function node(baseUrl: string, prefix: string, id?: string) {
  return buildDynamicAudioProvider(
    { baseUrl, prefix, id: id ?? "n", apiType: "audio-transcriptions" } as never,
    AUDIO_PATH
  );
}

const primary = node("http://10.1.1.12:10300", "arcforge-stt", "arc-stt-12");
const sibling = node("http://10.1.1.13:10300", "arcforge-stt", "arc-stt-13");

function formDataFor(durationMs: number): FormData {
  // 16 kHz s16 mono ≈ 32 bytes/sample → 32000 bytes/s
  const size = Math.round((durationMs / 1000) * 32000);
  const fd = new FormData();
  fd.set("model", "arcforge-stt/whisper-large-v3");
  fd.set("file", new Blob([new Uint8Array(size)], { type: "audio/wav" }));
  return fd;
}

test("audioNodeCandidates: returns [primary, siblings...] for a dynamic prefix", () => {
  const candidates = audioNodeCandidates(primary, [primary, sibling], AUDIO_PATH);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].baseUrl, primary.baseUrl);
  assert.equal(candidates[1].baseUrl, sibling.baseUrl);
});

test("audioNodeCandidates: deterministic order (registration order, primary first)", () => {
  const c1 = audioNodeCandidates(primary, [primary, sibling], AUDIO_PATH);
  const c2 = audioNodeCandidates(primary, [sibling, primary], AUDIO_PATH);
  assert.equal(c1[0].baseUrl, c2[0].baseUrl); // primary always first
  assert.equal(c1[1].baseUrl, c2[1].baseUrl); // sibling order is stable
});

test("audioNodeCandidates: dedupes prefix/row-id double registrations of the same node", () => {
  // resolveDynamicAudioProviders registers each physical node twice (by
  // prefix and by row id — the same baseUrl under two addressable ids).
  const byId = { ...sibling, id: "arc-stt-13" };
  const candidates = audioNodeCandidates(primary, [primary, sibling, byId], AUDIO_PATH);
  assert.equal(candidates.length, 2);
});

test("audioNodeCandidates: empty for a hardcoded (non-dynamic) provider", () => {
  // Hardcoded registry entries do NOT carry the audio path in baseUrl — the
  // executor appends it at dispatch time — so they get no node failover.
  const hardcoded = {
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    authType: "apikey" as const,
    models: [],
  };
  assert.deepEqual(audioNodeCandidates(hardcoded, [primary, sibling], AUDIO_PATH), []);
});

test("audioNodeCandidates: no siblings → [primary] only", () => {
  const candidates = audioNodeCandidates(primary, [primary], AUDIO_PATH);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].baseUrl, primary.baseUrl);
});

test("audioNodeCandidates: only nodes carrying the transcription path are candidates", () => {
  // A TTS node serves a different apiType — its baseUrl carries the TTS path,
  // so it must never become a transcription failover candidate even if it
  // happened to be in the same dynamicProviders list.
  const tts = {
    id: "arc-tts-13",
    baseUrl: "http://10.1.1.13:10301/v1/audio/speech",
  };
  const candidates = audioNodeCandidates(primary, [primary, sibling, tts], AUDIO_PATH);
  assert.equal(candidates.length, 2);
  assert.ok(!candidates.some((c) => c.baseUrl === tts.baseUrl));
});

test("audioNodeRoot: strips the audio path suffix; null when it does not match", () => {
  assert.equal(audioNodeRoot(primary, AUDIO_PATH), "http://10.1.1.12:10300");
  assert.equal(audioNodeRoot({ ...primary, baseUrl: "http://x" }, AUDIO_PATH), null);
});

test("resolveAudioResponseStartTimeoutMs: floor for short files, scales with duration, capped", () => {
  const floor = resolveAudioResponseStartTimeoutMs(0);
  const short = resolveAudioResponseStartTimeoutMs(3400);
  assert.equal(floor, short); // 3.4s file still gets the floor
  assert.ok(floor >= 10_000);
  const mid = resolveAudioResponseStartTimeoutMs(60_000);
  assert.ok(mid > short, "longer audio gets a longer ceiling");
  const huge = resolveAudioResponseStartTimeoutMs(10 * 60 * 1000);
  assert.ok(huge <= 300_000, "never exceeds the 300s route budget");
});

test("probeAudioNodeHealth: any HTTP response (incl. 404) means alive", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input: unknown) =>
      new Response("{}", { status: 404 })) as typeof fetch;
    assert.deepEqual(await probeAudioNodeHealth("http://10.1.1.12:10300"), {
      alive: true,
      status: 404,
    });
    globalThis.fetch = (async (_input: unknown) =>
      new Response("ok", { status: 200 })) as typeof fetch;
    assert.deepEqual(await probeAudioNodeHealth("http://10.1.1.13:10300"), {
      alive: true,
      status: 200,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("probeAudioNodeHealth: timeout = dead (the wedged-node signature)", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input: unknown, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      })) as unknown as typeof fetch;
    const result = await probeAudioNodeHealth("http://10.1.1.12:10300", 50);
    assert.equal(result.alive, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("probeAudioNodeHealth: connection refusal = dead", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const result = await probeAudioNodeHealth("http://10.1.1.12:10300", 50);
    assert.equal(result.alive, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchWithResponseStartTimeout: resolves fast responses untouched", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const res = await fetchWithResponseStartTimeout("http://x/y", {}, 5000);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchWithResponseStartTimeout: aborts a hanging request with ResponseStartTimeoutError", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input: unknown, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      })) as unknown as typeof fetch;
    await assert.rejects(
      async () => fetchWithResponseStartTimeout("http://x/y", {}, 50),
      (err: unknown) => {
        assert.ok(err instanceof ResponseStartTimeoutError);
        return true;
      }
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * End-to-end: the incident scenario. Primary node (first-registered, .12) is
 * wedged — its /healthz times out and its POST hangs with zero bytes. The
 * handler must fail over to the sibling (.13), which answers in <1s, and the
 * client gets a 200 with the transcript — in seconds, not 300.
 */
test("handleAudioTranscription: fails over to a healthy sibling when the primary is wedged", async () => {
  const realFetch = globalThis.fetch;
  const prevMin = process.env.OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MIN_MS;
  const prevProbe = process.env.OMNIROUTE_AUDIO_NODE_HEALTH_PROBE_TIMEOUT_MS;
  const seen: string[] = [];
  try {
    // Make the test fast: min response-start ceiling 100ms, health probe 50ms.
    process.env.OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MIN_MS = "100";
    process.env.OMNIROUTE_AUDIO_NODE_HEALTH_PROBE_TIMEOUT_MS = "50";

    globalThis.fetch = (async (input: unknown, init: { signal?: AbortSignal } = {}) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/healthz")) {
        if (url.includes("10.1.1.12")) {
          // wedged node: never answers
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          });
        }
        return new Response("ok", { status: 200 });
      }
      // transcription POST
      if (url.includes("10.1.1.12")) {
        // wedged node: accepts the connection, transmits nothing
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
      }
      return new Response(
        JSON.stringify({
          text: "The quarterly revenue exceeded our projections by 12%.",
          language: "en",
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const res = await handleAudioTranscription({
      formData: formDataFor(3400),
      credentials: null,
      resolvedProvider: primary,
      resolvedModel: "whisper-large-v3",
      dynamicProviders: [primary, sibling],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(String(body.text).includes("quarterly revenue"));
    // The healthy sibling was used; the wedged primary was never POSTed.
    assert.ok(seen.some((u) => u.includes("10.1.1.13:10300/v1/audio/transcriptions")));
    assert.ok(!seen.some((u) => u.includes("10.1.1.12:10300/v1/audio/transcriptions")));
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [
      ["OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MIN_MS", prevMin],
      ["OMNIROUTE_AUDIO_NODE_HEALTH_PROBE_TIMEOUT_MS", prevProbe],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("handleAudioTranscription: fails over when the primary passes the probe but the POST stalls", async () => {
  const realFetch = globalThis.fetch;
  const prevMin = process.env.OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MIN_MS;
  const prevMax = process.env.OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MAX_MS;
  const prevProbe = process.env.OMNIROUTE_AUDIO_NODE_HEALTH_PROBE_TIMEOUT_MS;
  const seen: string[] = [];
  try {
    process.env.OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MIN_MS = "100";
    process.env.OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MAX_MS = "200";
    process.env.OMNIROUTE_AUDIO_NODE_HEALTH_PROBE_TIMEOUT_MS = "50";

    globalThis.fetch = (async (input: unknown, init: { signal?: AbortSignal } = {}) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/healthz")) return new Response("ok", { status: 200 });
      if (url.includes("10.1.1.12")) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
      }
      return new Response(JSON.stringify({ text: "failover text", language: "en" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const res = await handleAudioTranscription({
      formData: formDataFor(3400),
      credentials: null,
      resolvedProvider: primary,
      resolvedModel: "whisper-large-v3",
      dynamicProviders: [primary, sibling],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.text, "failover text");
    assert.ok(seen.some((u) => u.includes("10.1.1.12:10300/v1/audio/transcriptions")));
    assert.ok(seen.some((u) => u.includes("10.1.1.13:10300/v1/audio/transcriptions")));
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [
      ["OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MIN_MS", prevMin],
      ["OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MAX_MS", prevMax],
      ["OMNIROUTE_AUDIO_NODE_HEALTH_PROBE_TIMEOUT_MS", prevProbe],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("handleAudioTranscription: all candidates wedged → 502, sanitized body", async () => {
  const realFetch = globalThis.fetch;
  const prevMin = process.env.OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MIN_MS;
  const prevProbe = process.env.OMNIROUTE_AUDIO_NODE_HEALTH_PROBE_TIMEOUT_MS;
  try {
    process.env.OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MIN_MS = "100";
    process.env.OMNIROUTE_AUDIO_NODE_HEALTH_PROBE_TIMEOUT_MS = "50";

    globalThis.fetch = (async (_input: unknown, init: { signal?: AbortSignal } = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      })) as unknown as typeof fetch;

    const res = await handleAudioTranscription({
      formData: formDataFor(3400),
      credentials: null,
      resolvedProvider: primary,
      resolvedModel: "whisper-large-v3",
      dynamicProviders: [primary, sibling],
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error?: { message?: string } };
    assert.ok(body.error?.message?.length);
    assert.ok(!String(body.error?.message).includes("at /"), "no stack trace leak");
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [
      ["OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MIN_MS", prevMin],
      ["OMNIROUTE_AUDIO_NODE_HEALTH_PROBE_TIMEOUT_MS", prevProbe],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("handleAudioTranscription: single node (no dynamic siblings) keeps legacy behavior", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: "solo", language: "en" }), {
        status: 200,
      })) as typeof fetch;
    const res = await handleAudioTranscription({
      formData: formDataFor(1000),
      credentials: null,
      resolvedProvider: primary,
      resolvedModel: "whisper-large-v3",
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, "solo");
  } finally {
    globalThis.fetch = realFetch;
  }
});
