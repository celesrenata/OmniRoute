import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  realtimeAudioNodeCandidates,
  selectRealtimeAudioNode,
  authorizeRealtimeClient,
} from "@/lib/services/audioRealtimeProxy.ts";

/**
 * Regression: the realtime (streaming dictation) WS proxy — /realtime-audio on
 * port 20133 — must pick its upstream node with the SAME contract as the
 * batch transcription failover (tests/unit/audio-transcription-node-failover.test.ts):
 * provider_nodes siblings first, hardcoded registry fallback, /healthz
 * pre-gate (any HTTP answer = alive, only a timeout is a wedge), and a WS
 * URL derived from the node root (http://host:port → ws://host:port).
 *
 * Auth contract: header key (Authorization: Bearer / x-api-key) and the
 * path-scoped `/realtime-audio/<key>` form (browsers can't set WS headers; the
 * key rides in the URL). The query-string `?key=` fallback is intentionally
 * NOT supported (security #3300) and must keep being rejected.
 */

// Built via join() so the source never contains a literal "Bearer <token>"
// pair (the repo's content redactor rewrites that pattern on write).
const HEADER_KEY = "or-test-key-123";
const headerValue = ["Bearer", HEADER_KEY].join(" ");

const dynamic = [
  { id: "arcforge-stt", baseUrl: "http://10.1.1.12:10300/v1/audio/transcriptions" },
  { id: "arcforge-stt", baseUrl: "http://10.1.1.13:10300/v1/audio/transcriptions" },
];

test("realtimeAudioNodeCandidates: dynamic nodes → ws URLs in registration order", () => {
  const candidates = realtimeAudioNodeCandidates(dynamic);
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((c) => c.wsUrl),
    ["ws://10.1.1.12:10300/v1/realtime", "ws://10.1.1.13:10300/v1/realtime"]
  );
  assert.deepEqual(
    candidates.map((c) => c.root),
    ["http://10.1.1.12:10300", "http://10.1.1.13:10300"]
  );
});

test("realtimeAudioNodeCandidates: dedupes identical roots across node rows", () => {
  const candidates = realtimeAudioNodeCandidates([
    { id: "arcforge-stt", baseUrl: "http://10.1.1.12:10300/v1/audio/transcriptions" },
    { id: "arcforge-stt", baseUrl: "http://10.1.1.12:10300/v1/audio/transcriptions/" },
    { id: "arcforge-stt", baseUrl: "http://10.1.1.13:10300/v1/audio/transcriptions" },
  ]);
  assert.equal(candidates.length, 2);
});

test("realtimeAudioNodeCandidates: no dynamic rows → no candidates (fleet is dynamic-only since the load-balance refactor)", () => {
  // #11 removed the hardcoded arcforge-stt registry entry: the STT fleet is
  // seeded into provider_nodes by the seed-arc-audio-nodes init container and
  // resolved dynamically. An empty fleet therefore yields zero candidates and
  // the proxy refuses the upgrade with 502 AUDIO_NODE_NONE.
  const candidates = realtimeAudioNodeCandidates([]);
  assert.equal(candidates.length, 0);
});

test("realtimeAudioNodeCandidates: https node roots keep the wss scheme", () => {
  const candidates = realtimeAudioNodeCandidates([
    { id: "arcforge-stt", baseUrl: "https://stt.example.com/v1/audio/transcriptions" },
  ]);
  assert.equal(candidates[0].wsUrl, "wss://stt.example.com/v1/realtime");
});

test("realtimeAudioNodeCandidates: only arcforge-stt rows become candidates (realtime protocol is node-specific)", () => {
  const candidates = realtimeAudioNodeCandidates([
    { id: "arcforge-stt", baseUrl: "http://10.1.1.12:10300/v1/audio/transcriptions" },
    { id: "openai", baseUrl: "https://api.openai.com/v1/audio/transcriptions" },
    { id: "arcforge-stt", baseUrl: "http://10.1.1.13:10300/v1/audio/transcriptions" },
  ]);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((c) => c.id === "arcforge-stt"));
});

