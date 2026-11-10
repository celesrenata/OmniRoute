/**
 * Realtime audio (streaming dictation) WebSocket proxy.
 *
 * Separate process-sidecar (port OMNIROUTE_REALTIME_AUDIO_PROXY_PORT, default
 * 20133) — same pattern as embedWsProxy (20131) and liveServer (20132).
 *
 * Why a sidecar instead of an App Router WS handler: Next 16 route handlers do
 * not support the WebSocket upgrade on the standalone server; both of the
 * existing WS surfaces (live dashboard, embedded-service tunnel) are separate
 * `ws` daemons. In k8s the ingress reverse-proxies same-origin
 * (ws[s]://host/realtime-audio → pod :20133), exactly like /live-ws → 20132.
 *
 * URL: ws[s]://host[:20133]/realtime-audio[/<api-key>]
 *
 * Wire protocol (mirrors the ArcForge STT node endpoint 1:1):
 *   Client → Proxy: binary frames = PCM16 mono 16 kHz; text frames = JSON
 *                   control ({type:"config"|"end"|"ping", ...})
 *   Proxy → Client: {type:"ready"|"transcript"|"session_end"|"error", ...}
 *
 * Node failover mirrors the batch path (open-sse/utils/audioNodeFailover.ts):
 *   - Candidate nodes resolve from provider_nodes for the arcforge-stt prefix
 *     (dynamic), falling back to the hardcoded registry node.
 *   - A cheap health pre-gate (GET /healthz — any HTTP answer = alive, only a
 *     timeout counts as a wedge, matching probeAudioNodeHealth) selects the
 *     candidate BEFORE the WebSocket handshake, so a dead node never burns the
 *     client's connection budget.
 *   - If the primary fails its handshake, the next candidate is tried (bounded
 *     by REALTIME_AUDIO_NODE_CONNECT_TIMEOUT_MS, default 4000). When every
 *     candidate fails the client gets a sanitized error and the connection is
 *     refused.
 *
 * Auth mirrors the batch transcription route (auth is the gate; arcforge-stt
 * is a local credential-less provider, so no node-level auth is forwarded):
 *   - API key via `Authorization: Bearer` / `x-api-key` header, or — because
 *     browsers cannot set request headers on a WebSocket handshake — in the
 *     path (`/realtime-audio/<key>`). Header extraction reuses the same
 *     extractApiKey() as the batch route. The query-string `?key=` form is
 *     intentionally NOT supported (security #3300 — credential-in-URL leaks
 *     into logs/Referer).
 *   - OMNIROUTE_REQUIRE_API_KEY=off → open (matches batch behavior).
 *   - The upstream WS is a credential-less LAN endpoint, so nothing is
 *     forwarded to it.
 *
 * Limits: OMNIROUTE_REALTIME_AUDIO_MAX_CONNECTIONS (default 25) concurrent
 * sessions (dictation streams are long-lived); the connection is refused with
 * 503 before the cap. An upstream disconnect surfaces as {type:"error"} +
 * close, never a silent drop.
 */

import http from "node:http";
import net from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import {
  audioNodeRoot,
  probeAudioNodeHealth,
} from "@omniroute/open-sse/utils/audioNodeFailover.ts";
import { AUDIO_TRANSCRIPTION_PROVIDERS } from "@omniroute/open-sse/config/audioRegistry.ts";
import { resolveDynamicAudioProviders } from "@/app/api/v1/_shared/audioProviderNodes";

const DEFAULT_PORT = 20133;
const PATH = "/realtime-audio";
/** Provider prefix backed by the provider_nodes failover fleet. */
const AUDIO_NODE_PREFIX = "arcforge-stt";

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readHostEnv(): string {
  const raw = process.env.OMNIROUTE_REALTIME_AUDIO_PROXY_HOST;
  return raw && raw.trim() ? raw.trim() : "0.0.0.0";
}

