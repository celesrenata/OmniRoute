// ArcForge STT fleet — handler contract tests on the DYNAMIC provider_nodes path.
//
// The fleet used to live as a hardcoded single-host entry in
// AUDIO_TRANSCRIPTION_PROVIDERS; it is now a set of same-prefix provider_nodes
// (one per GPU host) resolved by the least-loaded picker. These tests exercise
// the handler against a provider built from a dynamic node row, so the
// contract they guard is: sync multipart POST, optional-credential auth, and
// upstream error surfacing — independent of how the node was resolved.

import test from "node:test";
import assert from "node:assert/strict";

const { handleAudioTranscription } = await import("../../open-sse/handlers/audioTranscription.ts");
const { AUDIO_TRANSCRIPTION_PROVIDERS, buildDynamicAudioProvider, parseTranscriptionModel } =
  await import("../../open-sse/config/audioRegistry.ts");
const { isAllowlistedLocalAudioHost } = await import("../../open-sse/config/audioRegistry.ts");

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

// The shape of an allowlisted fleet node row (see provider_nodes: prefix
// `arcforge-stt`, one host per box).
const FLEET_NODE = {
  id: "arc-stt-12-5c3d59d9",
  prefix: "arcforge-stt",
  apiType: "audio-transcriptions",
  baseUrl: "http://10.1.1.12:10300/v1",
} as unknown as Parameters<typeof buildDynamicAudioProvider>[0];

function fleetProvider() {
  // Allowlist the host so the dynamic provider carries credentialsOptional
  // (the route then dispatches without requiring a stored connection key).
  const prev = process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS;
  process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS = "10.1.1.12,10.1.1.13";
  try {
    return buildDynamicAudioProvider(FLEET_NODE, "/audio/transcriptions");
  } finally {
    if (prev === undefined) delete process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS;
    else process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS = prev;
  }
}

test("fleet node builds a dynamic transcription provider (credential-optional, no hardcoded pin)", () => {
  // The prefix must NOT be a hardcoded registry entry — that was the bug that
  // pinned the whole fleet to one host.
  assert.equal(AUDIO_TRANSCRIPTION_PROVIDERS["arcforge-stt"], undefined);
  assert.ok(
    isAllowlistedLocalAudioHost("http://10.1.1.12:10300/v1", "10.1.1.12,10.1.1.13"),
    "fleet host must match the allowlist entry"
  );
  const provider = fleetProvider();
  assert.equal(provider.id, "arcforge-stt");
  assert.equal(provider.baseUrl, "http://10.1.1.12:10300/v1/audio/transcriptions");
  assert.equal(provider.authType, "apikey");
  assert.equal(provider.authHeader, "bearer");
  assert.equal(provider.credentialsOptional, true);
  assert.equal(
    provider.credentialProviderId,
    "arc-stt-12-5c3d59d9",
    "connections are stored under the node id, not the shared prefix"
  );
});

test("parseTranscriptionModel resolves arcforge-stt/<model> from a dynamic fleet provider", () => {
  const parsed = parseTranscriptionModel("arcforge-stt/whisper-large-v3", [fleetProvider()]);
  assert.equal(parsed.provider, "arcforge-stt");
  assert.equal(parsed.model, "whisper-large-v3");
});

test("handleAudioTranscription proxies a dynamic fleet node as a sync multipart POST, no auth", async () => {
  const provider = fleetProvider();
  let capturedUrl = "";
  let capturedInit: FetchInit | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: FetchInit): Promise<Response> => {
    capturedUrl = String(input);
    capturedInit = init ?? {};
    return new Response(JSON.stringify({ text: "hello world", language: "en" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  try {
    const response = await handleAudioTranscription({
      formData: transcriptionFormData(),
      credentials: null,
      resolvedProvider: provider,
      resolvedModel: "whisper-large-v3",
    });
    assert.ok(response);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { text: string };
    assert.equal(body.text, "hello world");
    assert.equal(
      capturedUrl,
      "http://10.1.1.12:10300/v1/audio/transcriptions",
      "sync POST must hit the fleet node URL"
    );
    assert.equal(capturedInit?.method, "POST");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("handleAudioTranscription surfaces dynamic fleet node upstream errors via upstreamErrorResponse", async () => {
  const provider = fleetProvider();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        error: { message: "openvino: backend unavailable", type: "upstream_error" },
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }) as unknown as typeof fetch;

  try {
    const response = await handleAudioTranscription({
      formData: transcriptionFormData(),
      credentials: null,
      resolvedProvider: provider,
      resolvedModel: "whisper-large-v3",
    });
    assert.ok(response);
    assert.equal(response.status, 503);
    const body = (await response.json()) as ErrorPayload;
    assert.ok(body.error, "error body expected");
    assert.ok(
      typeof body.error.message === "string" && body.error.message.length > 0,
      "sanitized error message expected"
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
