/**
 * Unit tests for the pure nucleus motion helpers (OR-ATOM-009, Phase 2 W2) —
 * `src/plugins/atomic-topology/scene/nucleusMotion.ts`.
 *
 * Runner: `node --import tsx/esm --test` (node:test + assert; the module is
 * pure — no `three`, no DOM, no wall clock).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fnv1a } from "../../../src/plugins/atomic-topology/scene/cloudShells";
import {
  buildModelGroupSlots,
  createQueueVibration,
  createRotationSmoothing,
  NUCLEUS_SMOOTH_TAU_SECONDS,
  NUCLEUS_SPIN_MAX_RAD_PER_SECOND,
  NUCLEUS_SPIN_MIN_RAD_PER_SECOND,
  NUCLEUS_SPIN_SATURATION_TPS,
  QUEUE_VIBRATION_MAX_AMPLITUDE,
  tpsToRadiansPerSecond,
  type QueueVibrationPhase,
} from "../../../src/plugins/atomic-topology/scene/nucleusMotion";

const TAU = NUCLEUS_SMOOTH_TAU_SECONDS;

/* ------------------------------------------------------------------ */
/* createRotationSmoothing                                             */
/* ------------------------------------------------------------------ */

test("rotation smoothing: default tau sits in the ~1 s band (documented vs telemetry cadence)", () => {
  assert.ok(
    TAU > 0.5 && TAU < 2.0,
    `tau ${TAU}s must sit in the ~1 s band (fresh samples blend ~97 % at the 3.5 s poll, stale gaps decay to ~3 %)`
  );
  assert.equal(NUCLEUS_SMOOTH_TAU_SECONDS, 1.0);
});

test("rotation smoothing: first non-null sample is adopted exactly (no jump)", () => {
  const smoother = createRotationSmoothing();
  assert.equal(smoother.state.current, 0);
  assert.equal(smoother.state.primed, false);
  assert.equal(smoother.step(42, 0.16), 42);
  assert.equal(smoother.state.primed, true);
  assert.equal(smoother.state.current, 42);
});

test("rotation smoothing: null decays toward 0 with the same time constant", () => {
  const smoother = createRotationSmoothing();
  smoother.step(100, 0.0); // adopt 100 exactly
  const one = smoother.step(null, TAU); // one full tau → e^-1
  assert.ok(
    Math.abs(one - 100 * Math.exp(-1)) < 1e-9,
    `after one tau: got ${one}, expected ${100 * Math.exp(-1)}`
  );
  const three = smoother.step(null, 2 * TAU); // total 3 tau → e^-3
  assert.ok(Math.abs(three - 100 * Math.exp(-3)) < 1e-9, `after 3 tau: got ${three}`);
  const tail = smoother.step(null, 10 * TAU); // cumulative 13 tau → e^-13
  assert.ok(
    tail > 0 && tail < 3e-4,
    `stale data must keep decaying toward 0 (got ${tail}), never hold a fake speed`
  );
  assert.ok(
    Math.abs(tail - 100 * Math.exp(-13)) < 1e-9,
    `decay after 13 tau: got ${tail}, expected ${100 * Math.exp(-13)}`
  );
});

test("rotation smoothing: null before priming never invents a speed", () => {
  const smoother = createRotationSmoothing();
  assert.equal(smoother.step(null, 1.0), 0);
  assert.equal(smoother.state.primed, false, "null must not prime the smoother");
});

test("rotation smoothing: monotonic approach — never overshoots the measured value", () => {
  const smoother = createRotationSmoothing();
  smoother.step(10, 0.0); // adopt a lower value exactly
  const target = 50;
  let previous = smoother.state.current;
  for (let i = 0; i < 50; i += 1) {
    const v = smoother.step(target, 0.05);
    assert.ok(v > previous, `step ${i}: expected approach upward (${v} > ${previous})`);
    assert.ok(v <= target, `step ${i}: no overshoot (${v} <= ${target})`);
    previous = v;
  }
  assert.ok(previous < target, "EMA approaches but never equals an unchanged target");
  // A downward step approaches downward, symmetrically.
  const down = smoother.step(0, 0.05);
  assert.ok(down < previous && down > 0, "decays toward 0 monotonically downward");
});

