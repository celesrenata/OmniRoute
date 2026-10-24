/**
 * Pure visual-encoding rules for the Atomic topology renderer
 * (OR-ATOM-001 v2, T006a / M3 Phase A).
 *
 * Every function here is deterministic pure TS: no `three`, no DOM, no
 * Math.random. The WebGL scene (Phase B) consumes these values; the tests pin
 * the constants and the curve shapes so a renderer refactor cannot silently
 * change what a lane / model / rate looks like.
 */
import type { HealthState, TrafficState } from "@/shared/topology/domain/types";
import type { TopologyLane } from "@/shared/topology/domain/lane";

/**
 * Job-lane taxonomy the Atomic renderer colors atoms by.
 *
 * The renderer's palette (`LANE_HUES`) is keyed on this full union. Since M4
 * the topology *domain* emits a lane observation on each provider node
 * (`node.lane?: Observed<TopologyLane>`) using a strictly-narrower union
 * `TopologyLane ⊆ JobLane`; any domain-observed lane flows into a descriptor's
 * `lane: JobLane` field without runtime mapping (see {@link asJobLane}).
 */
export type JobLane =
  | "chat"
  | "prefill"
  | "decode"
  | "embedding"
  | "rerank"
  | "vision"
  | "image"
  | "audio"
  | "system"
  | "unknown";

/**
 * Backward-compatible alias: the domain's lane type, re-exposed from the
 * renderer's public visual-API module so callers of the adapter have one
 * import site. `TopologyLane ⊆ JobLane` — see {@link asJobLane} for the
 * compile-time subsumption pin.
 */
export type { TopologyLane };

/**
 * Type-level bridge: accepts a domain-observed `TopologyLane` and returns it
 * as a renderer `JobLane`. Pure cast — no runtime behaviour. Callers (adapter,
 * tests) can use this to make the subsumption explicit at the call site rather
 * than relying on TypeScript's implicit assignability.
 *
 * If the domain ever adds a `TopologyLane` value the renderer's palette
 * doesn't know (not in `LANE_HUES`), `lane` stops being assignable to
 * `JobLane` and this function's return type becomes a contradiction — the
 * caller's assignment to a `JobLane`-typed field then fails to compile,
 * forcing the palette to be extended before the new lane can be emitted.
 */
export function asJobLane(lane: TopologyLane): JobLane {
  return lane;
}

/**
 * Lane hue palette (exact values — the tests pin them).
 *
 * NOTE: `image` is intentionally NOT given its own hue; image workloads are
 * the vision family and share the vision hue, keeping the palette at the nine
 * distinct hues the design spec defines.
 */
export const LANE_HUES = {
  chat: "#22D3EE",
  prefill: "#34D399",
  decode: "#60A5FA",
  embedding: "#A78BFA",
  rerank: "#FBBF24",
  vision: "#818CF8",
  image: "#818CF8",
  audio: "#2DD4BF",
  system: "#A3E635",
  unknown: "#94A3B8",
} satisfies Record<JobLane, string>;

/** Hue for a single job lane (stable, exact — see {@link LANE_HUES}). */
export function laneHue(lane: JobLane): string {
  return LANE_HUES[lane];
}

/**
 * Muted gray for models with no recognized id. Deliberately distinct from the
 * lane `unknown` hue (#94A3B8) — a dark slate so "unknown model" reads as a
 * missing datum, not as an unknown lane.
 */
export const UNKNOWN_MODEL_COLOR = "#64748B";

/**
 * Deterministic seeded hash (FNV-1a, 32-bit) over the canonical model id.
 * Pure + integer-only, so the result is stable across engines and platforms.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Convert an HSL triple (h in [0,360), s/l in [0,1]) to an uppercase hex string. */
function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): string => {
    const k = (n + h / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * value)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}

/**
 * Deterministic color for a model id: a seeded hash over the canonical
 * (trimmed, lowercased) id maps to a stable hue, so the same model renders
 * with the same color in every atom and on every machine.
 *
 * - Empty / blank ids → {@link UNKNOWN_MODEL_COLOR}.
 * - Case-insensitive: `modelColor("GPT-4") === modelColor("gpt-4")`.
 */
export function modelColor(modelId: string): string {
  const canonical = modelId.trim().toLowerCase();
  if (canonical.length === 0) return UNKNOWN_MODEL_COLOR;
  const hue = fnv1a(canonical) % 360;
  return hslToHex(hue, 0.58, 0.56);
}

/* ------------------------------------------------------------------ */
/* Spin — the "work" animation speed for an atom                       */
/* ------------------------------------------------------------------ */

/** Result of {@link spinRadiansPerSecond}: a target speed + data provenance. */
export interface SpinResult {
  /** Target angular speed in radians/second. */
  value: number;
  /**
   * Provenance: a measured TPS, a measured zero (observed quiet), or
   * "unavailable" (no telemetry sampled at all — never fabricate a rate).
   */
  mode: "measured" | "measured-zero" | "unavailable";
}

