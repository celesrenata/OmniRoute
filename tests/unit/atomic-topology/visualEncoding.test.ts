/**
 * Atomic topology — pure visual-encoding rules
 * (OR-ATOM-001 v2, T006a / M3 Phase A).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LANE_HUES,
  laneHue,
  modelColor,
  spinRadiansPerSecond,
  queueVibration,
  easeRate,
  resolveVisualState,
  VISUAL_STATE_STYLE,
  VIBRATION_MAX_AMPLITUDE,
  VIBRATION_MAX_FREQUENCY_HZ,
  UNKNOWN_MODEL_COLOR,
} from "@/plugins/atomic-topology/visualEncoding";
import type { JobLane } from "@/plugins/atomic-topology/visualEncoding";

/* ------------------------------------------------------------------ */
/* Lane hues                                                            */
/* ------------------------------------------------------------------ */

test("LANE_HUES pins the exact per-lane hue values (all 10 lanes incl. unknown)", () => {
  assert.deepEqual(LANE_HUES, {
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
  });
});

test("laneHue maps every JobLane, and image shares the vision hue", () => {
  const lanes: JobLane[] = [
    "chat",
    "prefill",
    "decode",
    "embedding",
    "rerank",
    "vision",
    "image",
    "audio",
    "system",
    "unknown",
  ];
  for (const lane of lanes) {
    assert.match(laneHue(lane), /^#[0-9A-F]{6}$/i);
  }
  assert.equal(laneHue("image"), laneHue("vision"));
  assert.equal(laneHue("unknown"), "#94A3B8");
});

/* ------------------------------------------------------------------ */
/* modelColor — seeded, deterministic, case-insensitive                 */
/* ------------------------------------------------------------------ */

test("modelColor is deterministic: same id → same color (incl. case-insensitive canonicalization)", () => {
  const a = modelColor("gpt-4o");
  assert.equal(modelColor("gpt-4o"), a);
  assert.equal(modelColor("GPT-4O"), a);
  assert.equal(modelColor("gpt-4o\n"), a);
  assert.equal(modelColor("  gpt-4o  "), a);
  assert.match(a, /^#[0-9A-F]{6}$/);
});

test("modelColor: empty/blank ids resolve to UNKNOWN_MODEL_COLOR", () => {
  assert.equal(UNKNOWN_MODEL_COLOR, "#64748B");
  assert.equal(modelColor(""), UNKNOWN_MODEL_COLOR);
  assert.equal(modelColor("   "), UNKNOWN_MODEL_COLOR);
  assert.notEqual(UNKNOWN_MODEL_COLOR, LANE_HUES.unknown, "must differ from the lane unknown hue");
});

test("modelColor: different ids spread across distinct colors", () => {
  const ids = [
    "gpt-4o",
    "claude-3-5-sonnet",
    "gemini-2.0-flash",
    "llama-3.3-70b",
    "mistral-large",
    "grok-2",
    "qwen-3-235b",
    "deepseek-v3",
    "phi-4",
    "cohere-command-r",
    "openrouter-auto",
    "grok-2-121b",
    "claude-opus-4",
    "gpt-4.1",
    "gemini-ultra",
    "llama-4-maverick",
  ];
  const colors = new Set(ids.map((id) => modelColor(id)));
  assert.ok(
    colors.size >= 12,
    `expected at least 12 distinct colors across ${ids.length} ids, got ${colors.size}`
  );
  for (const color of colors) {
    assert.match(color, /^#[0-9A-F]{6}$/);
  }
});

/* ------------------------------------------------------------------ */
/* spinRadiansPerSecond — curve, modes, clamping                        */
/* ------------------------------------------------------------------ */

test("spinRadiansPerSecond: null/undefined → unavailable, neutral slow 0.10", () => {
  assert.deepEqual(spinRadiansPerSecond(null, 100), { value: 0.1, mode: "unavailable" });
  assert.deepEqual(spinRadiansPerSecond(undefined, 100), { value: 0.1, mode: "unavailable" });
});

test("spinRadiansPerSecond: 0 TPS → measured-zero, exactly 0.10", () => {
  assert.deepEqual(spinRadiansPerSecond(0, 100), { value: 0.1, mode: "measured-zero" });
});

test("spinRadiansPerSecond: measured mode is monotonic non-decreasing in [0, referenceTPS]", () => {
  const reference = 120;
  let previous = -Infinity;
  for (let tps = 0; tps <= reference; tps += 0.5) {
    const { value, mode } = spinRadiansPerSecond(tps, reference);
    assert.ok(value >= 0.1, `spin must never drop below 0.10 (got ${value} at ${tps})`);
    assert.ok(value <= 1.75 + 1e-9, `spin must never exceed 0.10 + 1.65 (got ${value} at ${tps})`);
    assert.ok(value >= previous, `spin must be monotonic: ${value} < ${previous} at ${tps}`);
    previous = value;
    if (tps > 0) assert.equal(mode, "measured");
  }
  const atReference = spinRadiansPerSecond(reference, reference);
  assert.equal(atReference.mode, "measured");
  assert.ok(
    Math.abs(atReference.value - 1.75) < 1e-9,
    "at referenceTPS the target saturates at 1.75"
  );
});

test("spinRadiansPerSecond: clamps above referenceTPS and below zero input", () => {
  const reference = 50;
  const saturated = spinRadiansPerSecond(reference, reference).value;
  assert.equal(
    spinRadiansPerSecond(reference * 10, reference).value,
    saturated,
    "above reference → clamped"
  );
  assert.equal(
    spinRadiansPerSecond(-20, reference).value,
    0.1,
    "negative TPS clamps to the 0.10 floor"
  );
  assert.equal(spinRadiansPerSecond(-20, reference).mode, "measured");
});

/* ------------------------------------------------------------------ */
/* queueVibration — bounds and modes                                    */
/* ------------------------------------------------------------------ */

test("queueVibration: null/undefined → unavailable, amplitude 0", () => {
  assert.deepEqual(queueVibration(null), { amplitude: 0, frequencyHz: 0, mode: "unavailable" });
  assert.deepEqual(queueVibration(undefined), {
    amplitude: 0,
    frequencyHz: 0,
    mode: "unavailable",
  });
});

test("queueVibration: 0 → zero mode, amplitude 0", () => {
  assert.equal(queueVibration(0).mode, "zero");
  assert.equal(queueVibration(0).amplitude, 0);
});

test("queueVibration: amplitude ≤ 0.035, frequency ≤ 9, monotonic growth then saturation", () => {
  let previousAmp = -Infinity;
  let previousFreq = -Infinity;
  for (let q = 1; q <= 2000; q += 1) {
    const { amplitude, frequencyHz, mode } = queueVibration(q);
    assert.equal(mode, "measured");
    assert.ok(amplitude <= VIBRATION_MAX_AMPLITUDE, `amplitude ${amplitude} exceeds cap at q=${q}`);
    assert.ok(
      frequencyHz <= VIBRATION_MAX_FREQUENCY_HZ,
      `frequency ${frequencyHz} exceeds cap at q=${q}`
    );
    assert.ok(amplitude >= previousAmp, "amplitude must not decrease");
    assert.ok(frequencyHz >= previousFreq, "frequency must not decrease");
    previousAmp = amplitude;
    previousFreq = frequencyHz;
  }
  const saturated = queueVibration(10_000);
  assert.equal(saturated.amplitude, 0.035, "large queues saturate the amplitude cap");
  assert.equal(saturated.frequencyHz, 9, "large queues saturate the frequency cap");
});

test("queueVibration: negative inputs clamp to the zero mode", () => {
  assert.deepEqual(queueVibration(-3), { amplitude: 0, frequencyHz: 0, mode: "zero" });
});

/* ------------------------------------------------------------------ */
/* easeRate — 250–600ms transition easing                               */
/* ------------------------------------------------------------------ */

test("easeRate: zero/negative delta is a no-op (stays at current)", () => {
  assert.equal(easeRate(0.1, 1.75, 0), 0.1);
  assert.equal(easeRate(0.1, 1.75, -50), 0.1);
});

test("easeRate: moves toward target, monotonic, and lands exactly at target past maxMs", () => {
  const start = 0.1;
  const target = 1.75;
  let previous = start;
  for (const deltaMs of [10, 50, 250, 600, 601, 1200]) {
    const next = easeRate(previous, target, deltaMs);
    assert.ok(next >= previous, `must not move away from target (got ${next} from ${previous})`);
    assert.ok(next <= target, `must not overshoot target (got ${next})`);
    previous = next;
  }
  assert.equal(easeRate(0.1, 1.75, 600), 1.75, "at maxMs (600) the transition is complete");
  assert.equal(easeRate(1.75, 0.1, 600), 0.1, "works toward lower targets too");
});

test("easeRate: respects custom min/max bounds", () => {
  assert.ok(easeRate(0, 1, 50, 50, 50) > 0, "moves with a tiny window");
  assert.equal(easeRate(0, 1, 50, 50, 50), 1, "delta at maxMs lands exactly on target");
});

/* ------------------------------------------------------------------ */
/* resolveVisualState — precedence error > active > last > healthy > idle */
/* ------------------------------------------------------------------ */

test("resolveVisualState: unhealthy health → error regardless of traffic", () => {
  const { state } = resolveVisualState({ health: "unhealthy", traffic: "idle" });
  assert.equal(state, "error");
});

test("resolveVisualState: latestErrorAt present → error, even with active traffic (error > active)", () => {
  const { state } = resolveVisualState({
    health: "healthy",
    traffic: "active",
    latestErrorAt: 1_700_000_000_000,
  });
  assert.equal(state, "error");
});

test("resolveVisualState: active traffic (no error) → active", () => {
  assert.equal(resolveVisualState({ health: "healthy", traffic: "active" }).state, "active");
  assert.equal(resolveVisualState({ health: "unknown", traffic: "active" }).state, "active");
});

test("resolveVisualState: recent traffic → last", () => {
  assert.equal(resolveVisualState({ health: "healthy", traffic: "recent" }).state, "last");
});

test("resolveVisualState: healthy + idle → healthy; unknown + idle → idle", () => {
  assert.equal(resolveVisualState({ health: "healthy", traffic: "idle" }).state, "healthy");
  assert.equal(resolveVisualState({ health: "unknown", traffic: "idle" }).state, "idle");
});

test("resolveVisualState: latestErrorAt null/absent is not an error (no fabricated telemetry)", () => {
  assert.equal(
    resolveVisualState({ health: "healthy", traffic: "idle", latestErrorAt: null }).state,
    "healthy"
  );
  assert.equal(resolveVisualState({ health: "healthy", traffic: "idle" }).state, "healthy");
});

test("VISUAL_STATE_STYLE mirrors the 2D edgeStyle parameters per state", () => {
  assert.deepEqual(VISUAL_STATE_STYLE.error, { width: 2, opacity: 0.85, animated: false });
  assert.deepEqual(VISUAL_STATE_STYLE.active, { width: 2.5, opacity: 1, animated: true });
  assert.deepEqual(VISUAL_STATE_STYLE.last, { width: 1.5, opacity: 0.6, animated: false });
  assert.deepEqual(VISUAL_STATE_STYLE.healthy, { width: 1.5, opacity: 0.4, animated: false });
  assert.deepEqual(VISUAL_STATE_STYLE.idle, { width: 1, opacity: 0.3, animated: false });
});
