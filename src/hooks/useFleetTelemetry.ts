/**
 * useFleetTelemetry — browser-side consumer for the M2 fleet telemetry gateway.
 *
 * Polls `GET /api/telemetry/fleet` (the ONE management-authenticated,
 * server-side bounded snapshot endpoint) and exposes a normalized
 * `FleetTelemetrySnapshot` to the Atomic Topology UI. This is the "consumer"
 * half of the T005/M2 pairing: the server owns the query, the OmniRoute-native
 * adapter, and the merged snapshot shape; this hook only turns it into React
 * state and keeps it fresh on a bounded cadence.
 *
 * Deliberate non-goals (kept server-side by design, see
 * `src/app/api/telemetry/fleet/route.ts`):
 *   - NO browser fan-out to hosts/GPUs, NO per-atom queries — one request,
 *     always.
 *   - NO raw `err.message` surfaced; the route already routes errors through
 *     `buildErrorBody`, and the hook only keeps a stable, sanitized status
 *     string (hard rule #12).
 *
 * Auth: the route gates on `requireManagementAuth`, which the logged-in
 * dashboard satisfies via its session cookie. The hook therefore performs a
 * plain same-origin fetch (credentials ride the session) — no API key, no token
 * plumbing. A 401/403 is treated as terminal for the polling loop (retrying
 * cannot fix a missing/unscoped session), while transient 5xx / network errors
 * keep the loop alive.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { FleetTelemetrySnapshot } from "@/shared/topology/telemetry/types";

export type FleetTelemetryStatus = "idle" | "loading" | "ready" | "error" | "auth-error";

export interface UseFleetTelemetryOptions {
  /** When false the hook neither fetches nor polls (e.g. tab hidden). */
  enabled?: boolean;
  /**
   * Observation window in ms, forwarded to the gateway as `windowMs`. When
   * omitted the gateway applies its own default window.
   */
  windowMs?: number;
  /** Backend/provider ids to filter on (maps to the `providers` param). */
  providerIds?: string[];
  /** Host ids to filter on (maps to the `hosts` param). */
  hostIds?: string[];
  /** GPU ids to filter on (maps to the `gpus` param). */
  gpuIds?: string[];
  /** Poll cadence. Defaults to 15s. */
  pollIntervalMs?: number;
  /** Endpoint path. Defaults to the fleet gateway route. */
  endpoint?: string;
}

export interface UseFleetTelemetryResult {
  status: FleetTelemetryStatus;
  /** The latest accepted snapshot, or null before the first good response. */
  snapshot: FleetTelemetrySnapshot | null;
  /** Client clock (ms) of the last accepted snapshot, for "Xs ago" display. */
  lastReceivedAt: number | null;
  /** Stable, sanitized error text (never an upstream stack/message). */
  error: string | null;
  /** Imperatively re-fetch now (returns the resolved status). */
  refetch: () => Promise<FleetTelemetryStatus>;
}

const DEFAULT_ENDPOINT = "/api/telemetry/fleet";
const DEFAULT_POLL_MS = 15_000;
/** The gateway contract version this consumer understands (types.ts → 1). */
const SUPPORTED_SCHEMA_VERSION = 1;

/** Build the query string for the gateway. Omitted fields are left off. */
function buildQueryUrl(endpoint: string, ids: UseFleetTelemetryOptions): string {
  const params = new URLSearchParams();
  if (ids.windowMs && Number.isFinite(ids.windowMs) && ids.windowMs > 0) {
    params.set("windowMs", String(ids.windowMs));
  }
  if (ids.providerIds && ids.providerIds.length > 0) {
    params.set("providers", ids.providerIds.join(","));
  }
  if (ids.hostIds && ids.hostIds.length > 0) params.set("hosts", ids.hostIds.join(","));
  if (ids.gpuIds && ids.gpuIds.length > 0) params.set("gpus", ids.gpuIds.join(","));
  const qs = params.toString();
  return qs ? `${endpoint}?${qs}` : endpoint;
}

/**
 * A response is only accepted if it decodes to a well-formed snapshot of the
 * supported schema version. Anything else is a transient/unknown failure, not
 * data — returning null lets the caller keep the previous snapshot alive.
 */
function toSnapshot(body: unknown): FleetTelemetrySnapshot | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Record<string, unknown>;
  if (candidate.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return null;
  if (!Array.isArray(candidate.resources)) return null;
  if (typeof candidate.capturedAt !== "number") return null;
  return candidate as unknown as FleetTelemetrySnapshot;
}

