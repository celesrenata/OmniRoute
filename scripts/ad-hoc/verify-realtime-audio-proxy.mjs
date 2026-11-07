/**
 * ad-hoc: end-to-end verification of the realtime audio WS proxy.
 * Boots the actual proxy daemon on 127.0.0.1, streams a real PCM16 clip to
 * it, and checks: transcripts flow through, /healthz answers, and auth is
 * enforced when OMNIROUTE_REQUIRE_API_KEY=on. One-shot; lives in scripts/ad-hoc.
 */
import { WebSocket } from "ws";
import http from "node:http";
import fs from "node:fs";

process.env.OMNIROUTE_REALTIME_AUDIO_PROXY_PORT = "20133";
process.env.OMNIROUTE_REALTIME_AUDIO_PROXY_HOST = "127.0.0.1";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures += 1;
}

const { initRealtimeAudioProxy } = await import("@/lib/services/audioRealtimeProxy.ts");
const server = await initRealtimeAudioProxy();
const port = server.address().port;
check("proxy started", port === 20133, `port=${port}`);

// ── healthz ──────────────────────────────────────────────────────────
const health = await new Promise((resolve) => {
  http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
});
check("GET /healthz → 200", health.status === 200, health.body);

// ── no-WS-request → 404 ─────────────────────────────────────────────
const notFound = await new Promise((resolve) => {
  http.get(`http://127.0.0.1:${port}/realtime-audio`, (res) => {
    res.on("data", () => {});
    res.on("end", () => resolve(res.statusCode));
  });
});
check("plain GET /realtime-audio → 404", notFound === 404, `status=${notFound}`);

// ── auth enforcement (REQUIRE on, no key → upgrade refused with 401) ─
process.env.OMNIROUTE_REQUIRE_API_KEY = "true";
const authRefused = await new Promise((resolve) => {
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/realtime-audio",
      headers: {
        Connection: "upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    },
    (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }
  );
  req.end();
});
check("WS upgrade without key → refused (401)", authRefused.status === 401, authRefused.body);

// ── path-scoped key with an INVALID key → also refused ───────────────
const badPathKey = await new Promise((resolve) => {
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/realtime-audio/not-a-real-key",
      headers: {
        Connection: "upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    },
    (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }
  );
  req.end();
});
check(
  "WS upgrade with invalid path-scoped key → refused",
  badPathKey.status === 401,
  badPathKey.body
);

// ── live stream: require off, stream a real clip, expect transcripts ──
process.env.OMNIROUTE_REQUIRE_API_KEY = "off";
// Build the stream exactly like the known-good reference client
// (/tmp/rt-test.mjs): 100ms frames at 40ms pacing + a 1.2s silence gap at
// 40% through the clip (forces the node's silence-based endpointer to emit).
import { spawnSync } from "node:child_process";
const pcmBuf = spawnSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-i",
    "/tmp/test.speech.wav",
    "-f",
    "s16le",
    "-ac",
    "1",
    "-ar",
    "16000",
    "pipe:1",
  ],
  { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }
).stdout;
const totalSamples = pcmBuf.length / 2;
const gapSamples = 19200; // 1.2s
const splitSample = Math.floor(totalSamples * 0.4);
const frames = [];
for (let s = 0; s < totalSamples; s += 1600) {
  const end = Math.min(s + 1600, totalSamples);
  frames.push(pcmBuf.subarray(s * 2, end * 2));
  if (s <= splitSample && end > splitSample) frames.push(Buffer.alloc(gapSamples * 2, 0));
}
const t0 = Date.now();
const result = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime-audio`);
  const transcripts = [];
  let ready = false;
  let ended = false;
  const timer = setTimeout(() => {
    ws.close();
    resolve({ transcripts, ready, ended, err: "timeout", ms: Date.now() - t0 });
  }, 45000);
  ws.on("open", async () => {
    for (const f of frames) {
      ws.send(f);
      await new Promise((r) => setTimeout(r, 40));
    }
    ws.send(JSON.stringify({ type: "end" }));
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "ready") ready = true;
    if (msg.type === "transcript") {
      transcripts.push({ text: msg.text, final: !!msg.final });
      if (msg.final) setTimeout(() => ws.close(), 1500);
    }
    if (msg.type === "session_end") ended = true;
  });
  ws.on("close", () => {
    clearTimeout(timer);
    resolve({ transcripts, ready, ended, err: null, ms: Date.now() - t0 });
  });
  ws.on("error", (err) => {
    clearTimeout(timer);
    resolve({ transcripts, ready, ended, err: String(err.message), ms: Date.now() - t0 });
  });
});

const finals = result.transcripts.filter((t) => t.final);
console.log("transcripts:", JSON.stringify(result.transcripts));
check("ready frame received", result.ready);
check("transcript(s) flowed through the proxy", finals.length > 0, `${finals.length} final`);
check("no error surfaced", result.err === null, result.err ?? "");
check(
  "stream duration sane (< 30s force-flush)",
  result.ms < 30000,
  `${(result.ms / 1000).toFixed(1)}s`
);

await new Promise((r) => server.close(r));
console.log(failures === 0 ? "ALL LIVE CHECKS PASSED" : `${failures} LIVE CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