test("rotation smoothing: dt-independence — two small steps ≈ one large step", () => {
  const a = createRotationSmoothing();
  const b = createRotationSmoothing();
  a.step(20, 0.0); // adopt
  b.step(20, 0.0); // adopt

  // Single large step of total dt.
  const total = (3 * TAU) / 2;
  const one = a.step(80, total);
  // Two half-steps with the same total dt (exponential kernel → exact).
  const half = total / 2;
  let two = b.step(80, half);
  two = b.step(80, half);

  assert.ok(
    Math.abs(one - two) < 1e-9,
    `dt-independence: one step of ${total}s gave ${one}, two of ${half}s gave ${two}`
  );

  // Same for the decay path (null sample).
  const c = createRotationSmoothing();
  const d = createRotationSmoothing();
  c.step(60, 0.0);
  d.step(60, 0.0);
  const decayOne = c.step(null, total);
  let decayTwo = d.step(null, half);
  decayTwo = d.step(null, half);
  assert.ok(
    Math.abs(decayOne - decayTwo) < 1e-9,
    `decay dt-independence: ${decayOne} vs ${decayTwo}`
  );
});

test("rotation smoothing: zero/negative dt changes nothing (bounded spikes)", () => {
  const smoother = createRotationSmoothing();
  smoother.step(30, 0.0);
  assert.equal(smoother.step(99, -5), 30, "negative dt is clamped to 0");
  assert.equal(smoother.step(99, 0), 30, "zero dt holds the value");
  assert.equal(smoother.step(null, 0), 30, "zero dt holds during decay too");
});

test("rotation smoothing: NaN samples are treated as missing, not adopted", () => {
  const smoother = createRotationSmoothing();
  smoother.step(25, 0.0);
  const v = smoother.step(Number.NaN, 0.25);
  assert.ok(v < 25, `NaN must decay, not adopt (got ${v})`);
});

/* ------------------------------------------------------------------ */
/* tpsToRadiansPerSecond                                               */
/* ------------------------------------------------------------------ */

test("tps → rad/s: 0 and negative map to exactly 0 (no fabricated spin)", () => {
  assert.equal(tpsToRadiansPerSecond(0), 0);
  assert.equal(tpsToRadiansPerSecond(-10), 0);
  assert.equal(tpsToRadiansPerSecond(Number.NaN), 0);
});

test("tps → rad/s: positive TPS always maps above the visible minimum", () => {
  assert.ok(tpsToRadiansPerSecond(0.001) > NUCLEUS_SPIN_MIN_RAD_PER_SECOND);
  assert.ok(tpsToRadiansPerSecond(1) > NUCLEUS_SPIN_MIN_RAD_PER_SECOND);
});

test("tps → rad/s: monotonic with saturation (0 < 20 < 80 < 1000, capped)", () => {
  const w20 = tpsToRadiansPerSecond(20);
  const w80 = tpsToRadiansPerSecond(80);
  const w1000 = tpsToRadiansPerSecond(1000);
  const wSat = tpsToRadiansPerSecond(NUCLEUS_SPIN_SATURATION_TPS);
  const wHuge = tpsToRadiansPerSecond(1e6);

  assert.ok(w20 > 0 && w80 > w20, `20 TPS (${w20}) must be visibly slower than 80 TPS (${w80})`);
  assert.ok(w1000 > w80, `1000 TPS (${w1000}) must exceed 80 TPS (${w80})`);
  assert.ok(
    w1000 < NUCLEUS_SPIN_MAX_RAD_PER_SECOND,
    `1000 TPS must stay below the cap — no blur (${w1000} < ${NUCLEUS_SPIN_MAX_RAD_PER_SECOND})`
  );
  assert.ok(
    Math.abs(wSat - NUCLEUS_SPIN_MAX_RAD_PER_SECOND) < 1e-9,
    "saturation point reaches the cap"
  );
  assert.ok(
    Math.abs(wHuge - NUCLEUS_SPIN_MAX_RAD_PER_SECOND) < 1e-9,
    "huge TPS saturates, does not blur"
  );
  // 20 vs 80 remain distinguishable: log scaling keeps them ≥ 25 % apart.
  assert.ok(
    (w80 - w20) / w20 > 0.25,
    `20 vs 80 TPS must stay visibly different (${w20} vs ${w80})`
  );
});

/* ------------------------------------------------------------------ */
/* createQueueVibration                                                */
/* ------------------------------------------------------------------ */

test("queue vibration: null queue → 0 (no fabricated tremor)", () => {
  const vib = createQueueVibration();
  const phase: QueueVibrationPhase = { p: 0 };
  assert.equal(vib.step(null, 5, 0.016, phase), 0);
  assert.equal(vib.step(null, null, 0.016, phase), 0);
});

