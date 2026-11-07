// #arcforge-stt node failover — the ArcForge STT fleet is ONE provider prefix
// (`arcforge-stt`) backed by N provider_node rows (one per GPU host). The
// transcription dispatch was pinned to the first-registered node with a
// single `.find()` and no response-start ceiling: when that node's GPU context
// wedged (process alive, spinning CPU, zero bytes on the wire — even its
// /healthz stopped answering), every dictation request burned the route's
// full 300s budget while the sibling answered in <1s.
//
// These helpers implement the failover, mirroring the provider-level circuit
// breaker's split: the health probe is a cheap pre-gate (any HTTP answer,
// even 404, means the service loop is alive — only a TIMEOUT is a wedge),
// and the response-start ceiling bounds the actual POST per candidate so a
// node that passes the probe but stalls mid-upload fails over too. The LAST
// candidate always keeps the full route budget so a legitimately long
// transcription is never cut short.

export interface AudioNodeCandidate {
  id: string;
  baseUrl: string;
}

/** The audio API path the dynamic provider baseUrl carries as suffix. */
const AUDIO_PATH = "/v1/audio/transcriptions";

/**
 * Candidate nodes for a dynamic (provider_node-backed) provider, ordered
 * [primary, siblings…] in registration order. Hardcoded providers (their
 * baseUrl never carries the dynamic node path) get no siblings.
 */
export function audioNodeCandidates(
  primary: { id: string; baseUrl: string },
  dynamicProviders: Array<{ id: string; baseUrl: string }>,
  audioPath = AUDIO_PATH
): AudioNodeCandidate[] {
  // Failover only exists for node-backed providers, whose baseUrl carries the
  // audio path. A hardcoded provider (path appended at dispatch time) has no
  // siblings to fail over to, so anchor on the primary: if it doesn't carry
  // the path there is nothing to fail over.
  if (!primary.baseUrl.endsWith(audioPath)) return [];

  // resolveDynamicAudioProviders registers each physical node twice (by prefix
  // and by row id — the same baseUrl under two addressable ids). Dedupe on
  // baseUrl so one wedged node is probed and POSTed at most once. A node
  // serving a different apiType (TTS path) is never a transcription candidate.
  const seen = new Set<string>();
  const candidates: AudioNodeCandidate[] = [];
  for (const candidate of [primary, ...dynamicProviders]) {
    if (!candidate.baseUrl.endsWith(audioPath)) continue;
    if (seen.has(candidate.baseUrl)) continue;
    seen.add(candidate.baseUrl);
    candidates.push({ id: candidate.id, baseUrl: candidate.baseUrl });
  }
  return candidates;
}

/**
 * The node's HTTP root with the audio path suffix stripped — the base for the
 * `/healthz` probe. Null when the baseUrl does not carry the audio path
 * (hardcoded provider, or a path mismatch we must not guess at).
 */
export function audioNodeRoot(node: { baseUrl: string }, audioPath = AUDIO_PATH): string | null {
  if (!node.baseUrl.endsWith(audioPath)) return null;
  return node.baseUrl.slice(0, node.baseUrl.length - audioPath.length);
}

const MIN_RESPONSE_START_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_START_TIMEOUT_MS = 300_000; // the route's maxDuration=300s budget
// A healthy STT node starts its response after finishing inference, which runs
// faster than realtime on the Arc GPU. Give a non-last candidate up to 2× the
// audio duration to START (headers observed) before we treat it as wedged — a
// healthy answer arrives in <1× duration, a wedged node never starts. This is
// the secondary guard; the /healthz pre-probe catches a fully-wedged node even
// earlier.
const RESPONSE_START_REALTIME_MULTIPLIER = 2;
// 16 kHz s16 mono ≈ 32 000 B/s — used only to estimate audio duration from a
// raw file size. Compressed containers underestimate duration, which only
// makes the ceiling shorter (fail over sooner) — the safe direction.
const AUDIO_BYTES_PER_SECOND = 32_000;
const HEALTH_PROBE_PATH = "/healthz";
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 3_000;

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return fallback;
}

