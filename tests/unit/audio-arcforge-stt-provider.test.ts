import test from "node:test";
import assert from "node:assert/strict";

const { handleAudioTranscription } = await import("../../open-sse/handlers/audioTranscription.ts");
const { AUDIO_TRANSCRIPTION_PROVIDERS, parseTranscriptionModel } =
  await import("../../open-sse/config/audioRegistry.ts");

type FetchInit = { method?: string; headers?: Record<string, string>; body?: unknown };
type ErrorPayload = { error: { message: string } };

function buildFile(contents: string, name: string, type: string) {
  return new File([Buffer.from(contents)], name, { type });
}

function transcriptionFormData(model = "arcforge-stt/whisper-large-v3") {
  const formData = new FormData();
  formData.append("model", model);
  formData.append("file", buildFile("abc", "clip.wav", "audio/wav"));
  return formData;
}

test("ArcForge STT is registered for transcription (OpenAI-compatible, credential-less)", () => {
  const provider = AUDIO_TRANSCRIPTION_PROVIDERS["arcforge-stt"];
  assert.ok(provider, "arcforge-stt entry missing from AUDIO_TRANSCRIPTION_PROVIDERS");
  assert.equal(provider.id, "arcforge-stt");
  // Live service contract (gremlin-1, OpenVINO GPU INT8 — see
  // _tasks/hands-off/2026-11-05_arcforge-stt-openvino-gpu_v1.md). GET /v1/models
  // on the running service reports the model id as `whisper-large-v3`.
  assert.equal(provider.baseUrl, "http://10.1.1.12:10300/v1/audio/transcriptions");
  assert.equal(provider.authType, "none");
  assert.equal(provider.authHeader, "none");
  assert.equal(provider.format, "openai");
  assert.deepEqual(
    provider.models.map((model) => model.id),
    ["whisper-large-v3"]
  );
});

test("parseTranscriptionModel resolves arcforge-stt/<model> without dynamic providers", () => {
  assert.deepEqual(parseTranscriptionModel("arcforge-stt/whisper-large-v3"), {
    provider: "arcforge-stt",
    model: "whisper-large-v3",
  });
});

test("handleAudioTranscription proxies arcforge-stt as a single sync multipart POST, no auth", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];

  globalThis.fetch = async (url, options: FetchInit = {}) => {
    const stringUrl = String(url);
    calls.push({
      url: stringUrl,
      method: options?.method || "GET",
      headers: options.headers || {},
    });

    if (stringUrl === "http://10.1.1.12:10300/v1/audio/transcriptions") {
      // No Authorization header — authType "none" must not send credentials.
      assert.equal(options.headers.Authorization, undefined, "no auth header for authType none");
      assert.match(options.headers["Content-Type"], /^multipart\/form-data; boundary=/);
      assert.ok(options.body instanceof Uint8Array);
      const bodyText = new TextDecoder().decode(options.body);
      assert.match(bodyText, /name="model"\r\n\r\nwhisper-large-v3\r\n/);
      assert.match(bodyText, /filename="clip\.wav"/);
      assert.match(bodyText, /Content-Type: audio\/wav/);
      return Response.json({
        object: "transcription",
        text: "hello from arcforge stt",
        language: "en",
      });
    }

    return new Response(JSON.stringify({ error: `unexpected fetch: ${stringUrl}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const res = await handleAudioTranscription({
      formData: transcriptionFormData("arcforge-stt/whisper-large-v3"),
      credentials: null,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { object: string; text: string };
    assert.equal(body.object, "transcription");
    assert.equal(body.text, "hello from arcforge stt");
    assert.equal(calls.length, 1, "single sync request, no polling");
    assert.equal(calls[0].method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription surfaces arcforge-stt upstream errors via upstreamErrorResponse", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === "http://10.1.1.12:10300/v1/audio/transcriptions") {
      return new Response(JSON.stringify({ error: { message: "no speech detected" } }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const res = await handleAudioTranscription({
      formData: transcriptionFormData("arcforge-stt/whisper-large-v3"),
      credentials: null,
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as ErrorPayload;
    assert.match(body.error.message, /no speech detected/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
