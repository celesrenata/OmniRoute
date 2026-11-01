/**
 * FleetTelemetryPoller — lifecycle / state-machine tests (OR-ATOM-005 / T5.7).
 *
 * Regression focus: the dev-only React StrictMode double-invoke. The hook
 * (`useFleetTelemetry.ts`) memoizes ONE poller across the effect's
 * start/cleanup/start cycle (Next.js app-router dev default). The first
 * cleanup's `abort()` used to latch a permanent `disposed` flag, so the
 * second `start()` no-opped and no fetch ever completed → state stuck
 * `waiting`. These tests pin the corrected contract:
 *
 *  - `abort()` is NON-permanent: it clears the pending tick, aborts the
 *    in-flight fetch, and stops the cycle — but a later `start()` revives
 *    the SAME instance (idempotent, StrictMode-safe).
 *  - terminal auth (401/403) is the one permanent state: `errored` +
 *    `errorCode`, `reconciliation: null`, the loop stops for good (no retry
 *    storm), and a later `start()` does NOT revive it.
 *  - transient non-ok (408/5xx) preserves the last good state and keeps
 *    polling; from `waiting` it stays `waiting`.
 *  - malformed bodies preserve the previous state.
 *
 * Deterministic: an injectable `fetcher` (every call is recorded with its
 * `AbortSignal` and held pending until the test resolves it) and an
 * injectable `now`; a fake `setTimeout`/`clearTimeout` harness drives ticks
 * without any real timers.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  FleetTelemetryPoller,
  type FleetTelemetryFetcher,
} from "../../../src/shared/topology/telemetry/fleetTelemetryPoller";

type FakeResponse = { ok: boolean; status: number; json(): Promise<unknown> };

/** A single recorded fetch call (the signal the poller passed in). */
interface FetchCall {
  url: string;
  signal: AbortSignal;
}

interface Deferred {
  signal: AbortSignal;
  resolve: (r: FakeResponse) => void;
  reject: (e: Error) => void;
}

/**
 * Build an injectable fetcher. EVERY call is held pending (deferred) until
 * the test resolves it, giving full deterministic control of the request
 * lifecycle. `resolveLive(status, body)` resolves the most-recent NON-aborted
 * fetch (the one the poller is actually waiting on).
 */
function makeFetcher() {
  const calls: FetchCall[] = [];
  const deferred: Deferred[] = [];

  const fetcher: FleetTelemetryFetcher = (url, init) => {
    calls.push({ url, signal: init.signal });
    return new Promise<FakeResponse>((resolve, reject) => {
      const entry: Deferred = { signal: init.signal, resolve, reject };
      deferred.push(entry);
      init.signal.addEventListener(
        "abort",
        () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        },
        { once: true }
      );
    });
  };

  return {
    fetcher,
    calls,
    /** Number of fetches the poller has ever issued. */
    get count() {
      return calls.length;
    },
    /**
     * Resolve the most-recent live (non-aborted) fetch with a response.
     * Aborted fetches are left to reject via their abort listener.
     */
    resolveLive(status: number, body: unknown) {
      for (let i = deferred.length - 1; i >= 0; i--) {
        if (!deferred[i].signal.aborted) {
          const d = deferred[i];
          deferred.splice(i, 1);
          d.resolve({
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(body),
          });
          return;
        }
      }
      throw new Error("no live deferred fetch to resolve");
    },
  };
}

/** A body that passes the poller's structural validator. */
function validBody(capturedAt: number, gpuCount = 1) {
  const gpuNodes = Array.from({ length: gpuCount }, (_, i) => ({
    resourceId: `gpu:${i}`,
    hostId: "host-1",
    deviceUuid: `uuid-${i}`,
    stale: false,
  }));
  return {
    snapshot: { capturedAt },
    reconciliation: {
      schemaVersion: 1,
      capturedAt,
      gpuNodes,
      runtimeNodes: [],
      providerNodes: [],
      edges: [],
      providerCentricFallback: false,
    },
  };
}

/** Drain the microtask queue a few macrotask hops (no real timers needed). */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

/**
 * Replace global `setTimeout`/`clearTimeout` with a deterministic harness so
 * we can fire the poller's `intervalMs` ticks by hand (no real timers).
 */
function installFakeTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const timers = new Map<number, { fn: () => void }>();
  let idSeq = 1;

  const setFake = (fn: (...args: unknown[]) => void, _ms?: number) => {
    const id = idSeq++;
    timers.set(id, { fn: fn as () => void });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearFake = (id: number) => {
    timers.delete(id as unknown as number);
  };

  globalThis.setTimeout = setFake as unknown as typeof setTimeout;
  globalThis.clearTimeout = clearFake as unknown as typeof clearTimeout;

  return {
    /** Fire the next pending tick (FIFO). No-op when none are pending. */
    fireOne() {
      const ids = [...timers.keys()].sort((a, b) => a - b);
      if (ids.length === 0) return;
      const id = ids[0];
      const t = timers.get(id);
      timers.delete(id);
      t?.fn();
    },
    /** Number of ticks currently scheduled. */
    pending() {
      return timers.size;
    },
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
      timers.clear();
    },
  };
}

interface PollerOpts {
  now?: () => number;
  staleWindowMs?: number;
}

function makePoller(fetcher: FleetTelemetryFetcher, opts: PollerOpts = {}) {
  return new FleetTelemetryPoller({
    url: "/api/telemetry/fleet",
    intervalMs: 3500,
    staleWindowMs: opts.staleWindowMs ?? 10_000,
    now: opts.now ?? (() => 100_000),
    fetcher,
  });
}

test("start() fires immediately; a valid response lands in `available` with reconciliation facts", async () => {
  const timers = installFakeTimers();
  const clock = { t: 100_000 };
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher, { now: () => clock.t });
    assert.equal(p.getState().status, "waiting", "starts in `waiting`");

    p.start();
    assert.equal(f.count, 1, "the first fetch is issued synchronously on start()");

    f.resolveLive(200, validBody(100_000));
    await settle();

    const s = p.getState();
    assert.equal(s.status, "available");
    assert.equal(s.stale, false, "capturedAt == now → fresh");
    assert.equal(s.reconciliation?.gpuNodes.length, 1);
    assert.equal(s.capturedAt, 100_000);
    assert.equal(s.gpuCount, 1);
  } finally {
    timers.restore();
  }
});

test("stale is derived from the response capturedAt age vs staleWindowMs", async () => {
  const timers = installFakeTimers();
  const clock = { t: 100_000 };
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher, { now: () => clock.t, staleWindowMs: 10_000 });
    p.start();
    // capturedAt is 20_000 ms old (> 10_000 window) → stale.
    f.resolveLive(200, validBody(80_000));
    await settle();
    const s = p.getState();
    assert.equal(s.status, "available");
    assert.equal(s.stale, true, "age > staleWindowMs → stale");
    assert.equal(s.reconciliation !== null, true, "stale reconciliation is still carried");
  } finally {
    timers.restore();
  }
});

test("start() while already running does not stack a second in-flight fetch", async () => {
  const timers = installFakeTimers();
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher);
    p.start();
    assert.equal(f.count, 1);
    p.start();
    p.start();
    assert.equal(f.count, 1, "extra start() while running issues no additional fetch");
    assert.equal(p.getState().status, "waiting", "still waiting (first fetch in flight)");
  } finally {
    timers.restore();
  }
});

test("StrictMode: start() → abort() mid-fetch → start() again revives and reaches `available`", async () => {
  const timers = installFakeTimers();
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher);

    // effect run 1
    p.start();
    assert.equal(f.count, 1, "run 1 issued its first fetch");

    // effect run 1 cleanup: abort mid-first-fetch
    p.abort();
    assert.equal(f.calls[0].signal.aborted, true, "the first in-flight fetch was aborted");

    // effect run 2 — the SAME instance must revive
    p.start();
    assert.equal(f.count, 2, "a fresh fetch is issued after abort()+start() (not a no-op)");

    // the live (second) fetch completes
    f.resolveLive(200, validBody(100_000));
    await settle();

    const s = p.getState();
    assert.equal(s.status, "available", "the revived poller reaches `available`");
    assert.equal(s.gpuCount, 1);
  } finally {
    timers.restore();
  }
});

test("abort() is idempotent and start() after a double abort() still revives", async () => {
  const timers = installFakeTimers();
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher);
    p.start();
    assert.equal(f.count, 1);

    p.abort();
    p.abort(); // idempotent — no throw, no new fetch
    assert.equal(f.count, 1, "double abort() does not issue extra fetches");

    p.start(); // must still revive
    assert.equal(f.count, 2, "start() after double abort() revives the poller");

    f.resolveLive(200, validBody(100_000));
    await settle();
    assert.equal(p.getState().status, "available");
  } finally {
    timers.restore();
  }
});