test("queue vibration: zero queue → 0", () => {
  const vib = createQueueVibration();
  const phase: QueueVibrationPhase = { p: 0 };
  assert.equal(vib.step(0, 3, 0.016, phase), 0);
  assert.equal(vib.step(0, 0, 0.016, phase), 0);
  assert.equal(vib.step(-4, 0, 0.016, phase), 0, "negative clamps to zero");
});

test("queue vibration: positive queue is bounded by the hard cap and oscillates", () => {
  const vib = createQueueVibration();
  const phase: QueueVibrationPhase = { p: 0 };
  let maxSeen = 0;
  for (let i = 0; i < 1000; i += 1) {
    const v = vib.step(20, null, 0.016, phase);
    maxSeen = Math.max(maxSeen, Math.abs(v));
  }
  assert.ok(maxSeen > 0, "positive queue must produce visible vibration");
  assert.ok(
    maxSeen <= QUEUE_VIBRATION_MAX_AMPLITUDE + 1e-12,
    `amplitude must stay bounded (got peak ${maxSeen} > ${QUEUE_VIBRATION_MAX_AMPLITUDE})`
  );
});

test("queue vibration: larger queues give larger (still capped) amplitude", () => {
  const vib = createQueueVibration();
  const peakA: QueueVibrationPhase = { p: Math.PI / 2 };
  const peakB: QueueVibrationPhase = { p: Math.PI / 2 };
  // Peak the oscillator (phase π/2 maximizes |sin|), with zero dt so only
  // the amplitude is measured.
  const amp1 = vib.step(2, null, 0, peakA);
  const amp50 = vib.step(50, null, 0, peakB);
  assert.ok(amp50 > amp1, `queue 50 (${amp50}) must vibrate more than queue 2 (${amp1})`);
  assert.ok(amp50 <= QUEUE_VIBRATION_MAX_AMPLITUDE + 1e-12, "still capped");
  assert.ok(amp1 > 0, "queue 2 must be visibly non-zero");
});

test("queue vibration: phase advances with dt, not frame count (dt-independence)", () => {
  const vib = createQueueVibration();
  const p1: QueueVibrationPhase = { p: 0 };
  const p2: QueueVibrationPhase = { p: 0 };
  const q = 10;
  // total must stay ≤ MAX_FRAME_DELTA (0.1 s) — above it the spike guard
  // intentionally clamps, so compare within the unclamped regime.
  const total = 0.08;
  const one = vib.step(q, null, total, p1);
  // Two half-steps of the same total dt (frequency is constant for fixed q).
  const half = total / 2;
  let two = vib.step(q, null, half, p2);
  two = vib.step(q, null, half, p2);
  assert.ok(
    Math.abs(one - two) < 1e-9,
    `phase must advance by dt: single ${total}s gave ${one}, two of ${half}s gave ${two}`
  );
  assert.ok(p1.p >= 0 && p1.p < Math.PI * 2, `wrapped phase expected, got ${p1.p}`);
  assert.ok(p1.p > 0, "phase actually advanced");
});

test("queue vibration: active jobs drain the amplitude (damped, never zero while queued)", () => {
  const vib = createQueueVibration();
  const stalled = vib.step(8, 0, 0, { p: Math.PI / 2 });
  const draining = vib.step(8, 4, 0, { p: Math.PI / 2 });
  assert.ok(
    Math.abs(draining) < Math.abs(stalled),
    `draining queue vibrates less (${draining} < ${stalled})`
  );
  assert.ok(draining > 0, "a draining queue still visibly trembles");
});

test("queue vibration: dt is clamped — a background-tab spike cannot fling the phase", () => {
  const vib = createQueueVibration();
  const small = vib.step(5, null, 0.016, { p: 0 });
  const spike = vib.step(5, null, 30, { p: 0 }); // 30 s spike
  // A 30 s spike must behave exactly like a 0.1 s frame (MAX_FRAME_DELTA).
  const capped = vib.step(5, null, 0.1, { p: 0 });
  assert.ok(
    Math.abs(spike - capped) < 1e-12,
    `spike dt must be clamped like a 0.1 s frame (${spike} vs ${capped})`
  );
  assert.ok(Number.isFinite(small) && Number.isFinite(spike));
});

test("queue vibration: frequency stays bounded for huge queues (phase always wrapped)", () => {
  const vib = createQueueVibration();
  for (let i = 0; i < 200; i += 1) {
    const c: QueueVibrationPhase = { p: 0 };
    vib.step(1e6, null, 1.0, c);
    assert.ok(c.p >= 0 && c.p < Math.PI * 2, `phase stayed wrapped (${c.p})`);
    assert.ok(Number.isFinite(c.p));
  }
});

