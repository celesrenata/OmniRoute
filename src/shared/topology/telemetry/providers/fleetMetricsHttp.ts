/**
 * Fleet telemetry — SSRF-safe HTTP layer for external metrics adapters
 * (OR-ATOM-005 / Step 5).
 *
 * Every request goes through `fleetMetricsFetch`, which:
 *   - resolves the full URL from a version-controlled base URL + a fixed path
 *     (no user-defined URLs),
 *   - re-validates the URL at request time (defense in depth on top of the
 *     config-time check): http/https only, no redirects (a redirect to a
 *     foreign host is an SSRF), host + port allowlists,
 *   - attaches the bearer token in-memory only — it is never put in a URL
 *     query string, never logged, and never returned in a response,
 *   - respects the caller's AbortSignal (the gateway's per-provider timeout
 *     drives cancellation).
 *
 * `fetchImpl` is injectable so unit tests exercise the whole path with a mock
 * HTTP layer and no real network.
 */

import { type FleetMetricsConfig, isHostAllowed, isPortAllowed } from "../fleetMetricsConfig";

/** Minimal fetch shape (the global fetch satisfies it). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class FleetMetricsHttpError extends Error {
  constructor(
    message: string,
    readonly category: "ssrf" | "timeout" | "network" | "http" | "malformed" | "aborted"
  ) {
    super(message);
    this.name = "FleetMetricsHttpError";
  }
}

export interface FleetMetricsFetchOptions {
  /** Validated base URL (no trailing slash required). */
  baseUrl: string;
  /** Fixed, version-controlled request path (never user-defined). */
  path: string;
  method: "GET" | "POST";
  config: FleetMetricsConfig;
  /** Backend kind, used for the default port allowlist. */
  kind: "prometheus" | "influxdb2" | "grafana";
  /** Injectable fetch (tests pass a mock). */
  fetchImpl?: FetchLike;
  /** Per-request headers (never includes the token — that is added here). */
  headers?: Record<string, string>;
  /** Request body for POST (already serialized). */
  body?: string | null;
  signal?: AbortSignal;
}

/**
 * Validate a URL against the SSRF guards. Returns the URL when safe, or
 * throws a `FleetMetricsHttpError` (category "ssrf") otherwise. This is the
 * single chokepoint for URL safety — adapters must route every request through
 * it via `fleetMetricsFetch`.
 */
export function assertSafeUrl(
  baseUrl: string,
  path: string,
  kind: "prometheus" | "influxdb2" | "grafana",
  config: FleetMetricsConfig
): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new FleetMetricsHttpError("invalid base URL", "ssrf");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new FleetMetricsHttpError(
      `disallowed protocol for metrics source: ${base.protocol}`,
      "ssrf"
    );
  }
  // Reject non-http(s) schemes that slipped past the string check.
  if (!/^(?:https?):$/i.test(base.protocol)) {
    throw new FleetMetricsHttpError("disallowed protocol", "ssrf");
  }
  if (!isHostAllowed(base, config)) {
    throw new FleetMetricsHttpError("host not on allowlist", "ssrf");
  }
  if (!isPortAllowed(base, kind, config)) {
    throw new FleetMetricsHttpError("port not on allowlist", "ssrf");
  }
  // The path is a fixed, version-controlled value; build the full URL from it.
  let full: URL;
  try {
    full = new URL(path, base);
  } catch {
    throw new FleetMetricsHttpError("invalid request path", "ssrf");
  }
  // A path must not change the host/protocol (e.g. a `//evil` path).
  if (full.host !== base.host || full.protocol !== base.protocol) {
    throw new FleetMetricsHttpError("path escapes base host", "ssrf");
  }
  return full;
}

/**
 * Perform one bounded, SSRF-checked request. The bearer token (if any) is
 * attached as an `Authorization: Bearer <token>` header — never in the URL —
 * and the token value is never logged or echoed. Network failures throw a
 * `FleetMetricsHttpError`; the caller maps that to "source unavailable".
 */
export async function fleetMetricsFetch(opts: FleetMetricsFetchOptions): Promise<Response> {
  const full = assertSafeUrl(opts.baseUrl, opts.path, opts.kind, opts.config);
  const fetchImpl: FetchLike = opts.fetchImpl ?? globalThis.fetch;

  const headers: Record<string, string> = {
    ...(opts.headers ?? {}),
  };
  if (opts.body != null && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  if (opts.config.token) {
    headers["Authorization"] = `Bearer ${opts.config.token}`;
  }

  let res: Response;
  try {
    res = await fetchImpl(full.toString(), {
      method: opts.method,
      headers,
      body: opts.body ?? null,
      signal: opts.signal,
      redirect: "error", // a redirect to a foreign host is an SSRF — reject.
    });
  } catch (err) {
    if (opts.signal?.aborted) {
      throw new FleetMetricsHttpError("aborted", "aborted");
    }
    if (err instanceof FleetMetricsHttpError) throw err;
    const name = err instanceof Error ? err.name : "unknown";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new FleetMetricsHttpError("request timed out", "timeout");
    }
    throw new FleetMetricsHttpError("network error", "network");
  }
  return res;
}

/**
 * Read a response body as JSON, catching malformed payloads. Returns the
 * parsed object or throws a `FleetMetricsHttpError` (category "malformed").
 * The raw body is never logged.
 */
export async function readJson<T>(res: Response): Promise<T> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new FleetMetricsHttpError("failed to read body", "network");
  }
  if (text.length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FleetMetricsHttpError("malformed JSON response", "malformed");
  }
}

/**
 * Build an auth-denied / http-error `FleetMetricsHttpError` from a non-2xx
 * response. 401/403 → the source is "unavailable" (never a fatal error).
 */
export function httpStatusError(res: Response): FleetMetricsHttpError {
  if (res.status === 401 || res.status === 403) {
    return new FleetMetricsHttpError(`auth denied (${res.status})`, "http");
  }
  if (res.status >= 500) {
    return new FleetMetricsHttpError(`upstream error (${res.status})`, "http");
  }
  return new FleetMetricsHttpError(`unexpected status (${res.status})`, "http");
}