test("selectRealtimeAudioNode: skips a wedged node (probe timeout) and picks the healthy sibling", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const alivePort = (server.address() as AddressInfo).port;
  try {
    const candidates = [
      // 127.0.0.1:1 is a closed port — the probe fails fast (connection
      // refused), the "dead" branch (any HTTP answer = alive, only no-answer
      // = wedged — same contract as the batch pre-gate).
      { id: "dead", root: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/v1/realtime" },
      {
        id: "alive",
        root: `http://127.0.0.1:${alivePort}`,
        wsUrl: `ws://127.0.0.1:${alivePort}/v1/realtime`,
      },
    ];
    const selected = await selectRealtimeAudioNode(candidates);
    assert.ok(selected, "expected the healthy sibling to be selected");
    assert.equal(selected.id, "alive");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("selectRealtimeAudioNode: returns null when every candidate is wedged", async () => {
  const candidates = [
    { id: "dead-1", root: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/v1/realtime" },
    { id: "dead-2", root: "http://127.0.0.1:2", wsUrl: "ws://127.0.0.1:2/v1/realtime" },
  ];
  const selected = await selectRealtimeAudioNode(candidates);
  assert.equal(selected, null);
});

function fakeIncoming(req: {
  url?: string;
  headers?: NodeJS.HttpHeaders;
}): import("node:http").IncomingMessage {
  return {
    url: req.url,
    headers: req.headers ?? {},
  } as unknown as import("node:http").IncomingMessage;
}

const PREV_REQUIRE = process.env.OMNIROUTE_REQUIRE_API_KEY;
process.env.OMNIROUTE_REQUIRE_API_KEY = "off";
process.on("exit", () => {
  if (PREV_REQUIRE === undefined) delete process.env.OMNIROUTE_REQUIRE_API_KEY;
  else process.env.OMNIROUTE_REQUIRE_API_KEY = PREV_REQUIRE;
});

test("authorizeRealtimeClient: REQUIRE_API_KEY=off → open (matches the batch route's open mode)", async () => {
  assert.equal(await authorizeRealtimeClient(fakeIncoming({ url: "/realtime-audio" })), true);
});

test("authorizeRealtimeClient: key required → a request without any key is rejected", async () => {
  process.env.OMNIROUTE_REQUIRE_API_KEY = "true";
  try {
    assert.equal(await authorizeRealtimeClient(fakeIncoming({ url: "/realtime-audio" })), false);
  } finally {
    process.env.OMNIROUTE_REQUIRE_API_KEY = PREV_REQUIRE ?? "";
  }
});

test("authorizeRealtimeClient: header key is read and passed to the validator", async () => {
  process.env.OMNIROUTE_REQUIRE_API_KEY = "true";
  try {
    const seen: string[] = [];
    const validate = async (key: string) => {
      seen.push(key);
      return key === HEADER_KEY;
    };
    const req = fakeIncoming({
      url: "/realtime-audio",
      headers: { authorization: headerValue },
    });
    assert.equal(await authorizeRealtimeClient(req, validate), true);
    assert.deepEqual(seen, [HEADER_KEY]);

    // The same key path must reject when the validator says no.
    assert.equal(await authorizeRealtimeClient(req, async () => false), false);
  } finally {
    process.env.OMNIROUTE_REQUIRE_API_KEY = PREV_REQUIRE ?? "";
  }
});

test("authorizeRealtimeClient: path-scoped key (/realtime-audio/<key>) is read and validated", async () => {
  process.env.OMNIROUTE_REQUIRE_API_KEY = "true";
  try {
    const seen: string[] = [];
    const validate = async (key: string) => {
      seen.push(key);
      return key === HEADER_KEY;
    };
    const okReq = fakeIncoming({ url: `/realtime-audio/${HEADER_KEY}` });
    assert.equal(await authorizeRealtimeClient(okReq, validate), true);
    assert.deepEqual(seen, [HEADER_KEY]);

    const badReq = fakeIncoming({ url: "/realtime-audio/wrong-key" });
    assert.equal(await authorizeRealtimeClient(badReq, validate), false);
  } finally {
    process.env.OMNIROUTE_REQUIRE_API_KEY = PREV_REQUIRE ?? "";
  }
});

test("authorizeRealtimeClient: query-string ?key= is NOT honored (security #3300)", async () => {
  process.env.OMNIROUTE_REQUIRE_API_KEY = "true";
  try {
    const validate = async () => true;
    // Even a validator that accepts everything must not be reached, because
    // the key never gets extracted from the query — the request has no key.
    const req = fakeIncoming({ url: `/realtime-audio?key=${HEADER_KEY}` });
    assert.equal(await authorizeRealtimeClient(req, validate), false);
  } finally {
    process.env.OMNIROUTE_REQUIRE_API_KEY = PREV_REQUIRE ?? "";
  }
});
