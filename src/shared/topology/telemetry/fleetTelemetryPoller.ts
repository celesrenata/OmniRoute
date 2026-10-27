/**
 * Client-side fleet-telemetry poller core (OR-ATOM-005 / Step 5, T5.3).
 *
 * Pure TS: no React, no `window`, no module-level `fetch` capture. The
 * React hook (`useFleetTelemetry.ts`) wires this core to the
 * visibility-gated home section and aborts it on hidden / unmount /
 * mode-switch; this module is what the tests exercise directly.
 *
 * Contract (task T5.3):
 * - Poll ONE bounded snapshot per cycle (`GET /api/telemetry/fleet`) —
 *   never N requests per GPU. The endpoint is management-authenticated on
 *   the server side; the client carries no credentials (session cookie /
 *   session header handled by the fetcher).
 * - Modest UI cadence (`intervalMs`, default 3.5 s, in the 2–5 s band): the
 *   feed must not update more frequently than the source ingests.
 * - Coalesce in-flight fetches: a tick that fires while a request is still
 *   in flight skips that tick rather than stacking requests.
 * - `stale` is derived from the response's own `capturedAt` vs the clock at
 *   the moment the response landed (age > `staleWindowMs` → stale). A stale
 *   reconciliation is still carried (the renderer shows a stale fact),
 *   unlike `errored` (no usable data → `reconciliation: null`).
 * - Auth failures (401/403) are terminal for the poller: `errored` with
 *   `errorCode 401`/`403`; the loop stops for good (no retry storm), and a
 *   later `start()` does not revive the terminal state. Other HTTP errors
 *   (408/5xx) keep the last good reconciliation (if any) and keep polling.
 * - `abort()` stops the cycle: clears the pending tick, aborts the in-flight
 *   request (AbortController), and preserves the carried state. It is
 *   idempotent and NON-permanent — a later `start()` revives the same
 *   instance. That is what makes the hook's memoized poller StrictMode-safe
 *   (React dev double-invoke: the first effect run's cleanup aborts
 *   mid-fetch, the second run's `start()` must resume, not no-op).
 */
import type {
  ReconciledGpuNode,
  ReconciledProviderNode,
  ReconciledRuntimeNode,
  ReconciliationEdge,
} from "./reconcile";

/** The reconciliation block of `GET /api/telemetry/fleet` (additive). */
export interface FleetTelemetryReconciliation {
  schemaVersion: 1;
  capturedAt: number;
  gpuNodes: ReconciledGpuNode[];
  runtimeNodes: ReconciledRuntimeNode[];
  providerNodes: ReconciledProviderNode[];
  edges: ReconciliationEdge[];
  providerCentricFallback: boolean;
}

/** The response body the poller consumes. */
export interface FleetTelemetryResponse {
  snapshot: {
    capturedAt: number;
    [key: string]: unknown;
  };
  reconciliation: FleetTelemetryReconciliation;
}