export function useFleetTelemetry(options: UseFleetTelemetryOptions = {}): UseFleetTelemetryResult {
  const {
    enabled = true,
    windowMs,
    providerIds,
    hostIds,
    gpuIds,
    pollIntervalMs = DEFAULT_POLL_MS,
    endpoint = DEFAULT_ENDPOINT,
  } = options;

  const [status, setStatus] = useState<FleetTelemetryStatus>("idle");
  const [snapshot, setSnapshot] = useState<FleetTelemetrySnapshot | null>(null);
  const [lastReceivedAt, setLastReceivedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Latest options in a ref, synced in an effect (not during render) so the
  // stable `doFetch` reads fresh values without re-subscribing the poll effect on
  // every change.
  const requestRef = useRef<UseFleetTelemetryOptions>({
    windowMs,
    providerIds,
    hostIds,
    gpuIds,
    endpoint,
  });

  // The in-flight request, if any. "In flight" is `activeRef.current !== null`,
  // so a single ref tracks both liveness and the AbortController — no boolean to
  // keep in sync. The finally only clears it on identity match, so an aborted
  // (superseded) request cannot clobber the one that replaced it.
  const activeRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the options ref current outside of render. Runs after every render, so
  // the first poll (issued from the mount effect below, which runs later in the
  // same commit) already sees the current values.
  useEffect(() => {
    requestRef.current = { windowMs, providerIds, hostIds, gpuIds, endpoint };
  }, [windowMs, providerIds, hostIds, gpuIds, endpoint]);

  const doFetch = useCallback(async (): Promise<FleetTelemetryStatus> => {
    // A request is already in flight; its outcome settles the state. Report the
    // in-flight status rather than starting a duplicate (no overlap).
    if (activeRef.current) return "loading";

    const req = requestRef.current;
    const url = buildQueryUrl(req.endpoint, req);

    setStatus((prev) => (prev === "ready" ? "ready" : "loading"));
    const controller = new AbortController();
    activeRef.current = controller;

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        // Same-origin dashboard: the session cookie carries management auth.
        credentials: "same-origin",
      });

      if (res.status === 401 || res.status === 403) {
        // Terminal for this session — retrying cannot fix a missing/unscoped
        // session, so the polling loop halts.
        setStatus("auth-error");
        setError(
          res.status === 401
            ? "Not authenticated for fleet telemetry"
            : "Missing management scope for fleet telemetry"
        );
        return "auth-error";
      }

      if (!res.ok) {
        // Sanitized, stable message — the response body is never surfaced raw.
        setStatus("error");
        setError(`Fleet telemetry request failed (HTTP ${res.status})`);
        return "error";
      }

      const body: unknown = await res.json();
      const accepted = toSnapshot(body);
      if (!accepted) {
        setStatus("error");
        setError("Fleet telemetry response did not match the expected snapshot shape");
        return "error";
      }

      setSnapshot(accepted);
      setLastReceivedAt(Date.now());
      setError(null);
      setStatus("ready");
      return "ready";
    } catch (err) {
      // Aborts mean "we moved on" — not an error to surface, and the state was
      // never touched, so report the current (pre-fetch) idle state.
      if (err instanceof DOMException && err.name === "AbortError") {
        return "idle";
      }
      setStatus("error");
      setError("Fleet telemetry request failed (network)");
      return "error";
    } finally {
      // Identity match only: a superseded (aborted) request must not clear the
      // controller that replaced it.
      if (activeRef.current === controller) activeRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;

    const schedule = (delay: number) => {
      if (disposed) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void doFetch().then((result) => {
          // Stop the loop only on a terminal auth error; transient failures keep
          // it alive so a recovering backend re-hydrates the snapshot.
          if (result !== "auth-error") schedule(pollIntervalMs);
        });
      }, delay);
    };

    // First fetch at 0ms (a separate task, so no synchronous setState in the
    // effect body), then a bounded cadence.
    schedule(0);

    return () => {
      disposed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      activeRef.current?.abort();
      activeRef.current = null;
    };
  }, [enabled, pollIntervalMs, doFetch]);

  const refetch = useCallback(async (): Promise<FleetTelemetryStatus> => {
    if (!enabled) return "idle";
    return doFetch();
  }, [doFetch, enabled]);

  return { status, snapshot, lastReceivedAt, error, refetch };
}
