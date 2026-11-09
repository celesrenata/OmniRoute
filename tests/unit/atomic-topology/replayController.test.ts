/**
 * Step 12: the replay session. One fetch per open, recorded events injected into the replay
 * pool exactly once as the playhead crosses them, live state untouched, clean close.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";
import { buildTraceTimeline, countByProvider } from "@/shared/topology/telemetry/traceHistory";
import {
  createReplayController,
  timelineCounts,
  type ReplayScheduler,
} from "../../../src/plugins/atomic-topology/scene/replayController.ts";

const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const WINDOW = 5 * 60_000;

const base: TopologySceneSnapshot = {
  schemaVersion: 1,
  capturedAt: T0 + WINDOW,
  nodes: [
    { id: "hub", kind: "hub", label: "Router", health: "unknown", traffic: "idle" },
    {
      id: "provider:openai",
      kind: "provider",
      label: "OpenAI",
      providerId: "openai",
      health: "healthy",
      traffic: "idle",
    },
    {
      id: "provider:anthropic",
      kind: "provider",
      label: "Anthropic",
      providerId: "anthropic",
      health: "healthy",
      traffic: "idle",
    },
  ],
  links: [
    {
      id: "route:openai",
      source: "hub",
      target: "provider:openai",
      kind: "route",
      health: "healthy",
      traffic: "idle",
    },
    {
      id: "route:anthropic",
      source: "hub",
      target: "provider:anthropic",
      kind: "route",
      health: "healthy",
      traffic: "idle",
    },
  ],
};

const rows = [
  {
    id: "1",
    timestamp: iso(T0 + 10_000),
    provider: "openai",
    model: "gpt-4o",
    status: 200,
    duration: 2000,
  },
  {
    id: "2",
    timestamp: iso(T0 + 20_000),
    provider: "openai",
    model: "gpt-4o",
    status: 200,
    duration: 1000,
  },
  {
    id: "3",
    timestamp: iso(T0 + 30_000),
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    status: 500,
    duration: 800,
  },
];

function setup(
  opts: { reducedMotion?: boolean; hidden?: boolean; fail?: boolean; empty?: boolean } = {}
) {
  let renders = 0;
  let fetches = 0;
  let nowMs = 0;
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const scheduler: ReplayScheduler = {
    setInterval: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearInterval: (h) => {
      (h as { live: boolean }).live = false;
    },
  };
  const ctl = createReplayController({
    getBaseSnapshot: () => base,
    fetchHistory: async () => {
      fetches += 1;
      if (opts.fail) throw new Error("boom: secret internal detail");
      const timeline = buildTraceTimeline(opts.empty ? [] : rows, {
        sinceMs: T0,
        untilMs: T0 + WINDOW,
      });
      return { timeline, fetchedRows: rows.length, truncated: false };
    },
    onSnapshot: () => {
      renders += 1;
    },
    reducedMotion: opts.reducedMotion,
    scheduler,
    now: () => nowMs,
    isDocumentHidden: () => opts.hidden === true,
  });
  return {
    ctl,
    renders: () => renders,
    fetches: () => fetches,
    advanceWall: (ms: number) => {
      nowMs += ms;
    },
    liveTimers: () => timers.filter((t) => t.live),
  };
}

test("closed by default: no snapshot, no playhead, no timers", () => {
  const { ctl, liveTimers } = setup();
  assert.equal(ctl.isActive(), false);
  assert.equal(ctl.getSnapshot(), null);
  assert.equal(ctl.nowRef.value, null);
  assert.equal(liveTimers().length, 0);
});

test("open fetches once and exposes a replay snapshot pinned to the window start", async () => {
  const { ctl, fetches } = setup();
  const p = ctl.open(WINDOW);
  assert.equal(ctl.getView().phase, "loading");
  assert.equal(ctl.getSnapshot(), null, "still live while loading; the marker says so");
  await p;
  assert.equal(fetches(), 1);
  assert.equal(ctl.getView().phase, "ready");
  assert.equal(ctl.getView().recordCount, 6);
  assert.equal(ctl.getSnapshot()!.capturedAt, T0);
  assert.equal(ctl.nowRef.value, T0);
  assert.equal(ctl.pool.size, 0);
});

test("playing through the window injects every recorded event exactly once (counts match)", async () => {
  const { ctl, liveTimers, advanceWall } = setup();
  await ctl.open(WINDOW);
  ctl.setSpeed(16);
  ctl.play();
  assert.equal(liveTimers().length, 1);
  for (let i = 0; i < 2000 && ctl.getView().clock!.playing; i += 1) {
    advanceWall(50);
    ctl.tick(50);
  }
  assert.equal(ctl.getView().clock!.playing, false, "stops at the end");
  assert.equal(liveTimers().length, 0, "the timer stops with playback");
  const expected = countByProvider(ctl.getTimeline()!.records);
  assert.deepEqual(ctl.injectedCounts(), expected);
  assert.deepEqual(timelineCounts(ctl.getTimeline()), expected);
  assert.deepEqual(expected, {
    openai: { started: 2, completed: 2, failed: 0 },
    anthropic: { started: 1, completed: 0, failed: 1 },
  });
});

test("replay pool holds only events at or before the playhead; a seek back rebuilds it", async () => {
  const { ctl } = setup();
  await ctl.open(WINDOW);
  ctl.seek(T0 + 25_000);
  const at = ctl.nowRef.value!;
  assert.equal(at, T0 + 25_000);
  for (const e of ctl.pool.events()) assert.ok(e.at <= at);
  assert.equal(ctl.pool.size, 4, "two openai requests (start + done) within the last 60 s");
  ctl.seek(T0 + 5000);
  assert.equal(ctl.pool.size, 0);
  assert.deepEqual(ctl.injectedCounts(), {});
});

test("the scene is re-rendered only when what it reads changes, not every tick", async () => {
  const { ctl, renders, advanceWall } = setup();
  await ctl.open(WINDOW);
  const before = renders();
  ctl.play();
  for (let i = 0; i < 20; i += 1) {
    advanceWall(50);
    ctl.tick(50); // 1 s of replay at 1x, no state change before the first request
  }
  assert.equal(renders(), before, "no change, no render");
  ctl.seek(T0 + 10_500); // openai in flight
  assert.ok(renders() > before);
  const snap = ctl.getSnapshot()!;
  assert.equal(snap.nodes.find((n) => n.id === "provider:openai")!.traffic, "active");
});

test("a paused host, a hidden document, and a paused clock never advance the playhead", async () => {
  const a = setup();
  await a.ctl.open(WINDOW);
  a.ctl.play();
  a.ctl.setHostPaused(true);
  a.ctl.tick(1000);
  assert.equal(a.ctl.getView().clock!.positionMs, T0);
  a.ctl.setHostPaused(false);
  a.ctl.pause();
  a.ctl.tick(1000);
  assert.equal(a.ctl.getView().clock!.positionMs, T0);
  const b = setup({ hidden: true });
  await b.ctl.open(WINDOW);
  b.ctl.play();
  b.ctl.tick(1000);
  assert.equal(b.ctl.getView().clock!.positionMs, T0);
});

test("event stepping lands exactly on recorded times and injects what it crosses", async () => {
  const { ctl } = setup();
  await ctl.open(WINDOW);
  ctl.stepNext();
  assert.equal(ctl.getView().clock!.positionMs, T0 + 10_000);
  assert.equal(ctl.pool.size, 1);
  ctl.stepNext();
  assert.equal(ctl.getView().clock!.positionMs, T0 + 12_000);
  assert.equal(ctl.pool.size, 2);
  ctl.stepPrev();
  assert.equal(ctl.getView().clock!.positionMs, T0 + 10_000);
  assert.equal(ctl.pool.size, 1);
});

test("reduced motion steps event to event on a slow timer (no continuous motion)", async () => {
  const { ctl, liveTimers, advanceWall } = setup({ reducedMotion: true });
  await ctl.open(WINDOW);
  ctl.play();
  assert.equal(liveTimers().length, 1);
  assert.ok(liveTimers()[0].ms >= 1000);
  advanceWall(1200); // view updates are throttled to 10 Hz of wall time
  ctl.tick(50);
  assert.equal(ctl.getView().clock!.positionMs, T0 + 10_000);
  advanceWall(1200);
  ctl.tick(50);
  assert.equal(ctl.getView().clock!.positionMs, T0 + 12_000);
});

test("empty history: ready but nothing to play, nothing injected, scene stays idle", async () => {
  const { ctl } = setup({ empty: true });
  await ctl.open(WINDOW);
  assert.equal(ctl.getView().phase, "ready");
  assert.equal(ctl.getView().recordCount, 0);
  ctl.play();
  ctl.tick(100_000);
  assert.equal(ctl.pool.size, 0);
  assert.deepEqual(ctl.injectedCounts(), {});
  for (const n of ctl.getSnapshot()!.nodes) assert.equal(n.traffic, "idle");
});

test("a failed fetch shows a generic error (no raw message) and the scene stays live", async () => {
  const { ctl } = setup({ fail: true });
  await ctl.open(WINDOW);
  const v = ctl.getView();
  assert.equal(v.phase, "error");
  assert.ok(v.error && !/secret|boom/.test(v.error));
  assert.equal(ctl.getSnapshot(), null);
  assert.equal(ctl.nowRef.value, null);
});

test("close restores live: playhead cleared, pool emptied, timers stopped, host told to re-render", async () => {
  const { ctl, renders, liveTimers } = setup();
  await ctl.open(WINDOW);
  ctl.seek(T0 + 25_000);
  ctl.play();
  const before = renders();
  ctl.close();
  assert.equal(ctl.isActive(), false);
  assert.equal(ctl.getSnapshot(), null);
  assert.equal(ctl.nowRef.value, null);
  assert.equal(ctl.pool.size, 0);
  assert.equal(liveTimers().length, 0);
  assert.ok(renders() > before);
});

test("reopening with another window re-fetches; a stale in-flight fetch cannot overwrite it", async () => {
  const { ctl, fetches } = setup();
  const first = ctl.open(WINDOW);
  const second = ctl.open(15 * 60_000);
  await Promise.all([first, second]);
  assert.equal(fetches(), 2);
  assert.equal(ctl.getView().windowMs, 15 * 60_000);
  assert.equal(ctl.getView().phase, "ready");
});

test("invalidate rebuilds from the new live structure and dispose is final", async () => {
  const { ctl, renders } = setup();
  await ctl.open(WINDOW);
  const before = renders();
  ctl.invalidate();
  assert.ok(renders() > before);
  ctl.dispose();
  assert.equal(ctl.isActive(), false);
  await ctl.open(WINDOW);
  assert.equal(ctl.isActive(), false, "a disposed controller cannot reopen");
});