/**
 * Map an output throughput (tokens/sec) to a spin speed in radians/second.
 *
 * Shape (fixed — the tests pin it):
 * ```
 * const clamp01 = (x) => Math.max(0, Math.min(1, x));
 * const r = clamp01(Math.log1p(Math.max(0, outputTPS)) / Math.log1p(referenceTPS));
 * const target = 0.10 + 1.65 * r;
 * ```
 * so the curve is monotonic in [0, referenceTPS], saturates above it, and
 * never goes below 0.10 rad/s.
 *
 * - `outputTPS === 0` → mode `"measured-zero"`, value `0.10` (observed quiet).
 * - `null` / `undefined` → mode `"unavailable"`, neutral slow value `0.10`
 *   (indistinguishable from quiet on purpose: we do not assert what we did
 *   not observe).
 *
 * @param outputTPS  measured output tokens/sec, or absent (`null`/`undefined`).
 * @param referenceTPS the TPS that maps to the maximum speed (must be > 0).
 */
export function spinRadiansPerSecond(
  outputTPS: number | null | undefined,
  referenceTPS: number
): SpinResult {
  if (outputTPS == null) {
    return { value: 0.1, mode: "unavailable" };
  }
  const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
  const safeReference = referenceTPS > 0 ? referenceTPS : 1;
  const r = clamp01(Math.log1p(Math.max(0, outputTPS)) / Math.log1p(safeReference));
  const target = 0.1 + 1.65 * r;
  if (outputTPS === 0) {
    return { value: 0.1, mode: "measured-zero" };
  }
  return { value: target, mode: "measured" };
}

/* ------------------------------------------------------------------ */
/* Vibration — jitter for queued (blocked) atoms                       */
/* ------------------------------------------------------------------ */

/** Result of {@link queueVibration}: amplitude/frequency + data provenance. */
export interface VibrationResult {
  /** Positional jitter amplitude (world units, ≤ {@link VIBRATION_MAX_AMPLITUDE}). */
  amplitude: number;
  /** Jitter frequency in Hz (≤ {@link VIBRATION_MAX_FREQUENCY_HZ}). */
  frequencyHz: number;
  /** Provenance: measured queue, observed zero queue, or no queue telemetry. */
  mode: "measured" | "zero" | "unavailable";
}

/** Hard cap on jitter amplitude — vibration must read as a tremor, not a shake. */
export const VIBRATION_MAX_AMPLITUDE = 0.035;
/** Hard cap on jitter frequency in Hz. */
export const VIBRATION_MAX_FREQUENCY_HZ = 9;

/**
 * Map a queued-job count to a vibration (tremor) for the atom.
 *
 * Shape (fixed — the tests pin it):
 * ```
 * const q = Math.max(0, queuedJobs);
 * const amplitude = Math.min(0.035, 0.006 * Math.sqrt(q));
 * const frequencyHz = Math.min(9, 1.5 + 0.55 * q);
 * ```
 *
 * - `queuedJobs === 0` → mode `"zero"`, amplitude `0`.
 * - `null` / `undefined` → mode `"unavailable"`, amplitude `0`.
 * - Negative counts are clamped to zero (defensive; the domain never emits them).
 */
export function queueVibration(queuedJobs: number | null | undefined): VibrationResult {
  if (queuedJobs == null) {
    return { amplitude: 0, frequencyHz: 0, mode: "unavailable" };
  }
  const q = Math.max(0, queuedJobs);
  if (q === 0) {
    return { amplitude: 0, frequencyHz: 0, mode: "zero" };
  }
  const amplitude = Math.min(0.035, 0.006 * Math.sqrt(q));
  const frequencyHz = Math.min(9, 1.5 + 0.55 * q);
  return { amplitude, frequencyHz, mode: "measured" };
}

/* ------------------------------------------------------------------ */
/* Easing — shared rate-limit for value transitions                     */
/* ------------------------------------------------------------------ */

/**
 * Ease `current` toward `target` over a wall-clock delta, clamped so the
 * transition time stays inside [minMs, maxMs] (default 250–600ms).
 *
 * Pure: given the same inputs it always returns the same result. The caller
 * feeds it `performance.now()` deltas; it never reads a clock itself.
 *
 * @param current  the value on the previous frame.
 * @param target   the value to ease toward (e.g. a spin speed from {@link spinRadiansPerSecond}).
 * @param deltaMs  elapsed milliseconds since the last frame (≥ 0).
 * @param minMs    shortest allowed transition time (default 250).
 * @param maxMs    longest allowed transition time (default 600).
 */