test("abort() does not wipe already-carried state (the hook owns the reset)", async () => {
  const timers = installFakeTimers();
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher);
    p.start();
    f.resolveLive(200, validBody(100_000));
    await settle();
    assert.equal(p.getState().status, "available");

    p.abort();
    // The poller itself preserves carried state on abort(); only the React
    // hook resets to `waiting`. This is what makes the instance reusable.
    assert.equal(p.getState().status, "available", "abort() preserves the last good state");
    assert.equal(p.getState().gpuCount, 1);
  } finally {
    timers.restore();
  }
});

test("terminal auth (401) → `errored`; persists across abort()+start(); no retry storm", async () => {
  const timers = installFakeTimers();
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher);
    p.start();
    f.resolveLive(401, { error: "unauthorized" });
    await settle();

    let s = p.getState();
    assert.equal(s.status, "errored");
    assert.equal(s.errorCode, 401);
    assert.equal(s.reconciliation, null, "no usable data after terminal error");
    assert.equal(f.count, 1, "exactly one fetch for the terminal cycle");
    assert.equal(timers.pending(), 0, "no further tick scheduled after a terminal auth");

    // terminal state persists across a lifecycle re-entry
    p.abort();
    p.start();
    s = p.getState();
    assert.equal(s.status, "errored", "terminal state persists (NOT reset to waiting)");
    assert.equal(s.errorCode, 401, "errorCode intact");
    assert.equal(f.count, 1, "no retry storm — start() after terminal does not refetch");
  } finally {
    timers.restore();
  }
});

test("terminal auth (403) → `errored` with errorCode 403 and no further polling", async () => {
  const timers = installFakeTimers();
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher);
    p.start();
    f.resolveLive(403, { error: "forbidden" });
    await settle();
    const s = p.getState();
    assert.equal(s.status, "errored");
    assert.equal(s.errorCode, 403);
    assert.equal(s.reconciliation, null);
    assert.equal(f.count, 1);
    assert.equal(timers.pending(), 0);
  } finally {
    timers.restore();
  }
});

test("transient 503 keeps the last good `available` state and keeps polling", async () => {
  const timers = installFakeTimers();
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher);
    p.start();
    f.resolveLive(200, validBody(100_000));
    await settle();
    assert.equal(p.getState().status, "available");

    // next tick → transient 503
    timers.fireOne();
    assert.equal(f.count, 2, "a new cycle fired on the tick");
    f.resolveLive(503, { error: "service unavailable" });
    await settle();

    assert.equal(p.getState().status, "available", "last good state preserved");
    assert.equal(p.getState().gpuCount, 1);
    assert.equal(timers.pending(), 1, "keeps polling after a transient failure");
  } finally {
    timers.restore();
  }
});

test("transient 503 from `waiting` stays `waiting` and keeps polling", async () => {
  const timers = installFakeTimers();
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher);
    p.start();
    f.resolveLive(503, { error: "service unavailable" });
    await settle();
    assert.equal(p.getState().status, "waiting", "no data yet → stays waiting");
    assert.equal(p.getState().reconciliation, null);
    assert.equal(timers.pending(), 1, "keeps polling (a tick is scheduled)");
  } finally {
    timers.restore();
  }
});

test("malformed body (fails validation) preserves the previous state", async () => {
  const timers = installFakeTimers();
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher);
    p.start();
    f.resolveLive(200, validBody(100_000));
    await settle();
    assert.equal(p.getState().status, "available");

    timers.fireOne();
    // wrong schemaVersion → validator rejects
    f.resolveLive(200, { snapshot: { capturedAt: 1 }, reconciliation: { schemaVersion: 2 } });
    await settle();

    assert.equal(p.getState().status, "available", "previous state preserved");
    assert.equal(p.getState().reconciliation?.gpuNodes.length, 1);
  } finally {
    timers.restore();
  }
});

test("malformed body from `waiting` stays `waiting`", async () => {
  const timers = installFakeTimers();
  const f = makeFetcher();
  try {
    const p = makePoller(f.fetcher);
    p.start();
    f.resolveLive(200, { not: "a fleet telemetry response" });
    await settle();
    assert.equal(p.getState().status, "waiting");
    assert.equal(p.getState().reconciliation, null);
  } finally {
    timers.restore();
  }
});
