/**
 * Atomic topology — visual encoding: unavailable/neutral values and
 * event-free outputs (OR-ATOM-001 v2, T006a / M3 Phase A).
 *
 * Complements (does not duplicate) the in-place `visualEncoding.test.ts`,
 * which pins the exact lane hues, the model-color seeding, and the
 * spin/vibration curve shapes over their measured ranges. This file pins
 * the *other* half of the contract:
 *   - the unavailable/neutral branches (no telemetry sampled → never a
 *     fabricated rate or queue), and that "unavailable" is deliberately
 *     indistinguishable from an observed quiet value;
 *   - the full visual-state precedence ordering (error > active > last >
 *     healthy > idle) and the exact per-state stroke styles;
 *   - the event-free, constants-only nature of `eventPool.ts` (Phase A ships
 *     bounded constants + the dedupe-key contract, no runtime pool).
 *
 * No `three`, no DOM, no Math.random — every value here is a pure
 * deterministic function of its inputs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  spinRadiansPerSecond,
  queueVibration,
  easeRate,
  resolveVisualState,
  VISUAL_STATE_STYLE,
  UNKNOWN_MODEL_COLOR,
  LANE_HUES,
  laneHue,
  modelColor,
  asJobLane,
  VIBRATION_MAX_AMPLITUDE,
  VIBRATION_MAX_FREQUENCY_HZ,
} from "@/plugins/atomic-topology/visualEncoding";
import type { JobLane } from "@/plugins/atomic-topology/visualEncoding";
import {
  ATOMIC_EVENT_POOL_CAPACITY,
  ATOMIC_EVENT_HIGH_WATERMARK,
  ATOMIC_EVENT_MAX_AGE_MS,
} from "@/plugins/atomic-topology/eventPool";

/* ------------------------------------------------------------------ */
/* Spin — unavailable/neutral branches                                 */
/* ------------------------------------------------------------------ */

test("spinRadiansPerSecond: unavailable is the neutral floor 0.10 for ANY reference (incl. 0/negative)", () => {
  // No telemetry sampled → the neutral slow value, independent of the
  // reference (the reference only matters once a rate is measured).
  for (const reference of [0, -5, 0.5, 100, 1000]) {
    assert.deepEqual(spinRadiansPerSecond(null, reference), { value: 0.1, mode: "unavailable" });
    assert.deepEqual(spinRadiansPerSecond(undefined, reference), {
      value: 0.1,
      mode: "unavailable",
    });
  }
});

test("spinRadiansPerSecond: 'unavailable' is indistinguishable from 'measured-zero' on purpose", () => {
  // We do not assert what we did not observe — an unsampled rate and an
  // observed quiet both land on the same neutral 0.10 rad/s (only the
  // provenance tag differs, so a renderer can treat them identically).
  assert.equal(spinRadiansPerSecond(null, 100).value, spinRadiansPerSecond(0, 100).value);
  assert.equal(spinRadiansPerSecond(null, 100).value, 0.1);
  assert.notEqual(spinRadiansPerSecond(null, 100).mode, spinRadiansPerSecond(0, 100).mode);
});

test("spinRadiansPerSecond: the measured floor is exactly 0.10 and the ceiling 0.10 + 1.65", () => {
  assert.equal(spinRadiansPerSecond(0, 100).value, 0.1, "measured-zero sits on the floor");
  assert.equal(
    spinRadiansPerSecond(100, 100).value,
    1.75,
    "at reference the measured target saturates at the ceiling"
  );
});

/* ------------------------------------------------------------------ */
/* Vibration — unavailable/neutral branches                            */
/* ------------------------------------------------------------------ */

test("queueVibration: unavailable and zero both yield amplitude 0, frequency 0", () => {
  assert.deepEqual(queueVibration(null), { amplitude: 0, frequencyHz: 0, mode: "unavailable" });
  assert.deepEqual(queueVibration(undefined), {
    amplitude: 0,
    frequencyHz: 0,
    mode: "unavailable",
  });
  assert.deepEqual(queueVibration(0), { amplitude: 0, frequencyHz: 0, mode: "zero" });
  assert.deepEqual(
    queueVibration(-3),
    { amplitude: 0, frequencyHz: 0, mode: "zero" },
    "negatives clamp to zero"
  );
});

test("queueVibration: measured values never exceed the hard caps", () => {
  for (const q of [1, 4, 9, 34, 35, 1000, 100000]) {
    const { amplitude, frequencyHz, mode } = queueVibration(q);
    assert.equal(mode, "measured");
    assert.ok(amplitude <= VIBRATION_MAX_AMPLITUDE, `amplitude ${amplitude} > cap at q=${q}`);
    assert.ok(
      frequencyHz <= VIBRATION_MAX_FREQUENCY_HZ,
      `frequency ${frequencyHz} > cap at q=${q}`
    );
    assert.ok(amplitude > 0 && frequencyHz > 0, "a measured queue always moves");
  }
});

test("queueVibration: frequency saturates at the cap before amplitude does", () => {
  // 1.5 + 0.55*q reaches 9 at q≈13.6 → q=14 is the first measured frequency
  // at the cap, while its amplitude is still well below the amplitude cap.
  const atFourteen = queueVibration(14);
  assert.equal(atFourteen.frequencyHz, VIBRATION_MAX_FREQUENCY_HZ);
  assert.ok(
    atFourteen.amplitude < VIBRATION_MAX_AMPLITUDE,
    "frequency hits the cap before amplitude"
  );
  // And amplitude eventually saturates exactly at the cap (q=35 → 0.006*6=0.036>cap).
  assert.equal(queueVibration(35).amplitude, VIBRATION_MAX_AMPLITUDE);
});

