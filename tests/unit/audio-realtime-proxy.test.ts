import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  realtimeAudioNodeCandidates,
  selectRealtimeAudioNode,
  authorizeRealtimeClient,
  bridgeRealtimeAudioSession,
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

/**
 * Bridge frame round-trip regression (live repro 2026-11-07 through the
 * ingress): the node protocol IS the wire protocol — the node dispatches on
 * the frame OP (binary = PCM16, text = JSON control). The old bridge()
 * dropped the opcode on the re-send (up.send(data as Buffer)): a text control
 * frame like {"type":"end"} re-sent as a binary frame was dropped by the
 * node — no final flush, no session_end, the client hung open forever, and
 * config overrides (silence_ms/language) silently never applied.
 */

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      t.unref();
    }),
  ]);
}

test("bridgeRealtimeAudioSession: frame opcodes are forwarded verbatim both ways", async () => {
  // Fake STT node: records the (text, isBinary) of every frame it receives;
  // on the TEXT "end" control it finalizes and closes cleanly — exactly the
  // real node's happy path (session_end → close 1000).
  const nodeSrv = new WebSocketServer({ port: 0 });
  const nodeReceived: Array<{ text: string; isBinary: boolean }> = [];
  nodeSrv.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      const text = data.toString("utf8");
      nodeReceived.push({ text, isBinary });
      if (!isBinary && text.includes('"end"')) {
        ws.send(JSON.stringify({ type: "transcript", text: "hello", final: true }));
        ws.send(JSON.stringify({ type: "session_end" }));
        ws.close(1000, "done");
      }
    });
  });
  await withTimeout(
    new Promise<void>((r) => nodeSrv.once("listening", () => r())),
    2000,
    "node listen"
  );
  const nodePort = (nodeSrv.address() as AddressInfo).port;

  // The proxy sees the browser as a SERVER-side socket (the ingress hands it
  // the upgraded connection). A fake clientSrv stands in for that browser, and
  // a real browser client drives the session.
  const clientSrv = new WebSocketServer({ port: 0 });
  let clientSock: WebSocket | null = null; // proxy-side handle (what the bridge wraps)
  clientSrv.on("connection", (ws) => {
    clientSock = ws;
  });
  await withTimeout(
    new Promise<void>((r) => clientSrv.once("listening", () => r())),
    2000,
    "client listen"
  );
  const clientPort = (clientSrv.address() as AddressInfo).port;

  // Fake browser: records every frame it receives.
  const browserReceived: Array<{ text: string; isBinary: boolean }> = [];
  let browser: WebSocket | null = null;

  try {
    const up = new WebSocket(`ws://127.0.0.1:${nodePort}`);
    browser = new WebSocket(`ws://127.0.0.1:${clientPort}`);
    browser.on("message", (data, isBinary) => {
      browserReceived.push({ text: data.toString("utf8"), isBinary });
    });
    await withTimeout(
      Promise.all([
        new Promise<void>((r) => up.once("open", () => r())),
        new Promise<void>((r) => browser!.once("open", () => r())),
      ]),
      2000,
      "ws open"
    );

    let onDoneCalls = 0;
    bridgeRealtimeAudioSession(clientSock!, up, "arcforge-stt", () => {
      onDoneCalls += 1;
    });

    // Drive the session: text config → binary audio → text end (the exact
    // client contract the node expects).
    browser!.send(JSON.stringify({ type: "config", sample_rate: 16000, silence_ms: 500 }));
    browser!.send(Buffer.from([0, 46, 0, -12345]), false);
    browser!.send(JSON.stringify({ type: "end" }));

    // Wait for the full teardown: node close(1000) → bridge cleanup → close
    // forwarded to the browser.
    await withTimeout(
      new Promise<void>((r) => browser!.once("close", () => r())),
      3000,
      "browser close"
    );

    // 1) The node must have received the control frames as TEXT and the audio as BINARY.
    const config = nodeReceived.find((f) => f.text.includes("config"));
    const end = nodeReceived.find((f) => f.text.includes('"end"'));
    const audio = nodeReceived.find(
      (f) => f.isBinary && !f.text.includes("config") && !f.text.includes('"end"')
    );
    assert.ok(config, "config control frame must reach the node");
    assert.equal(config!.isBinary, false, "config must reach the node as a TEXT frame");
    assert.ok(end, "end control frame must reach the node");
    assert.equal(end!.isBinary, false, "end must reach the node as a TEXT frame (the repro bug)");
    assert.ok(audio, "binary audio frame must reach the node");

    // 2) The browser must receive transcript + session_end as text frames.
    const transcript = browserReceived.find((f) => f.text.includes("transcript"));
    const sessionEnd = browserReceived.find((f) => f.text.includes("session_end"));
    assert.ok(transcript, "transcript must reach the browser");
    assert.equal(transcript!.isBinary, false, "transcript must reach the browser as a TEXT frame");
    assert.ok(sessionEnd, "session_end must reach the browser (was dropped by the opcode bug)");

    // 3) A CLEAN node close (1000) must not fabricate a spurious error frame.
    const errors = browserReceived.filter((f) => f.text.includes('"error"'));
    assert.equal(errors.length, 0, "clean close must not surface a spurious error frame");

    // 4) Teardown runs exactly once and the upstream socket ends CLOSED. (We
    // read readyState directly: the bridge's cleanup() calls
    // removeAllListeners() on both sockets before closing, so a close listener
    // added after bridging is deliberately detached — the browser close above
    // already proves the proxy tore the client side down.)
    assert.equal(onDoneCalls, 1, "onDone must fire exactly once");
    await withTimeout(
      new Promise<void>((r) => {
        const poll = () => (up.readyState === WebSocket.CLOSED ? r() : setTimeout(poll, 25));
        poll();
      }),
      2000,
      "upstream close"
    );
    assert.equal(up.readyState, WebSocket.CLOSED, "upstream socket must close");
  } finally {
    browser?.close();
    nodeSrv.close();
    clientSrv.close();
  }
});

