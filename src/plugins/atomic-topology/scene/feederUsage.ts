/**
 * Usage-driven feeder traces (operator directive 40).
 *
 * The copper nets routed into an atom's pad are the ONE telemetry-bound part of the
 * board: they gain pulse speed / density and a very faint copper glow only while the
 * atom is really in use, proportional to how much. Everything here is pure (no three,
 * no DOM) so the mapping, the source priority and the easing are unit-tested.
 *
 * Honesty: the signal is the atom's real measured activity, in priority order
 *   1. measured output tok/s (already stale-gated to `null` upstream),
 *   2. else the live in-flight request count (gated off when the snapshot is stale),
 *   3. else the recent real call-log rate (events/min in the event pool's window).
 * No signal, unknown or stale -> basis "none", level 0: the feeders fall back to the
 * decorative baseline. Nothing is inferred or faked.
 */

export type FeederBasis = "tps" | "inflight" | "calls" | "none";

export interface FeederSignalInput {
  /** Measured output tokens/s (null = unavailable / stale). */
  tps: number | null | undefined;
  /** Live in-flight request (or device job) count; null = absent. */
  inFlight: number | null | undefined;
  /** Recent real call-log rate, events/min; null = no event feed. */
  callsPerMin: number | null | undefined;
  /** The snapshot feed is stale: the live in-flight count is not trusted. */
  inFlightStale?: boolean;
}
export interface FeederSignal {
  basis: FeederBasis;
  /** The value of the chosen basis (0 when basis is "none"). */
  value: number;
}

/** A usable measured value: finite and >= 0. */
const usable = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Pick the signal by priority. A source that reports real activity (> 0) wins in priority
 * order; if every available source is a measured zero, the first available one is the
 * basis with value 0 (observed quiet, no effect). Nothing available -> "none".
 */
export function feederSignal(input: FeederSignalInput): FeederSignal {
  const sources: [FeederBasis, number | null | undefined][] = [
    ["tps", input.tps],
    ["inflight", input.inFlightStale ? null : input.inFlight],
    ["calls", input.callsPerMin],
  ];
  let firstZero: FeederSignal | null = null;
  for (const [basis, v] of sources) {
    if (!usable(v)) continue;
    if (v > 0) return { basis, value: v };
    firstZero ??= { basis, value: 0 };
  }
  return firstZero ?? { basis: "none", value: 0 };
}

/**
 * Stable reference range per basis: `ref` sets where the log curve bends, `max` is the
 * value that maps to full intensity (saturates above it).
 */
export const FEEDER_RANGE: Record<Exclude<FeederBasis, "none">, { ref: number; max: number }> = {
  tps: { ref: 6, max: 120 },
  inflight: { ref: 1, max: 12 },
  calls: { ref: 3, max: 90 },
};

/**
 * Usage -> target intensity in [0, 1]: smooth, monotonic, log-style, zero at zero, and
 * 0 for basis "none" (null -> none).
 */
export function feederTarget(signal: FeederSignal): number {
  if (signal.basis === "none" || !usable(signal.value) || signal.value <= 0) return 0;
  const { ref, max } = FEEDER_RANGE[signal.basis];
  const k = Math.log1p(signal.value / ref) / Math.log1p(max / ref);
  return Math.min(1, Math.max(0, k));
}

/** Easing time constant (s): ~95 % of a step in ~1 s, frame-rate independent. */
export const FEEDER_TAU_S = 0.33;
/** A new target is adopted only when it moves by more than this (hysteresis). */
export const FEEDER_DEADBAND = 0.04;
/** Below this the feeder is off (no flicker around zero). */
export const FEEDER_OFF = 0.015;

