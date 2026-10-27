/**
 * React hook over the fleet-telemetry poller (OR-ATOM-005 / Step 5, T5.3).
 *
 * Wires the pure {@link FleetTelemetryPoller} core to the React lifecycle of
 * the home topology section:
 * - `enabled` false → no poller is ever constructed and no request is ever
 *   sent (the section is hidden / the 2D renderer is mounted).
 * - `enabled` true  → one poller per enabled phase; the first `start()`
 *   fires immediately, then the core's `intervalMs` cadence (one bounded
 *   snapshot per cycle — never N requests per GPU).
 * - `enabled` flips to false, or the component unmounts → `abort()` cancels
 *   the in-flight fetch and stops the cycle, and the carried state is
 *   cleared (a re-enabled phase starts fresh from `waiting`).
 *
 * In-flight coalescing lives in the core (a tick that lands while a fetch is
 * in flight skips that tick), so this hook only owns the lifecycle.
 *
 * "use client" on purpose: the poller touches `fetch` / `AbortController` and
 * must never run on the server. The module itself is import-safe under SSR
 * (nothing at import time).
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import {
  FleetTelemetryPoller,
  type FleetTelemetryReconciliation,
  type FleetTelemetryState,
} from "./fleetTelemetryPoller";

export interface UseFleetTelemetryOptions {
  /** Poll only while true (section visible AND the atomic renderer is the
   * mounted renderer). `false` → no poller, no requests. */
  enabled?: boolean;
  /** The endpoint to poll. Defaults to `/api/telemetry/fleet`. */
  url?: string;
  /** UI cadence in ms (default 3500 — the task's 2–5 s band). */
  intervalMs?: number;
  /** Age (ms) at which a response is reported stale (default 10000). */
  staleWindowMs?: number;
}

export interface FleetTelemetryHookState {
  status: FleetTelemetryState["status"];
  stale: boolean;
  reconciliation: FleetTelemetryReconciliation | null;
  capturedAt?: number;
  gpuCount?: number;
  errorCode?: number;
}

/** The state while disabled / before the first response. */
const WAITING_STATE: FleetTelemetryHookState = {
  status: "waiting",
  stale: false,
  reconciliation: null,
};

/**
 * The visibility-gated fleet-telemetry feed for the Atomic topology.
 *
 * Returns a stable state object per subscription update (referential
 * stability: the hook only re-renders its consumer when the poller actually
 * reports a new state — waiting / available / errored transitions), so a
 * steady feed does not re-render the host on every cadence tick that
 * produced an unchanged value.
 */
export function useFleetTelemetry(options: UseFleetTelemetryOptions = {}): FleetTelemetryHookState {
  const enabled = options.enabled ?? false;
  const url = options.url;
  const intervalMs = options.intervalMs;
  const staleWindowMs = options.staleWindowMs;

  const [state, setState] = useState<FleetTelemetryHookState>(WAITING_STATE);

  // One poller per enabled phase (keyed on `enabled` too, so a phase that
  // starts from scratch gets a fresh instance). The poller itself is
  // StrictMode-safe: `abort()` is non-permanent, so re-using the memoized
  // instance across a StrictMode double-invoke (start -> abort -> start)
  // works; a re-enabled phase still gets a fresh poller + fresh `waiting`
  // state from the `enabled` key + the state reset in the effect cleanup.
  const poller = useMemo(
    () =>
      new FleetTelemetryPoller({
        url,
        intervalMs,
        staleWindowMs,
      }),
    // `enabled` is not read in the memo body, but keying on it is
    // intentional: a (re-)enabled phase gets a fresh poller + fresh
    // `waiting` state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, url, intervalMs, staleWindowMs]
  );

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = poller.onState((s) => {
      setState({
        status: s.status,
        stale: s.stale,
        reconciliation: s.reconciliation,
        capturedAt: s.capturedAt,
        gpuCount: s.gpuCount,
        errorCode: s.errorCode,
      });
    });
    poller.start();
    return () => {
      unsubscribe();
      // Stop the cycle and cancel the in-flight request; clear the carried
      // state so a later re-enabled phase starts fresh (no stale fact lingers
      // behind a hidden section).
      poller.abort();
      setState(WAITING_STATE);
    };
  }, [enabled, poller]);

  // The memo is keyed on `enabled` too so a re-enabled phase starts with a
  // fresh poller and fresh `waiting` state (the effect cleanup above resets
  // state; `abort()` alone is non-permanent and would otherwise keep the
  // last good fact across the hidden phase).
  return state;
}
