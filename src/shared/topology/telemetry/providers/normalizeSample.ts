/**
 * Fleet telemetry — metric sample → `Observed<number>` normalization
 * (OR-ATOM-005 / Step 5).
 *
 * Shared by the prometheus / influxdb2 / grafana adapters. Enforces the
 * data-semantics the task requires:
 *   - a PRESENT zero is a real measurement (kept, with provenance);
 *   - a MISSING sample is `null` (unknown) — never a fabricated zero;
 *   - monotonic counters become a windowed rate (delta / seconds);
 *   - sample timestamps are validated (finite, not in the future);
 *   - samples older than the freshness window are marked `stale`;
 *   - units are validated (percent in [0,100], non-negative for counts).
 */

import type { Observed } from "../types";

export interface NormalizeSampleInput {
  /** The numeric sample; `null`/`undefined`/non-finite → unknown (null). */
  value: unknown;
  /** Provenance source of the sample. */
  source: "prometheus" | "influxdb2" | "grafana" | "derived";
  /** Epoch ms of the sample. */
  sampledAt: number;
  /** Epoch ms of the snapshot capture. */
  capturedAt: number;
  /** Sampling interval, when known (drives the stale rule). */
  windowMs?: number;
  /** Provenance tag (single token, no credential shape). */
  basis: string;
  /** Freshness window in ms; samples older than this are marked stale. */
  freshnessMs: number;
  /** Unit guard, when applicable. */
  unit?: "percent" | "nonNegative" | "bytes" | "celsius" | "watts" | "tps";
}

/** Validate + clamp a unit. Returns the value or `null` when invalid. */
function guardUnit(value: number, unit: NormalizeSampleInput["unit"]): number | null {
  if (unit === "percent") return value >= 0 && value <= 100 ? value : null;
  if (unit === "nonNegative") return value >= 0 ? value : null;
  if (unit === "bytes") return value >= 0 ? value : null;
  if (unit === "celsius") return value > -273 ? value : null;
  if (unit === "watts") return value >= 0 ? value : null;
  if (unit === "tps") return value >= 0 ? value : null;
  return value;
}

/** True when a sample older than `freshnessMs` should be marked stale. */
export function isStaleSample(sampledAt: number, capturedAt: number, freshnessMs: number): boolean {
  if (!Number.isFinite(sampledAt) || !Number.isFinite(capturedAt)) return true;
  return capturedAt - sampledAt > freshnessMs;
}

/**
 * Normalize one numeric sample into an `Observed<number>`.
 *
 * - non-finite / missing → `{ value: null }` (unknown), never a zero.
 * - a present zero → `{ value: 0 }` (a real measurement).
 * - stale samples keep their value but set `stale: true` (the gateway's
 *   `neutralizeStale` later decays them to null if desired).
 */
export function normalizeSample(input: NormalizeSampleInput): Observed<number> {
  const base: Observed<number> = {
    value: null,
    source: input.source,
    sampledAt: Number.isFinite(input.sampledAt) ? input.sampledAt : input.capturedAt,
    basis: input.basis,
  };
  if (input.windowMs != null && Number.isFinite(input.windowMs) && input.windowMs > 0) {
    base.windowMs = input.windowMs;
  }

  const v = input.value;
  const isNum = typeof v === "number";
  if (!isNum || !Number.isFinite(v)) {
    // Missing / non-finite → unknown. Still mark stale if the sample itself is
    // ancient (provenance says "we saw nothing recent").
    if (isStaleSample(base.sampledAt, input.capturedAt, input.freshnessMs)) {
      base.stale = true;
    }
    return base;
  }

  const guarded = guardUnit(v, input.unit);
  base.value = guarded ?? null;
  if (guarded === null) {
    // A present but out-of-unit sample is not a valid measurement → unknown.
    if (isStaleSample(base.sampledAt, input.capturedAt, input.freshnessMs)) {
      base.stale = true;
    }
    return base;
  }
  if (isStaleSample(base.sampledAt, input.capturedAt, input.freshnessMs)) {
    base.stale = true;
  }
  return base;
}

export interface CounterRateInput {
  /** Current counter reading. */
  value: number;
  /** Prior counter reading (from the previous snapshot window). */
  previous?: number;
  /** Seconds elapsed between the two readings. */
  deltaSeconds: number;
  sampledAt: number;
  capturedAt: number;
  windowMs?: number;
  source: "prometheus" | "influxdb2" | "grafana" | "derived";
  basis: string;
  freshnessMs: number;
}

/**
 * Convert a monotonic counter into a windowed rate (delta / seconds). A counter
 * reset (previous > value) is treated as a reset → rate is `null` (unknown),
 * never a negative. A zero elapsed window is unknown. A present zero delta is
 * a real `0` rate.
 */
export function counterRate(input: CounterRateInput): Observed<number> {
  const base: Observed<number> = {
    value: null,
    source: input.source,
    sampledAt: Number.isFinite(input.sampledAt) ? input.sampledAt : input.capturedAt,
    basis: input.basis,
  };
  if (input.windowMs != null && Number.isFinite(input.windowMs) && input.windowMs > 0) {
    base.windowMs = input.windowMs;
  }
  if (
    !Number.isFinite(input.value) ||
    !Number.isFinite(input.deltaSeconds) ||
    input.deltaSeconds <= 0
  ) {
    if (isStaleSample(base.sampledAt, input.capturedAt, input.freshnessMs)) base.stale = true;
    return base;
  }
  // No prior reading → cannot compute a rate → unknown (not zero).
  if (input.previous == null || !Number.isFinite(input.previous)) {
    if (isStaleSample(base.sampledAt, input.capturedAt, input.freshnessMs)) base.stale = true;
    return base;
  }
  const delta = input.value - input.previous;
  if (delta < 0) {
    // Counter reset → unknown.
    if (isStaleSample(base.sampledAt, input.capturedAt, input.freshnessMs)) base.stale = true;
    return base;
  }
  base.value = delta / input.deltaSeconds;
  if (isStaleSample(base.sampledAt, input.capturedAt, input.freshnessMs)) base.stale = true;
  return base;
}