/** Estimate audio duration (ms) from a raw file byte size. */
export function estimateAudioDurationMs(fileBytes: number): number {
  if (!Number.isFinite(fileBytes) || fileBytes <= 0) return 0;
  return Math.round((fileBytes / AUDIO_BYTES_PER_SECOND) * 1000);
}

/**
 * Response-start ceiling for a non-last candidate transcription POST, derived
 * from the estimated audio duration: up to 2× realtime, bounded to the route's
 * 300s budget. The last candidate ignores this entirely and keeps the full
 * budget, so a legitimately long transcription is never cut short.
 */
export function resolveAudioResponseStartTimeoutMs(estimatedAudioDurationMs: number): number {
  const minMs = readPositiveInt(
    "OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MIN_MS",
    MIN_RESPONSE_START_TIMEOUT_MS
  );
  const maxMs = readPositiveInt(
    "OMNIROUTE_AUDIO_NODE_RESPONSE_START_TIMEOUT_MAX_MS",
    MAX_RESPONSE_START_TIMEOUT_MS
  );
  const ms = Math.ceil(Math.max(0, estimatedAudioDurationMs) * RESPONSE_START_REALTIME_MULTIPLIER);
  return Math.max(minMs, Math.min(maxMs, ms));
}

/**
 * Liveness probe for one node. The ArcForge STT service serves a synchronous
 * `/healthz` on the FastAPI loop: a wedged GPU context starves even that
 * (observed: 0 bytes in 5s), while a healthy node answers in <10ms. Any HTTP
 * status means the service loop is alive — only a timeout/refusal counts as
 * dead, so a 404 on the probe path does NOT trigger failover.
 */
export async function probeAudioNodeHealth(
  nodeRoot: string,
  timeoutMs = readPositiveInt(
    "OMNIROUTE_AUDIO_NODE_HEALTH_PROBE_TIMEOUT_MS",
    DEFAULT_HEALTH_PROBE_TIMEOUT_MS
  )
): Promise<{ alive: boolean; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${nodeRoot}${HEALTH_PROBE_PATH}`, {
      method: "GET",
      signal: controller.signal,
    });
    return { alive: true, status: res.status };
  } catch {
    return { alive: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A POST whose response must START within `responseStartTimeoutMs` (headers
 * observed). The wedge signature — connection accepted, zero bytes, CPU spin
 * — outlives any per-attempt ceiling, so the ceiling must fire before the
 * client's patience. The abort is surfaced as a typed error (not a bare
 * AbortError) so callers can distinguish "give up on this node" from "the
 * caller cancelled the whole request".
 */
export class ResponseStartTimeoutError extends Error {
  constructor(node: string) {
    super(`No response from ${node} within the node budget`);
    this.name = "ResponseStartTimeoutError";
  }
}

export async function fetchWithResponseStartTimeout(
  url: string,
  init: RequestInit,
  responseStartTimeoutMs: number,
  node: string
): Promise<Response> {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, responseStartTimeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (fired) throw new ResponseStartTimeoutError(node);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read-ahead probe for a 2xx transcription response. A wedged node can still
 * accept the connection and stream ZERO body bytes — the headers arrive, the
 * body never does. For small responses (a transcript of 10 min of audio is
 * well under this cap) we consume the body up-front so the caller can hand a
 * fully-buffered response back: if the stream stalls, this await throws and
 * the node is treated as failed. Large responses keep the legacy stream
 * pass-through — buffering multi-MB transcripts is not worth the trade.
 */
export async function readAudioResponseWithinTimeout(
  res: Response,
  responseStartTimeoutMs: number,
  node: string,
  maxBufferBytes = 262_144
): Promise<Response> {
  const lengthHeader = Number(res.headers.get("content-length"));
  const sizeKnown = Number.isFinite(lengthHeader);
  if (
    !res.ok ||
    (!sizeKnown && lengthHeader !== 0) ||
    (sizeKnown && lengthHeader > maxBufferBytes)
  ) {
    return res;
  }
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, responseStartTimeoutMs);
  try {
    const body = await res.arrayBuffer();
    const headers = new Headers(res.headers);
    headers.set("content-length", String(body.byteLength));
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } catch (err) {
    if (fired) throw new ResponseStartTimeoutError(node);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
