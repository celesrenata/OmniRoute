/**
 * Replay controller (OR-ATOM Step 12): the imperative owner of one replay session.
 *
 * DOM-free, three-free and React-free (timers and the fetcher are injectable),
 * so the whole flow is unit-testable. It owns:
 *   - the fetched {@link TraceTimeline} (one fetch per `open`, never polled);
 *   - the {@link ReplayClockState} and a timer that advances it only while
 *     playing, the host is not paused and the document is visible;
 *   - a dedicated replay {@link AtomicEventPool} that receives every recorded
 *     record exactly once as the playhead crosses it (the SAME pool type the live
 *     path uses, so feeders / detail panel read it unchanged);
 *   - the derived replay snapshot, handed to the host only when something the
 *     scene reads actually changed (no per-tick React render).
 *
 * `nowRef.value` is the playhead (epoch ms) the scene reads per frame; it is
 * `null` whenever replay is not active, which is how the scene knows to use the
 * wall clock and the live pool again.
 */
import {
  countByProvider,
  recordsBetween,
  type KindCounts,
  type TraceRecord,
  type TraceTimeline,
} from "@/shared/topology/telemetry/traceHistory";
import type { TraceFetchResult } from "@/shared/topology/telemetry/traceHistoryFetch";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";
import {
  ATOMIC_EVENT_MAX_AGE_MS,
  createAtomicEventPool,
  type AtomicEvent,
  type AtomicEventPool,
} from "../eventPool";
import { asJobLane } from "../visualEncoding";
import {
  REPLAY_STEP_INTERVAL_MS,
  advanceReplay,
  advanceReplayStepped,
  createReplayClock,
  nextEventTime,
  prevEventTime,
  seekReplay,
  setReplayLoop,
  setReplayPlaying,
  setReplaySpeed,
  type ReplayClockState,
} from "./replayClock";
import {
  buildReplayRequests,
  buildReplaySnapshot,
  replayMoment,
  replaySnapshotKey,
  type ReplayMoment,
  type ReplayRequest,
} from "./replaySnapshot";

export const REPLAY_WINDOWS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export const REPLAY_DEFAULT_WINDOW_MS = REPLAY_WINDOWS_MS[0];
/** Real-time tick while playing continuously. */
export const REPLAY_TICK_MS = 50;
/** Largest real dt one tick may apply (a backgrounded tab never jumps the playhead). */
const MAX_TICK_DT_MS = 250;
/** View updates reach subscribers at most this often (discrete changes are immediate). */
const VIEW_THROTTLE_MS = 100;

export type ReplayPhase = "closed" | "loading" | "ready" | "error";

export interface ReplayView {
  phase: ReplayPhase;
  windowMs: number;
  clock: ReplayClockState | null;
  recordCount: number;
  rowCount: number;
  truncated: boolean;
  reducedMotion: boolean;
  /** What the recorded history shows at the playhead (null until ready). */
  moment: ReplayMoment | null;
  /** Short, non-sensitive error label (never a raw server message). */
  error: string | null;
}

export interface ReplayScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ReplayControllerOptions {
  /** The live snapshot (structure source). */
  getBaseSnapshot: () => TopologySceneSnapshot;
  fetchHistory: (windowMs: number, signal: AbortSignal) => Promise<TraceFetchResult>;
  /** The derived replay snapshot changed: the host should re-render. */
  onSnapshot: () => void;
  reducedMotion?: boolean;
  scheduler?: ReplayScheduler;
  now?: () => number;
  isDocumentHidden?: () => boolean;
}

export interface ReplayController {
  /** Playhead (epoch ms) read per frame by the scene; `null` when not replaying. */
  readonly nowRef: { value: number | null };
  readonly pool: AtomicEventPool;
  open(windowMs?: number): Promise<void>;
  close(): void;
  isActive(): boolean;
  getView(): ReplayView;
  /** The derived snapshot for the current playhead, or `null` when not replaying. */
  getSnapshot(): TopologySceneSnapshot | null;
  subscribe(listener: () => void): () => void;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(positionMs: number): void;
  setSpeed(speed: number): void;
  setLoop(loop: boolean): void;
  stepNext(): void;
  stepPrev(): void;
  setHostPaused(paused: boolean): void;
  /** The live base snapshot changed structurally: rebuild the derived snapshot. */
  invalidate(): void;
  /** Advance by `dtMs` of real time (the timer calls this; exposed for tests). */
  tick(dtMs: number): void;
  /** Records the playhead has crossed and injected into the pool since open/seek. */
  injectedCounts(): Record<string, KindCounts>;
  /** The loaded timeline (summary / demo comparison). */
  getTimeline(): TraceTimeline | null;
  dispose(): void;
}

