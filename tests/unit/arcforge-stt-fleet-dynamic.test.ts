// Regression guard: a fleet of same-prefix provider_nodes must be addressable
// and load-balanced, which requires the prefix to be absent from the hardcoded
// audio registry.
//
// The original single-host `arcforge-stt` provider was hardcoded in
// `AUDIO_TRANSCRIPTION_PROVIDERS` (open-sse/config/audioRegistry.ts) pointing at
// one GPU box. The audio routes check `getTranscriptionProvider(prefix)` BEFORE
// consulting the dynamic provider_nodes list — so while the hardcoded entry
// exists, the route pins every request to that one host and the dynamic fleet
// (all other same-prefix nodes) is invisible. With the fleet now registered as
// provider_nodes (one row per GPU host, shared prefix), the hardcoded entry is a
// permanent pin and the least-loaded picker never runs.
//
// These tests assert the fleet is fully dynamic: the prefix is NOT hardcoded,
// both same-prefix nodes resolve, and the picker spreads across them.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDIO_TRANSCRIPTION_PROVIDERS,
  getTranscriptionProvider,
} from "@omniroute/open-sse/config/audioRegistry";
import { pickLeastLoadedNode, resetNodeLoad } from "@/shared/utils/leastLoadedNode";
import { selectAudioProviderNodes } from "@/app/api/v1/_shared/audioProviderNodes";

// The shared prefix the ArcForge STT fleet is registered under in
// provider_nodes (see the operator's node rows).
const FLEET_PREFIX = "arcforge-stt";

test.afterEach(() => resetNodeLoad());

test("hardcoded transcription registry does NOT pin the arcforge-stt fleet prefix", () => {
  // If this is hardcoded, getTranscriptionProvider returns it and the route
  // pins to one host — the dynamic fleet becomes unreachable. The fleet must be
  // addressed via provider_nodes so the least-loaded picker can spread it.
  assert.equal(
    AUDIO_TRANSCRIPTION_PROVIDERS[FLEET_PREFIX],
    undefined,
    `hardcoded provider "${FLEET_PREFIX}" pins all traffic to one host; the fleet must be dynamic (provider_nodes)`
  );
  assert.equal(
    getTranscriptionProvider(FLEET_PREFIX),
    null,
    `getTranscriptionProvider("${FLEET_PREFIX}") must be null so the route falls through to the dynamic nodes`
  );
});

test("dynamic resolution exposes BOTH same-prefix fleet nodes", () => {
  // Two provider_nodes share the prefix (one per GPU host), both on the local
  // audio allowlist. Resolution must expose both so the picker can spread.
  process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS = "10.1.1.12,10.1.1.13";
  try {
    const nodeRow = (id: string, host: string) => ({
      id,
      prefix: FLEET_PREFIX,
      apiType: "audio-transcriptions",
      baseUrl: `http://${host}:10300/v1`,
    });
    const nodes = [
      nodeRow("arc-stt-12-5c3d59d9", "10.1.1.12"),
      nodeRow("arc-stt-13-8f2e1a47", "10.1.1.13"),
    ] as unknown as Parameters<typeof selectAudioProviderNodes>[0];
    const providers = selectAudioProviderNodes(nodes, {
      audioPath: "/audio/transcriptions",
      nodeApiType: "audio-transcriptions",
      allowRemote: false,
    });
    const bases = providers.map((p) => p.baseUrl).sort();
    assert.ok(
      bases.some((b) => b.includes("10.1.1.12")),
      `expected a 10.1.1.12 node in ${JSON.stringify(bases)}`
    );
    assert.ok(
      bases.some((b) => b.includes("10.1.1.13")),
      `expected a 10.1.1.13 node in ${JSON.stringify(bases)}`
    );
    assert.equal(
      providers.filter((p) => p.id === FLEET_PREFIX).length,
      2,
      "both fleet nodes must be exposed under the shared prefix for the picker"
    );
  } finally {
    delete process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS;
  }
});

test("picker spreads across two same-prefix fleet nodes on a cold pool", () => {
  const nodes = [
    { key: "10.1.1.12", raw: { baseUrl: "http://10.1.1.12:10300" } },
    { key: "10.1.1.13", raw: { baseUrl: "http://10.1.1.13:10300" } },
  ];
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const r = pickLeastLoadedNode(
      nodes,
      (n) => n.key,
      () => true
    );
    assert.ok(r);
    seen.add(r.key);
  }
  assert.equal(
    seen.size,
    2,
    "a cold two-node fleet must be spread across BOTH hosts (no single-host pin)"
  );
});