/** A minimal fetch-like callable the poller drives (injectable for tests). */
export type FleetTelemetryFetcher = (
  url: string,
  init: { signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Poller state — what the hook reports to the renderer. */
export interface FleetTelemetryState {
  /** `waiting` before the first successful response; `errored` after a terminal failure. */
  status: "waiting" | "available" | "errored";
  /** True when the carried reconciliation's `capturedAt` was older than `staleWindowMs`. */
  stale: boolean;
  /** The carried reconciliation, or `null` while waiting / after terminal error. */
  reconciliation: FleetTelemetryReconciliation | null;
  /** Epoch ms of the carried reconciliation's capture (undefined while waiting). */
  capturedAt?: number;
  /** GPU count from the carried reconciliation (undefined while waiting). */
  gpuCount?: number;
  /** HTTP status that put the poller in `errored` (absent otherwise). */
  errorCode?: number;
}

export interface FleetTelemetryPollerOptions {
  /** The endpoint to poll. Default `/api/telemetry/fleet`. */
  url?: string;
  /** The fetch to use (injectable for tests). Defaults to global `fetch`. */
  fetcher?: FleetTelemetryFetcher;
  /** UI cadence in ms. Default 3500 (the task's 2–5 s band). */
  intervalMs?: number;
  /** Age (ms) at which a response's own `capturedAt` is reported as stale. Default 10000. */
  staleWindowMs?: number;
  /** Clock (injectable for tests). Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_URL = "/api/telemetry/fleet";
const DEFAULT_INTERVAL_MS = 3500;
const DEFAULT_STALE_WINDOW_MS = 10_000;

/** Terminal auth failures: retrying cannot help. */
function isTerminalAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * The bounded polling loop. Constructed by the hook; `start()` runs the
 * first fetch immediately, then schedules `intervalMs` ticks. One in-flight
 * fetch at a time (coalesced). `abort()` stops the cycle (non-permanent); a
 * later `start()` revives the same instance — idempotent and StrictMode-
 * safe. A terminal auth failure is the one state `start()` will not revive.
 */
export class FleetTelemetryPoller {
  private readonly url: string;
  private readonly fetcher: FleetTelemetryFetcher;
  private readonly intervalMs: number;
  private readonly staleWindowMs: number;
  private readonly now: () => number;

  private state: FleetTelemetryState = { status: "waiting", stale: false, reconciliation: null };
  private listeners = new Set<(s: FleetTelemetryState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private running = false;

  constructor(options: FleetTelemetryPollerOptions = {}) {
    this.url = options.url ?? DEFAULT_URL;
    this.fetcher =
      options.fetcher ??
      ((url, init) =>
        fetch(url, init) as Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>);
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.staleWindowMs = options.staleWindowMs ?? DEFAULT_STALE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onState(listener: (s: FleetTelemetryState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current state snapshot (stable shape — the hook renders from this). */
  getState(): FleetTelemetryState {
    return this.state;
  }

  /**
   * Start polling. Idempotent: a no-op while already running. Revives a
   * stopped poller (see `abort()`), except after a terminal auth failure —
   * the `errored` state persists by design (retrying cannot help).
   */
  start(): void {
    if (this.running) return;
    if (this.state.status === "errored") return;
    this.running = true;
    void this.runCycle();
  }

  /**
   * Stop polling: clear the pending tick, abort the in-flight request, and
   * stop the cycle. Idempotent and NON-permanent — a later `start()`
   * revives the same instance. The carried state is preserved (only the
   * React hook resets to `waiting`).
   */
  abort(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      this.inFlight.abort();
      this.inFlight = null;
    }
  }

  private setState(next: FleetTelemetryState): void {
    this.state = next;
    for (const listener of [...this.listeners]) {
      listener(next);
    }
  }

  private runCycle(): void {
    if (!this.running) return;
    // Coalesce: a tick that lands while a fetch is in flight skips this tick
    // (the in-flight response decides the next state).
    if (this.inFlight) {
      this.scheduleNext();
      return;
    }

    const controller = new AbortController();
    this.inFlight = controller;

    this.fetcher(this.url, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted || !this.running) return;
        if (isTerminalAuthStatus(res.status)) {
          // Terminal: retrying cannot help. Record the failure and stop the
          // loop for good — the `errored` state persists (a later `start()`
          // will not revive it), and no further tick is scheduled.
          this.running = false;
          this.setState({
            status: "errored",
            stale: false,
            reconciliation: null,
            errorCode: res.status,
          });
          return;
        }
        if (!res.ok) {
          // Transient (408/5xx): keep the last good reconciliation (or the
          // waiting state) and keep polling — never surface garbage.
          if (this.state.status === "waiting") {
            this.setState({ status: "waiting", stale: false, reconciliation: null });
          }
          return;
        }
        return res.json().then((body) => {
          if (controller.signal.aborted || !this.running) return;
          this.applyResponse(body);
        });
      })
      .catch(() => {
        // Aborted (or network error): waiting/last-good state is preserved.
      })
      .finally(() => {
        if (this.inFlight === controller) {
          this.inFlight = null;
          // Only the owning cycle schedules the next tick — a cycle that was
          // superseded (aborted mid-flight, or terminal) must not schedule.
          this.scheduleNext();
        }
      });
  }

  private applyResponse(body: unknown): void {
    if (!isFleetTelemetryResponse(body)) {
      // Malformed body: treat like a transient failure (state preserved).
      return;
    }
    const reconciliation = body.reconciliation;
    const ageMs = this.now() - reconciliation.capturedAt;
    const stale = ageMs > this.staleWindowMs;
    this.setState({
      status: "available",
      stale,
      reconciliation,
      capturedAt: reconciliation.capturedAt,
      gpuCount: reconciliation.gpuNodes.length,
    });
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle();
    }, this.intervalMs);
  }
}

/** Structural validation of the fleet endpoint body (no raw fields are trusted). */
function isFleetTelemetryResponse(body: unknown): body is FleetTelemetryResponse {
  if (typeof body !== "object" || body === null) return false;
  const snapshot = (body as Record<string, unknown>).snapshot;
  const reconciliation = (body as Record<string, unknown>).reconciliation;
  if (typeof snapshot !== "object" || snapshot === null) return false;
  if (typeof (snapshot as Record<string, unknown>).capturedAt !== "number") return false;
  if (typeof reconciliation !== "object" || reconciliation === null) return false;
  const rec = reconciliation as Record<string, unknown>;
  if (rec.schemaVersion !== 1) return false;
  if (typeof rec.capturedAt !== "number") return false;
  if (!Array.isArray(rec.gpuNodes)) return false;
  if (!Array.isArray(rec.edges)) return false;
  return true;
}