function toAtomicEvent(r: TraceRecord): AtomicEvent {
  return {
    id: r.id,
    at: r.at,
    kind: r.kind,
    providerId: r.providerId,
    resourceId: r.resourceId,
    modelId: r.modelId,
    lane: r.lane ? asJobLane(r.lane) : undefined,
    linkId: r.linkId,
  };
}

const defaultScheduler: ReplayScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export function createReplayController(options: ReplayControllerOptions): ReplayController {
  const scheduler = options.scheduler ?? defaultScheduler;
  const nowFn = options.now ?? (() => Date.now());
  const reducedMotion = options.reducedMotion === true;
  const hidden =
    options.isDocumentHidden ?? (() => typeof document !== "undefined" && document.hidden);

  const nowRef: { value: number | null } = { value: null };
  const pool = createAtomicEventPool();
  const listeners = new Set<() => void>();

  let phase: ReplayPhase = "closed";
  let windowMs: number = REPLAY_DEFAULT_WINDOW_MS;
  let error: string | null = null;
  let timeline: TraceTimeline | null = null;
  let truncated = false;
  let times: number[] = [];
  let requests: ReplayRequest[] = [];
  let clock: ReplayClockState | null = null;
  let derived: TopologySceneSnapshot | null = null;
  let derivedKey = "";
  let poolPos: number | null = null;
  let injected: Record<string, KindCounts> = {};
  let hostPaused = false;
  let timer: unknown = null;
  let timerMs = 0;
  let abort: AbortController | null = null;
  let view: ReplayView = makeView();
  let lastViewAt = -Infinity;
  let disposed = false;

  function makeView(): ReplayView {
    return {
      phase,
      windowMs,
      clock,
      recordCount: timeline?.records.length ?? 0,
      rowCount: timeline?.rowCount ?? 0,
      truncated,
      reducedMotion,
      moment: phase === "ready" && clock ? replayMoment(requests, clock.positionMs) : null,
      error,
    };
  }

  function emitView(force: boolean): void {
    const t = nowFn();
    if (!force && t - lastViewAt < VIEW_THROTTLE_MS) return;
    lastViewAt = t;
    view = makeView();
    for (const l of Array.from(listeners)) l();
  }

  function stopTimer(): void {
    if (timer != null) scheduler.clearInterval(timer);
    timer = null;
    timerMs = 0;
  }

  function syncTimer(): void {
    const want = phase === "ready" && clock?.playing === true && !disposed;
    if (!want) {
      stopTimer();
      return;
    }
    const ms = reducedMotion ? REPLAY_STEP_INTERVAL_MS : REPLAY_TICK_MS;
    if (timer != null && timerMs === ms) return;
    stopTimer();
    timerMs = ms;
    let last = nowFn();
    timer = scheduler.setInterval(() => {
      const t = nowFn();
      const dt = Math.min(Math.max(t - last, 0), MAX_TICK_DT_MS);
      last = t;
      api.tick(reducedMotion ? REPLAY_STEP_INTERVAL_MS : dt);
    }, ms);
  }

  function addInjected(r: TraceRecord): void {
    const c = (injected[r.providerId] ??= { started: 0, completed: 0, failed: 0 });
    if (r.kind === "request-started") c.started += 1;
    else if (r.kind === "request-completed") c.completed += 1;
    else c.failed += 1;
  }

  /** Bring the replay pool to the playhead: forward crossings inject once; a seek rebuilds. */
  function syncPool(pos: number, forward: boolean): void {
    if (!timeline) return;
    if (forward && poolPos != null && pos >= poolPos) {
      for (const r of recordsBetween(timeline.records, poolPos, pos)) {
        pool.ingest(toAtomicEvent(r), pos);
        addInjected(r);
      }
    } else {
      pool.clear();
      injected = {};
      for (const r of recordsBetween(timeline.records, pos - ATOMIC_EVENT_MAX_AGE_MS, pos)) {
        pool.ingest(toAtomicEvent(r), pos);
      }
    }
    poolPos = pos;
  }

  function refresh(forward: boolean, force = false): void {
    if (!clock || !timeline) return;
    const pos = clock.positionMs;
    syncPool(pos, forward);
    nowRef.value = pos;
    const snap = buildReplaySnapshot(options.getBaseSnapshot(), requests, pos);
    const key = replaySnapshotKey(snap);
    derived = snap;
    if (force || key !== derivedKey) {
      derivedKey = key;
      options.onSnapshot();
    }
  }

  const api: ReplayController = {
    nowRef,
    pool,
    async open(w = REPLAY_DEFAULT_WINDOW_MS) {
      if (disposed) return;
      abort?.abort();
      const ctl = new AbortController();
      abort = ctl;
      windowMs = w;
      phase = "loading";
      error = null;
      stopTimer();
      clock = null;
      timeline = null;
      derived = null;
      derivedKey = "";
      poolPos = null;
      injected = {};
      pool.clear();
      emitView(true);
      try {
        const result = await options.fetchHistory(w, ctl.signal);
        if (disposed || ctl.signal.aborted) return;
        timeline = result.timeline;
        truncated = result.truncated;
        times = result.timeline.records.map((r) => r.at);
        requests = buildReplayRequests(result.timeline.records);
        clock = createReplayClock(result.timeline.sinceMs, result.timeline.untilMs);
        phase = "ready";
        refresh(false, true);
        emitView(true);
      } catch (e) {
        if (disposed || ctl.signal.aborted) return;
        if (e instanceof Error && e.name === "AbortError") return;
        phase = "error";
        error = "Could not load recorded requests";
        clock = null;
        timeline = null;
        nowRef.value = null;
        emitView(true);
      }
    },
    close() {
      abort?.abort();
      abort = null;
      stopTimer();
      const wasActive = phase !== "closed";
      phase = "closed";
      error = null;
      clock = null;
      timeline = null;
      derived = null;
      derivedKey = "";
      poolPos = null;
      injected = {};
      times = [];
      requests = [];
      pool.clear();
      nowRef.value = null;
      emitView(true);
      if (wasActive) options.onSnapshot();
    },
    isActive: () => phase !== "closed",
    getView: () => view,
    getSnapshot: () => (phase === "ready" ? derived : null),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    play() {
      if (phase !== "ready" || !clock) return;
      const wasEnd = clock.positionMs >= clock.endMs;
      clock = setReplayPlaying(clock, true);
      if (wasEnd) refresh(false);
      syncTimer();
      emitView(true);
    },
    pause() {
      if (phase !== "ready" || !clock) return;
      clock = setReplayPlaying(clock, false);
      syncTimer();
      emitView(true);
    },
    toggle() {
      if (clock?.playing) api.pause();
      else api.play();
    },
    seek(positionMs) {
      if (phase !== "ready" || !clock) return;
      clock = seekReplay(clock, positionMs);
      refresh(false);
      emitView(true);
    },
    setSpeed(speed) {
      if (phase !== "ready" || !clock) return;
      clock = setReplaySpeed(clock, speed);
      emitView(true);
    },
    setLoop(loop) {
      if (phase !== "ready" || !clock) return;
      clock = setReplayLoop(clock, loop);
      emitView(true);
    },
    stepNext() {
      if (phase !== "ready" || !clock) return;
      const target = nextEventTime(clock, times);
      clock = seekReplay(setReplayPlaying(clock, false), target);
      // Stepping forward injects exactly the records crossed.
      refresh(true);
      syncTimer();
      emitView(true);
    },
    stepPrev() {
      if (phase !== "ready" || !clock) return;
      clock = seekReplay(setReplayPlaying(clock, false), prevEventTime(clock, times));
      refresh(false);
      syncTimer();
      emitView(true);
    },
    setHostPaused(paused) {
      hostPaused = paused;
    },
    invalidate() {
      if (phase !== "ready") return;
      refresh(true, true);
    },
    tick(dtMs) {
      if (phase !== "ready" || !clock || !clock.playing) return;
      if (hostPaused || hidden()) return;
      const before = clock;
      clock = reducedMotion ? advanceReplayStepped(clock, times) : advanceReplay(clock, dtMs);
      const wrapped = clock.positionMs < before.positionMs;
      refresh(!wrapped);
      if (!clock.playing) syncTimer();
      emitView(!clock.playing || wrapped);
    },
    injectedCounts: () => injected,
    getTimeline: () => timeline,
    dispose() {
      if (disposed) return;
      api.close();
      disposed = true;
      listeners.clear();
    },
  };
  return api;
}

/** Summary used by the dev API and the live demo: timeline counts per provider. */
export function timelineCounts(timeline: TraceTimeline | null): Record<string, KindCounts> {
  return timeline ? countByProvider(timeline.records) : {};
}
