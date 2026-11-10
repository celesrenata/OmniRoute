/**
 * Shared, ref-counted call-log poller.
 *
 * One `GET /api/usage/call-logs?limit=60&excludeTests=1` poll (3 s,
 * visibility-gated, abortable) serves every consumer (Recent Requests table,
 * topology model adapter). No new socket and no new endpoint: the first
 * subscriber starts polling, the last unsubscribe stops it.
 */
import { isConnectionTestRow, type RecentCallLogRow } from "../domain/recentModels";

export const CALL_LOG_POLL_INTERVAL_MS = 3000;
/** Wider than any display slice so connection-test rows cannot starve it. */
export const CALL_LOG_FETCH_LIMIT = 60;

export interface CallLogsSnapshot {
  /** Newest-first rows with connection-test rows removed. */
  rows: RecentCallLogRow[];
  /** True once at least one poll succeeded. */
  loaded: boolean;
}

export const EMPTY_CALL_LOGS: CallLogsSnapshot = Object.freeze({
  rows: [] as RecentCallLogRow[],
  loaded: false,
}) as CallLogsSnapshot;

let snapshot: CallLogsSnapshot = EMPTY_CALL_LOGS;
const listeners = new Set<() => void>();
let timeoutId: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;
let running = false;

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

async function load(signal: AbortSignal): Promise<void> {
  try {
    const res = await fetch(`/api/usage/call-logs?limit=${CALL_LOG_FETCH_LIMIT}&excludeTests=1`, {
      cache: "no-store",
      signal,
    });
    if (!res.ok) return;
    const data = await res.json();
    if (signal.aborted) return;
    const rows = Array.isArray(data)
      ? (data as RecentCallLogRow[]).filter((row) => !isConnectionTestRow(row))
      : [];
    snapshot = { rows, loaded: true };
    emit();
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    if (!isAbort) console.error("Failed to load recent requests:", error);
  }
}

async function tick(): Promise<void> {
  if (!running) return;
  // Pause polling while the tab is backgrounded; resume on the next tick.
  if (isVisible()) {
    const current = new AbortController();
    controller = current;
    await load(current.signal);
    if (controller === current) controller = null;
  }
  if (running) timeoutId = setTimeout(tick, CALL_LOG_POLL_INTERVAL_MS);
}

function start(): void {
  if (running) return;
  running = true;
  void tick();
}

function stop(): void {
  running = false;
  if (timeoutId) clearTimeout(timeoutId);
  timeoutId = null;
  controller?.abort();
  controller = null;
  snapshot = EMPTY_CALL_LOGS;
}

/** `useSyncExternalStore`-compatible subscribe; ref-counts the poller. */
export function subscribeCallLogs(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function getCallLogsSnapshot(): CallLogsSnapshot {
  return snapshot;
}

export function getCallLogsServerSnapshot(): CallLogsSnapshot {
  return EMPTY_CALL_LOGS;
}

/** Test seam: number of live subscribers. */
export function callLogSubscriberCount(): number {
  return listeners.size;
}