export interface FeederState {
  /** Accepted (hysteresis-filtered) target. */
  goal: number;
  /** Eased intensity the shader reads. */
  level: number;
}
export function createFeederState(): FeederState {
  return { goal: 0, level: 0 };
}
/**
 * Advance one atom's feeder by `dt` seconds toward `target`. Hysteresis: the goal only
 * moves when the target leaves the deadband around it, except that a zero target always
 * applies (usage stopping is never held). Instant when `instant` (reduced motion).
 */
export function stepFeeder(
  state: FeederState,
  target: number,
  dt: number,
  instant = false
): number {
  const t = Number.isFinite(target) ? Math.min(1, Math.max(0, target)) : 0;
  if (t <= FEEDER_OFF) state.goal = 0;
  else if (Math.abs(t - state.goal) > FEEDER_DEADBAND) state.goal = t;
  const d = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  const a = instant ? 1 : 1 - Math.exp(-d / FEEDER_TAU_S);
  state.level += (state.goal - state.level) * a;
  if (state.goal === 0 && state.level < 1e-3) state.level = 0;
  return state.level;
}

/** Recent real call-log rate for a provider: started requests per minute in `windowMs`. */
export function callsPerMinute(
  events: readonly { at: number; kind: string; providerId?: string }[] | null | undefined,
  providerId: string | null | undefined,
  nowMs: number,
  windowMs = 60_000
): number | null {
  if (!events || !Number.isFinite(nowMs)) return null;
  let n = 0;
  for (const e of events) {
    if (e.kind !== "request-started") continue;
    if (providerId && e.providerId !== providerId) continue;
    const age = nowMs - e.at;
    if (age >= 0 && age <= windowMs) n += 1;
  }
  return (n * 60_000) / windowMs;
}

/** The atom fields the feeder signal reads (a subset of the visual descriptor). */
export interface FeederAtomInput {
  kind: "hub" | "provider" | "gpu" | "runtime";
  providerId?: string;
  measuredTps: number | null;
  activeRequests: number | null;
  deviceFacts?: { activeJobs?: number | null } | null;
}
/**
 * One atom's feeder signal, shared by the scene (per-frame drive) and the detail panel
 * (explanation line) so both state the same basis. The hub routes every call; a provider
 * owns its own call log; device atoms have none.
 */
export function atomFeederSignal(
  d: FeederAtomInput,
  ctx: {
    events: readonly { at: number; kind: string; providerId?: string }[] | null | undefined;
    nowMs: number;
    inFlightStale: boolean;
  }
): FeederSignal {
  const calls =
    d.kind === "hub"
      ? callsPerMinute(ctx.events, null, ctx.nowMs)
      : d.providerId
        ? callsPerMinute(ctx.events, d.providerId, ctx.nowMs)
        : null;
  return feederSignal({
    tps: d.measuredTps,
    inFlight: d.activeRequests ?? d.deviceFacts?.activeJobs ?? null,
    callsPerMin: calls,
    inFlightStale: ctx.inFlightStale,
  });
}

const BASIS_TEXT: Record<FeederBasis, string> = {
  tps: "measured output tok/s",
  inflight: "live in-flight requests",
  calls: "recent call-log rate",
  none: "no measured usage",
};
/** Tooltip / detail-panel line explaining what drives the feeder traces. */
export function feederLine(signal: FeederSignal, ageMs: number | null): string {
  if (signal.basis === "none") return "Feeder traces: idle (no measured usage; decorative only)";
  const v =
    signal.basis === "tps"
      ? `${signal.value.toFixed(1)} tok/s`
      : signal.basis === "inflight"
        ? `${Math.round(signal.value)} in flight`
        : `${signal.value.toFixed(1)}/min`;
  const age =
    ageMs != null && Number.isFinite(ageMs) && ageMs >= 0
      ? `, ${ageMs < 1000 ? "<1" : Math.round(ageMs / 1000)} s ago`
      : "";
  const state = signal.value > 0 ? "" : " (observed quiet: no effect)";
  return `Feeder traces: driven by ${BASIS_TEXT[signal.basis]} (${v}${age})${state}`;
}
