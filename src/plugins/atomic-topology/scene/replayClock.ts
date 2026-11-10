/**
 * Replay clock (OR-ATOM Step 12): pure scrub / play / loop state.
 *
 * No timers, no DOM, no three. The controller feeds it wall-clock deltas; every
 * function returns a NEW state (the input is never mutated), so it is trivially
 * testable. Positions are absolute epoch ms inside `[startMs, endMs]`.
 */
export const REPLAY_SPEEDS = [1, 4, 16] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Real-time interval between discrete steps under reduced motion. */
export const REPLAY_STEP_INTERVAL_MS = 1200;

export interface ReplayClockState {
  startMs: number;
  endMs: number;
  /** Playhead, absolute epoch ms, always within `[startMs, endMs]`. */
  positionMs: number;
  speed: ReplaySpeed;
  playing: boolean;
  /** Wrap to the start at the end instead of stopping. */
  loop: boolean;
}

export function clampSpeed(value: unknown): ReplaySpeed {
  return (REPLAY_SPEEDS as readonly number[]).includes(value as number)
    ? (value as ReplaySpeed)
    : 1;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function createReplayClock(
  startMs: number,
  endMs: number,
  options: { speed?: number; loop?: boolean; playing?: boolean } = {}
): ReplayClockState {
  const s = Number.isFinite(startMs) ? startMs : 0;
  const e = Number.isFinite(endMs) ? Math.max(endMs, s) : s;
  return {
    startMs: s,
    endMs: e,
    positionMs: s,
    speed: clampSpeed(options.speed ?? 1),
    playing: options.playing ?? false,
    loop: options.loop ?? false,
  };
}

/** Move the playhead (clamped). Playing state is kept. */
export function seekReplay(state: ReplayClockState, positionMs: number): ReplayClockState {
  const p = Number.isFinite(positionMs) ? positionMs : state.positionMs;
  return { ...state, positionMs: clamp(p, state.startMs, state.endMs) };
}

export function setReplaySpeed(state: ReplayClockState, speed: number): ReplayClockState {
  return { ...state, speed: clampSpeed(speed) };
}

export function setReplayLoop(state: ReplayClockState, loop: boolean): ReplayClockState {
  return { ...state, loop };
}

/** Play / pause. Playing from the very end restarts at the start. */
export function setReplayPlaying(state: ReplayClockState, playing: boolean): ReplayClockState {
  if (playing && state.positionMs >= state.endMs && state.endMs > state.startMs) {
    return { ...state, playing: true, positionMs: state.startMs };
  }
  return { ...state, playing };
}

/**
 * Advance by `dtMs` of REAL time (scaled by speed). Stops (or wraps when
 * looping) at the end. A paused clock, a non-positive / non-finite dt, or a
 * zero-length window never moves.
 */
export function advanceReplay(state: ReplayClockState, dtMs: number): ReplayClockState {
  if (!state.playing || !Number.isFinite(dtMs) || dtMs <= 0) return state;
  const span = state.endMs - state.startMs;
  if (span <= 0) return { ...state, playing: false };
  const next = state.positionMs + dtMs * state.speed;
  if (next < state.endMs) return { ...state, positionMs: next };
  if (state.loop) {
    return { ...state, positionMs: state.startMs + ((next - state.startMs) % span) };
  }
  return { ...state, positionMs: state.endMs, playing: false };
}

/** The first record time strictly after `positionMs` (or the window end), for stepping. */
export function nextEventTime(state: ReplayClockState, times: readonly number[]): number {
  for (const t of times) if (t > state.positionMs && t <= state.endMs) return t;
  return state.endMs;
}

/** The last record time strictly before `positionMs` (or the window start). */
export function prevEventTime(state: ReplayClockState, times: readonly number[]): number {
  for (let i = times.length - 1; i >= 0; i -= 1) {
    if (times[i] < state.positionMs && times[i] >= state.startMs) return times[i];
  }
  return state.startMs;
}

/**
 * Reduced-motion playback: no continuous motion. Each call (the controller
 * invokes it every {@link REPLAY_STEP_INTERVAL_MS}) jumps to the next recorded
 * event; the clock stops (or wraps when looping) after the last one.
 */
export function advanceReplayStepped(
  state: ReplayClockState,
  times: readonly number[]
): ReplayClockState {
  if (!state.playing) return state;
  const next = nextEventTime(state, times);
  if (next >= state.endMs || next === state.positionMs) {
    if (state.loop && state.positionMs < state.endMs) return { ...state, positionMs: state.endMs };
    if (state.loop) return { ...state, positionMs: state.startMs };
    return { ...state, positionMs: state.endMs, playing: false };
  }
  return { ...state, positionMs: next };
}

/** 0..1 progress of the playhead through the window (0 for an empty window). */
export function replayProgress(state: ReplayClockState): number {
  const span = state.endMs - state.startMs;
  return span > 0 ? clamp((state.positionMs - state.startMs) / span, 0, 1) : 0;
}
