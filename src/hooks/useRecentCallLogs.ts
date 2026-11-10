"use client";
import { useCallback, useSyncExternalStore } from "react";
import {
  EMPTY_CALL_LOGS,
  getCallLogsServerSnapshot,
  getCallLogsSnapshot,
  subscribeCallLogs,
  type CallLogsSnapshot,
} from "@/shared/topology/telemetry/recentCallLogs";

const noopSubscribe = () => () => {};

/**
 * Recent call-log rows from the single shared poll. While `enabled` is false
 * the hook does not subscribe (so it never keeps the poller alive) and
 * returns the empty snapshot.
 */
export function useRecentCallLogs(enabled: boolean): CallLogsSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? subscribeCallLogs(listener) : noopSubscribe()),
    [enabled]
  );
  const getSnapshot = useCallback(
    () => (enabled ? getCallLogsSnapshot() : EMPTY_CALL_LOGS),
    [enabled]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getCallLogsServerSnapshot);
}