/* ------------------------------------------------------------------ */
/* buildModelGroupSlots                                                */
/* ------------------------------------------------------------------ */

test("model group slots: empty input → empty slots, not truncated", () => {
  const r = buildModelGroupSlots([], 1234);
  assert.deepEqual(r.slots, []);
  assert.equal(r.truncated, false);
});

test("model group slots: one model → one slot, zero-indexed", () => {
  const r = buildModelGroupSlots(["gpt-4o"], 7);
  assert.equal(r.slots.length, 1);
  assert.equal(r.slots[0].modelId, "gpt-4o");
  assert.equal(r.slots[0].index, 0);
  assert.equal(r.truncated, false);
});

test("model group slots: two models → two slots, stable hash order", () => {
  const ids = ["gemini-2.5-pro", "claude-sonnet-4-5"];
  const r = buildModelGroupSlots(ids, 42);
  assert.equal(r.slots.length, 2);
  assert.equal(r.truncated, false);
  const byHash = [...ids].sort((x, y) => fnv1a(x) - fnv1a(y));
  assert.deepEqual(
    r.slots.map((s) => s.modelId),
    byHash,
    "order must be by FNV-1a hash, not by array position"
  );
  assert.deepEqual(
    r.slots.map((s) => s.index),
    [0, 1]
  );
});

test("model group slots: three models → three slots (the visible cap)", () => {
  const ids = ["gpt-4o", "claude-sonnet-4-5", "gemini-2.5-pro"];
  const r = buildModelGroupSlots(ids, 99);
  assert.equal(r.slots.length, 3);
  assert.equal(r.truncated, false);
  assert.deepEqual(
    r.slots.map((s) => s.index),
    [0, 1, 2]
  );
});

test("model group slots: four+ models → first 3 by stable order, truncated flag set", () => {
  const ids = [
    "gpt-4o",
    "claude-sonnet-4-5",
    "gemini-2.5-pro",
    "llama-4-maverick",
    "mistral-large-2",
  ];
  const r = buildModelGroupSlots(ids, 5);
  assert.equal(r.slots.length, 3, "visible cap is 3");
  assert.equal(r.truncated, true);
  const ordered = [...ids].sort((x, y) => fnv1a(x) - fnv1a(y));
  assert.deepEqual(
    r.slots.map((s) => s.modelId),
    ordered.slice(0, 3),
    "the visible 3 are the 3 smallest hashes — stable regardless of array order or seed"
  );
});

test("model group slots: input order and seed do not change the visible slot set or hues", () => {
  const ids = ["gemini-2.5-pro", "gpt-4o", "claude-sonnet-4-5", "llama-4-maverick"];
  const shuffled = ["gpt-4o", "llama-4-maverick", "claude-sonnet-4-5", "gemini-2.5-pro"];
  const rA = buildModelGroupSlots(ids, 11);
  const rB = buildModelGroupSlots(shuffled, 22);
  assert.deepEqual(
    rA.slots.map((s) => s.modelId),
    rB.slots.map((s) => s.modelId),
    "slot membership is order- and seed-independent"
  );
  assert.deepEqual(rA.slots, rB.slots, "same slots, same hueSeeds, same indices");
});

test("model group slots: hueSeed is deterministic per modelId across calls", () => {
  const ids = ["claude-sonnet-4-5", "gpt-4o", "gemini-2.5-pro"];
  const first = buildModelGroupSlots(ids, 3);
  for (let i = 0; i < 20; i += 1) {
    const again = buildModelGroupSlots(ids, 3 + i * 101);
    assert.deepEqual(again.slots, first.slots, `hue seeds must be stable across call ${i}`);
  }
  for (const slot of first.slots) {
    assert.equal(slot.hueSeed, fnv1a(slot.modelId) % 360, "hueSeed = FNV-1a(modelId) % 360");
    assert.ok(slot.hueSeed >= 0 && slot.hueSeed < 360, "hueSeed in [0, 360)");
  }
});

test("model group slots: duplicates and blanks are canonicalized away", () => {
  const r = buildModelGroupSlots(
    ["gpt-4o", " GPT-4O ", "", "   ", "gpt-4o", "claude-sonnet-4-5"],
    1
  );
  assert.equal(r.truncated, false);
  assert.deepEqual(
    r.slots.map((s) => s.modelId),
    ["claude-sonnet-4-5", "gpt-4o"].sort((x, y) => fnv1a(x) - fnv1a(y))
  );
});
