/**
 * Shared call-log store: one poll for any number of subscribers, stopped by
 * the last unsubscribe, paused while the tab is hidden, no connection-test rows.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  CALL_LOG_POLL_INTERVAL_MS,
  callLogSubscriberCount,
  getCallLogsSnapshot,
  subscribeCallLogs,
} from "../../../src/shared/topology/telemetry/recentCallLogs";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function installFetch(rows: unknown[]) {
  const urls: string[] = [];
  const signals: AbortSignal[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (init?.signal) signals.push(init.signal);
    return { ok: true, json: async () => rows } as Response;
  }) as typeof fetch;
  return { urls, signals };
}

function setVisibility(state: "visible" | "hidden") {
  (globalThis as { document?: unknown }).document = { visibilityState: state };
}

test("two subscribers share one fetch per tick; last unsubscribe stops polling", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  setVisibility("visible");
  const rows = [
    { id: "a", provider: "openai", model: "gpt-4o", status: 200 },
    { id: "t", provider: "openai", model: "connection-test", status: 200 },
  ];
  const calls = installFetch(rows);
  try {
    const unsubA = subscribeCallLogs(() => {});
    const unsubB = subscribeCallLogs(() => {});
    assert.equal(callLogSubscriberCount(), 2);
    await flush();
    assert.equal(calls.urls.length, 1, "second subscriber must not start a second poll");
    assert.equal(calls.urls[0], "/api/usage/call-logs?limit=60&excludeTests=1");
    const snap = getCallLogsSnapshot();
    assert.equal(snap.loaded, true);
    assert.deepEqual(
      snap.rows.map((r) => r.id),
      ["a"],
      "connection-test rows are filtered"
    );

    mock.timers.tick(CALL_LOG_POLL_INTERVAL_MS);
    await flush();
    assert.equal(calls.urls.length, 2, "one fetch per tick regardless of subscriber count");

    unsubA();
    mock.timers.tick(CALL_LOG_POLL_INTERVAL_MS);
    await flush();
    assert.equal(calls.urls.length, 3, "still polling while one subscriber remains");

    unsubB();
    assert.equal(callLogSubscriberCount(), 0);
    mock.timers.tick(CALL_LOG_POLL_INTERVAL_MS * 3);
    await flush();
    assert.equal(calls.urls.length, 3, "no polling after the last unsubscribe");
    assert.equal(getCallLogsSnapshot().loaded, false, "snapshot reset on stop");
  } finally {
    mock.timers.reset();
  }
});

test("hidden tab pauses fetching and resumes when visible again", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  setVisibility("hidden");
  const calls = installFetch([]);
  try {
    const unsub = subscribeCallLogs(() => {});
    await flush();
    assert.equal(calls.urls.length, 0, "hidden tab does not fetch");
    mock.timers.tick(CALL_LOG_POLL_INTERVAL_MS);
    await flush();
    assert.equal(calls.urls.length, 0);
    setVisibility("visible");
    mock.timers.tick(CALL_LOG_POLL_INTERVAL_MS);
    await flush();
    assert.equal(calls.urls.length, 1, "resumes on the next tick once visible");
    unsub();
  } finally {
    mock.timers.reset();
  }
});

test("unsubscribe aborts an in-flight request", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  setVisibility("visible");
  const signals: AbortSignal[] = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise(() => {});
  }) as typeof fetch;
  try {
    const unsub = subscribeCallLogs(() => {});
    await flush();
    assert.equal(signals.length, 1);
    unsub();
    assert.equal(signals[0].aborted, true);
  } finally {
    mock.timers.reset();
  }
});