function requireApiKeyEnabled(): boolean {
  const raw = process.env.OMNIROUTE_REQUIRE_API_KEY ?? process.env.REQUIRE_API_KEY;
  if (raw === undefined || raw === null || raw === "") return true;
  return !/^\s*(off|false|0|no|disable(d)?|disabled)\s*$/i.test(String(raw));
}

/** Per-candidate WS connect ceiling. */
function nodeConnectTimeoutMs(): number {
  return readIntEnv("OMNIROUTE_REALTIME_AUDIO_NODE_CONNECT_TIMEOUT_MS", 4000);
}

export interface RealtimeAudioNodeCandidate {
  id: string;
  wsUrl: string;
  root: string;
}

/**
 * Realtime-node candidates for the arcforge-stt prefix, ordered [primary,
 * siblings…] in registration order. The WS path is a sibling of the batch
 * transcription path on the same node root (http://host:10300 → ws://host:10300).
 */
export function realtimeAudioNodeCandidates(
  dynamicProviders: Array<{ id: string; baseUrl: string }>
): RealtimeAudioNodeCandidate[] {
  const roots: Array<{ id: string; root: string }> = [];
  const seen = new Set<string>();
  for (const provider of dynamicProviders) {
    // The /v1/realtime protocol only exists on arcforge-stt nodes.
    if (provider.id !== AUDIO_NODE_PREFIX) continue;
    const root = audioNodeRoot({ baseUrl: provider.baseUrl });
    if (!root || seen.has(root)) continue;
    seen.add(root);
    roots.push({ id: provider.id, root });
  }
  // Dynamic nodes win; when there is none, fall back to the hardcoded registry
  // entry so a single-node deploy still resolves a candidate.
  if (roots.length === 0) {
    const hardcoded = AUDIO_TRANSCRIPTION_PROVIDERS[AUDIO_NODE_PREFIX];
    if (hardcoded?.baseUrl) {
      const root = audioNodeRoot({ baseUrl: hardcoded.baseUrl });
      if (root) roots.push({ id: hardcoded.id, root });
    }
  }
  return roots.map(({ id, root }) => ({
    id,
    root,
    wsUrl: `ws${root.startsWith("https") ? "s" : ""}://${new URL(root).host}/v1/realtime`,
  }));
}

/**
 * Pick the first candidate whose batch /healthz answers (any HTTP status =
 * alive; a timeout = a wedged node — same contract as the batch pre-gate).
 */
export async function selectRealtimeAudioNode(
  candidates: RealtimeAudioNodeCandidate[]
): Promise<RealtimeAudioNodeCandidate | null> {
  for (const candidate of candidates) {
    const health = await probeAudioNodeHealth(candidate.root);
    if (health.alive) return candidate;
  }
  return null;
}

/**
 * Read a path-scoped API key from `/realtime-audio/<key>[/...]` (the
 * path-token convention of the /vscode integration — browsers cannot set
 * request headers on a WebSocket handshake, and the query-string token
 * fallback was intentionally removed from the auth extractor, #3300).
 * Returns the key, or null when the path carries none.
 */
function extractPathScopedRealtimeKey(req: http.IncomingMessage): string | null {
  const rawUrl = req.url ?? "";
  const queryIndex = rawUrl.indexOf("?");
  const url = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  if (url === PATH) return null;
  if (!url.startsWith(`${PATH}/`)) return null;
  const segment = url.slice(PATH.length + 1).split("/")[0];
  if (!segment) return null;
  try {
    const decoded = decodeURIComponent(segment).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Validate a client's API key the same way the batch route does. The
 * validator is injectable so unit tests can stub key checks without opening
 * the database.
 */
export async function authorizeRealtimeClient(
  req: http.IncomingMessage,
  validateKey: (key: string) => Promise<boolean> = isValidApiKey
): Promise<boolean> {
  if (!requireApiKeyEnabled()) return true;
  // Header key first (curl/proxy clients); browsers can only carry the
  // key in the URL, so fall back to the path-scoped /realtime-audio/<key> form.
  const apiKey = extractApiKey(req) ?? extractPathScopedRealtimeKey(req);
  if (!apiKey) return false;
  return await validateKey(apiKey);
}

/**
 * Refuse a WebSocket upgrade with an HTTP status + sanitized JSON body.
 * (The upgrade has not completed, so a normal HTTP response is the correct
 * refusal — no raw socket writes.)
 */
function refuseUpgrade(
  socket: net.Socket,
  res: http.ServerResponse | null,
  status: number,
  code: string,
  message: string
): void {
  if (res) {
    res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ error: { code, message } }));
    return;
  }
  const body = JSON.stringify({ error: { code, message } });
  socket.write(
    `HTTP/1.1 ${status} Error\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n` +
      body
  );
  socket.destroy();
}