test("bridgeRealtimeAudioSession: an abnormal node close surfaces a single error frame", async () => {
  // Fake STT node that dies mid-session (e.g. GPU context wedge) without
  // session_end: the bridge must NOT stay silent — the browser gets one
  // sanitized error frame, then the connection is torn down.
  const nodeSrv = new WebSocketServer({ port: 0 });
  nodeSrv.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "ready", model: "whisper-large-v3" }));
    // Die abnormally the moment the bridge starts forwarding.
    ws.close(1011, "internal error");
  });
  await withTimeout(
    new Promise<void>((r) => nodeSrv.once("listening", () => r())),
    2000,
    "node listen"
  );
  const nodePort = (nodeSrv.address() as AddressInfo).port;

  const clientSrv = new WebSocketServer({ port: 0 });
  let clientSock: WebSocket | null = null;
  clientSrv.on("connection", (ws) => {
    clientSock = ws;
  });
  await withTimeout(
    new Promise<void>((r) => clientSrv.once("listening", () => r())),
    2000,
    "client listen"
  );
  const clientPort = (clientSrv.address() as AddressInfo).port;

  const browserReceived: Array<{ text: string; isBinary: boolean }> = [];
  let browser: WebSocket | null = null;

  try {
    const up = new WebSocket(`ws://127.0.0.1:${nodePort}`);
    browser = new WebSocket(`ws://127.0.0.1:${clientPort}`);
    browser.on("message", (data, isBinary) => {
      browserReceived.push({ text: data.toString("utf8"), isBinary });
    });
    await withTimeout(
      Promise.all([
        new Promise<void>((r) => up.once("open", () => r())),
        new Promise<void>((r) => browser!.once("open", () => r())),
      ]),
      2000,
      "ws open"
    );

    let onDoneCalls = 0;
    bridgeRealtimeAudioSession(clientSock!, up, "arcforge-stt", () => {
      onDoneCalls += 1;
    });

    // The node's abnormal close must propagate to the browser.
    await withTimeout(
      new Promise<void>((r) => browser!.once("close", () => r())),
      3000,
      "browser close"
    );

    const errors = browserReceived.filter((f) => f.text.includes('"error"'));
    assert.equal(errors.length, 1, "an abnormal close must surface exactly one error frame");
    assert.equal(errors[0].isBinary, false, "the error frame must be text");
    assert.ok(errors[0].text.includes("STT node connection closed"));
    assert.equal(onDoneCalls, 1, "onDone must fire exactly once");
  } finally {
    browser?.close();
    nodeSrv.close();
    clientSrv.close();
  }
});