export function easeRate(
  current: number,
  target: number,
  deltaMs: number,
  minMs = 250,
  maxMs = 600
): number {
  const clampedDelta = Math.max(0, deltaMs);
  const minTransition = minMs > 0 ? minMs : 250;
  const maxTransition = maxMs >= minTransition ? maxMs : minTransition;
  const transitionMs = Math.min(maxTransition, Math.max(minTransition, clampedDelta));
  // Linear ease-in clamped to [0, 1]: deterministic, no overshoot, and fully
  // arrives at `target` once the accumulated delta reaches the (≤ maxMs)
  // transition window.
  const t = transitionMs === 0 ? 0 : Math.min(1, clampedDelta / transitionMs);
  if (t >= 1) return target; // snap exactly on full arrival (no float residue)
  if (t <= 0) return current;
  return current + (target - current) * t;
}

/* ------------------------------------------------------------------ */
/* Health / traffic → visual state (mirrors the 2D edgeStyles rules)    */
/* ------------------------------------------------------------------ */

/**
 * Composed visual states, in precedence order (matches `edgeStyles.ts`):
 * error > active > last-used > healthy > idle.
 */
export type AtomicVisualState = "error" | "active" | "last" | "healthy" | "idle";

/**
 * Map a state's stroke `width` (CSS-ish units, from {@link VISUAL_STATE_STYLE})
 * to a 3D link tube radius in world units (OR-ATOM-002, V4).
 *
 * The 2D stroke width is a *relative* emphasis scale, so the 3D mapping keeps
 * that ordering (idle < last/healthy < error < active) while scaling to a
 * readable world size, clamped to a sane band so a route never reads as a
 * "wide opaque pipe" (idle) nor vanishes (active). Pure + total: same width →
 * same radius; non-finite input clamps to the idle (minimum) radius.
 */
export function linkTubeRadius(width: number, base: number = 3): number {
  const w = Number.isFinite(width) ? Math.max(0, width) : 0;
  const radius = base * w; // idle(1)→3, last/healthy(1.5)→4.5, error(2)→6, active(2.5)→7.5
  return Math.min(Math.max(radius, LINK_TUBE_MIN_RADIUS), LINK_TUBE_MAX_RADIUS);
}

/** Lower clamp for a link tube radius (world units) — a route never vanishes. */
export const LINK_TUBE_MIN_RADIUS = 1.6;
/** Upper clamp for a link tube radius (world units) — a route never becomes a pipe. */
export const LINK_TUBE_MAX_RADIUS = 9;

/** Per-state stroke parameters mirroring `edgeStyles.edgeStyle` (w = width, op = opacity). */
export const VISUAL_STATE_STYLE: Record<
  AtomicVisualState,
  { width: number; opacity: number; animated: boolean }
> = {
  error: { width: 2, opacity: 0.85, animated: false },
  active: { width: 2.5, opacity: 1, animated: true },
  last: { width: 1.5, opacity: 0.6, animated: false },
  healthy: { width: 1.5, opacity: 0.4, animated: false },
  idle: { width: 1, opacity: 0.3, animated: false },
};

/**
 * Input to {@link resolveVisualState}. Health and traffic are separate
 * dimensions (see `src/shared/topology/domain/types.ts`): `health` is the
 * connection state, `traffic` is in-flight/recency, `latestErrorAt` is the
 * last observed error timestamp (an error is traffic-shaped evidence, not a
 * connection verdict).
 */
export interface AtomicVisualStateInput {
  /** Connection health (base state). */
  health: HealthState;
  /** In-flight / recency traffic state. */
  traffic: TrafficState;
  /** Epoch ms of the last observed error, or `null`/absent when none sampled. */
  latestErrorAt?: number | null;
}

/**
 * Resolve the composed visual state for an atom/link.
 *
 * Precedence (mirrors the 2D `edgeStyles` semantics):
 *   1. `error`   — an error was observed (`latestErrorAt` present) or the
 *                  connection is `unhealthy`.
 *   2. `active`  — live in-flight traffic.
 *   3. `last`    — recent traffic (last-used).
 *   4. `healthy` — connected, no traffic signals.
 *   5. `idle`    — everything else (unknown health, no traffic).
 *
 * Pure + total: every input combination yields exactly one state, and the
 * result always carries the stroke parameters from {@link VISUAL_STATE_STYLE}.
 */
export function resolveVisualState(input: AtomicVisualStateInput): {
  state: AtomicVisualState;
  style: { width: number; opacity: number; animated: boolean };
} {
  const errored = input.health === "unhealthy" || (input.latestErrorAt ?? null) != null;
  let state: AtomicVisualState;
  if (errored) state = "error";
  else if (input.traffic === "active") state = "active";
  else if (input.traffic === "recent") state = "last";
  else if (input.health === "healthy") state = "healthy";
  else state = "idle";
  return { state, style: VISUAL_STATE_STYLE[state] };
}