function isWsUpgrade(req: http.IncomingMessage): boolean {
  return (
    req.method === "GET" &&
    (String(req.headers.upgrade ?? "").toLowerCase() === "websocket" ||
      String(req.headers.connection ?? "")
        .toLowerCase()
        .includes("upgrade"))
  );
}

let httpServer: http.Server | null = null;

/**
 * Start the realtime-audio WS proxy. Idempotent; rejects if the port is
 * already taken (instrumentation-node treats that as non-fatal, same as the
 * embed WS proxy).
 */
export function initRealtimeAudioProxy(): Promise<http.Server> {
  if (httpServer) return Promise.resolve(httpServer);

  const port = readIntEnv("OMNIROUTE_REALTIME_AUDIO_PROXY_PORT", DEFAULT_PORT);
  const host = readHostEnv();
  const maxConnections = readIntEnv("OMNIROUTE_REALTIME_AUDIO_MAX_CONNECTIONS", 25);

  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });

  let activeConnections = 0;

  server.on("request", (req, res) => {
    // Same-origin reverse proxy (Traefik 443 → pod :20133) needs a stable
    // same-origin URL; /healthz is exposed for the k8s readiness probe.
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", activeConnections, maxConnections }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
  });

  server.on("upgrade", (req, socket, head) => {
    if (!isWsUpgrade(req) || !req.url?.split("?")[0].startsWith(PATH)) {
      refuseUpgrade(socket, null, 404, "NOT_FOUND", "not found");
      return;
    }
    void handleUpgrade(req, socket, head);
  });

  async function handleUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer
  ): Promise<void> {
    try {
      if (!(await authorizeRealtimeClient(req))) {
        refuseUpgrade(socket, null, 401, "AUTH_002", "Authentication required");
        return;
      }
      if (activeConnections >= maxConnections) {
        refuseUpgrade(socket, null, 503, "RATE_429", "Realtime audio concurrency limit reached");
        return;
      }

      const dynamic = await resolveDynamicAudioProviders(
        "/audio/transcriptions",
        "audio-transcriptions"
      );
      const candidates = realtimeAudioNodeCandidates(dynamic);
      if (candidates.length === 0) {
        refuseUpgrade(socket, null, 502, "AUDIO_NODE_NONE", "No STT node available");
        return;
      }

      const connectTimeout = nodeConnectTimeoutMs();
      let upstream: WebSocket | null = null;
      let selected: RealtimeAudioNodeCandidate | null = null;
      for (const candidate of candidates) {
        // Pre-gate: a wedged node (timeout on /healthz) is skipped outright so
        // the client never waits on a dead GPU context.
        const health = await probeAudioNodeHealth(candidate.root);
        if (!health.alive) {
          console.warn(`[realtime-audio] node ${candidate.id} failed health probe; failing over`);
          continue;
        }
        try {
          upstream = await connectUpstream(candidate, connectTimeout);
          selected = candidate;
          break;
        } catch {
          console.warn(`[realtime-audio] node ${candidate.id} WS connect failed; trying next`);
        }
      }

      if (!upstream || !selected) {
        refuseUpgrade(socket, null, 502, "AUDIO_NODE_DOWN", "No STT node is reachable");
        return;
      }

      const up = upstream;
      const sel = selected;
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        activeConnections += 1;
        bridgeRealtimeAudioSession(clientWs, up, sel.id, () => {
          activeConnections = Math.max(0, activeConnections - 1);
        });
        console.log(`[realtime-audio] session started on node ${sel.id}`);
      });
    } catch (err: unknown) {
      // Never leak internals; the batch-side sanitizer contract applies.
      const detail =
        err instanceof Error ? "realtime audio setup failed" : "realtime audio setup failed";
      console.warn("[realtime-audio] upgrade setup failed:", detail);
      refuseUpgrade(socket, null, 502, "AUDIO_REALTIME_ERROR", "realtime audio setup failed");
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      console.log(
        `[realtime-audio] streaming dictation proxy listening on ${host}:${port} (path ${PATH}, max ${maxConnections})`
      );
      httpServer = server;
      resolve(server);
    });
  });
}