/* ------------------------------------------------------------------ */
/* easeRate — the neutral/edge branches (complementary to the curve)     */
/* ------------------------------------------------------------------ */

test("easeRate: a full transition (delta ≥ maxMs) snaps to the exact target", () => {
  assert.equal(easeRate(0.1, 1.75, 600), 1.75);
  assert.equal(easeRate(1.75, 0.1, 600), 0.1);
  assert.equal(easeRate(0, 1, 999_999), 1, "a very large delta also lands exactly");
});

test("easeRate: negative deltas are treated as zero (stay put, never move backward)", () => {
  assert.equal(easeRate(0.5, 1.75, -100), 0.5);
  assert.equal(easeRate(0.5, 1.75, -1), 0.5);
});

/* ------------------------------------------------------------------ */
/* resolveVisualState — full precedence ordering                        */
/* ------------------------------------------------------------------ */

test("resolveVisualState: error outranks everything (unhealthy OR any latestErrorAt)", () => {
  for (const traffic of ["active", "recent", "idle"] as const) {
    assert.equal(resolveVisualState({ health: "unhealthy", traffic }).state, "error");
    assert.equal(
      resolveVisualState({ health: "healthy", traffic, latestErrorAt: 123 }).state,
      "error"
    );
    // A timestamp of 0 is "present" (absent ≠ zero): still an error.
    assert.equal(
      resolveVisualState({ health: "unknown", traffic, latestErrorAt: 0 }).state,
      "error"
    );
  }
});

test("resolveVisualState: active outranks last, which outranks the base health states", () => {
  assert.equal(resolveVisualState({ health: "unknown", traffic: "active" }).state, "active");
  assert.equal(resolveVisualState({ health: "healthy", traffic: "active" }).state, "active");
  assert.equal(resolveVisualState({ health: "unknown", traffic: "recent" }).state, "last");
  assert.equal(resolveVisualState({ health: "healthy", traffic: "recent" }).state, "last");
});

test("resolveVisualState: with no traffic signal, health decides (healthy > idle)", () => {
  assert.equal(resolveVisualState({ health: "healthy", traffic: "idle" }).state, "healthy");
  assert.equal(resolveVisualState({ health: "unknown", traffic: "idle" }).state, "idle");
  assert.equal(
    resolveVisualState({ health: "unknown", traffic: "idle", latestErrorAt: null }).state,
    "idle"
  );
});

test("VISUAL_STATE_STYLE: exact stroke parameters for all five states", () => {
  assert.deepEqual(VISUAL_STATE_STYLE, {
    error: { width: 2, opacity: 0.85, animated: false },
    active: { width: 2.5, opacity: 1, animated: true },
    last: { width: 1.5, opacity: 0.6, animated: false },
    healthy: { width: 1.5, opacity: 0.4, animated: false },
    idle: { width: 1, opacity: 0.3, animated: false },
  });
  // resolveVisualState always returns the matching style object by reference.
  const { style } = resolveVisualState({ health: "unknown", traffic: "idle" });
  assert.equal(style, VISUAL_STATE_STYLE.idle);
});

/* ------------------------------------------------------------------ */
/* Lane / model color — neutral branches                               */
/* ------------------------------------------------------------------ */

test("modelColor: blank/whitespace ids resolve to the neutral unknown-model gray", () => {
  assert.equal(modelColor(""), UNKNOWN_MODEL_COLOR);
  assert.equal(modelColor("   "), UNKNOWN_MODEL_COLOR);
  assert.equal(UNKNOWN_MODEL_COLOR, "#64748B");
  // Distinct from the unknown *lane* hue (missing datum ≠ unknown lane).
  assert.notEqual(UNKNOWN_MODEL_COLOR, LANE_HUES.unknown);
});

test("laneHue: every JobLane resolves to a hue, and image shares the vision hue", () => {
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
  for (const lane of lanes) assert.match(laneHue(lane), /^#[0-9A-F]{6}$/i);
  assert.equal(laneHue("image"), laneHue("vision"));
});

test("asJobLane: a domain TopologyLane flows into a JobLane field unchanged (pure cast)", () => {
  for (const lane of ["embedding", "rerank", "vision", "image", "audio", "unknown"] as const) {
    assert.equal(asJobLane(lane), lane);
  }
});

/* ------------------------------------------------------------------ */
/* eventPool — event-free neutral output (constants only, Phase A)      */
/* ------------------------------------------------------------------ */

test("eventPool: bounded capacity + high-watermark + max-age constants (no runtime pool in Phase A)", () => {
  assert.equal(ATOMIC_EVENT_POOL_CAPACITY, 512);
  assert.equal(ATOMIC_EVENT_HIGH_WATERMARK, Math.floor(512 * 0.875));
  assert.equal(ATOMIC_EVENT_HIGH_WATERMARK, 448);
  assert.ok(ATOMIC_EVENT_HIGH_WATERMARK < ATOMIC_EVENT_POOL_CAPACITY, "HWM sheds before capacity");
  assert.equal(ATOMIC_EVENT_MAX_AGE_MS, 60_000, "60s stale-drop window");
  assert.equal(ATOMIC_EVENT_MAX_AGE_MS, 1 * 60 * 1000);
});