/**
 * Bridge a client WS and an upstream node WS, forwarding frames both ways
 * verbatim. Exported so the frame-opcode round-trip (the node protocol IS the
 * wire protocol: binary = PCM16, text = JSON control) is unit-testable without
 * the full upgrade/handshake path.
 */
export function bridgeRealtimeAudioSession(
  clientWs: WebSocket,
  up: WebSocket,
  nodeId: string,
  onDone: () => void
): void {
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    onDone();
    clientWs.removeAllListeners();
    up.removeAllListeners();
    try {
      clientWs.close();
    } catch {
      // already closed
    }
    try {
      up.close();
    } catch {
      // already closed
    }
  };

  // Client → node: binary audio frames and JSON control frames pass through
  // untouched (the node protocol is the wire protocol). The frame OP must be
  // forwarded verbatim: the node dispatches on it (binary = PCM16, text = JSON
  // control). Re-sending a control frame as binary made the node drop it —
  // `end` never landed, so no final flush, no session_end, and every session
  // leaked an open connection (repro 2026-11-07, live through the ingress).
  clientWs.on("message", (data, isBinary) => {
    if (up.readyState === WebSocket.OPEN) up.send(data as Buffer, { binary: isBinary });
  });
  clientWs.on("close", cleanup);
  clientWs.on("error", cleanup);

  // Node → client: ready / transcript / session_end pass through; a mid-
  // session disconnect is surfaced, never silent.
  up.on("message", (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data as Buffer, { binary: isBinary });
  });
  up.on("close", (code: number) => {
    // A clean node close (1000 after session_end) is the protocol's normal
    // teardown — forwarding the close is enough. Only an abnormal close gets a
    // surfaced error frame.
    if (code !== 1000 && !done && clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.send(JSON.stringify({ type: "error", message: "STT node connection closed" }));
      } catch {
        // client already gone
      }
    }
    cleanup();
  });
  up.on("error", () => {
    console.warn(`[realtime-audio] upstream error on node ${nodeId}`);
    cleanup();
  });
}

function connectUpstream(
  candidate: RealtimeAudioNodeCandidate,
  timeoutMs: number
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(candidate.wsUrl, {
      handshakeTimeout: timeoutMs,
      maxPayload: 64 * 1024 * 1024, // dictation streams: many small frames
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("connect timeout"));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error("connect failed"));
    });
  });
}

/**
 * Entrypoint used by instrumentation-node (side-effect import). Honors
 * OMNIROUTE_REALTIME_AUDIO_PROXY_ENABLED (default ON, matching the live-WS
 * daemon convention); a disabled flag or a busy port is non-fatal.
 */
export async function initRealtimeAudioProxyDaemon(): Promise<void> {
  const raw = process.env.OMNIROUTE_REALTIME_AUDIO_PROXY_ENABLED;
  if (raw !== undefined && !/^\s*(on|true|1|yes|enable(d)?|enabled)\s*$/i.test(raw)) {
    console.log("[realtime-audio] proxy disabled by OMNIROUTE_REALTIME_AUDIO_PROXY_ENABLED");
    return;
  }
  try {
    await initRealtimeAudioProxy();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[realtime-audio] proxy failed to start (non-fatal):", msg);
  }
}
