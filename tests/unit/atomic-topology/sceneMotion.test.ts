/**
 * Unit tests for the pure motion module (OR-ATOM-007).
 *
 * Pins: pause-aware clock (accumulates 0 while paused, resumes contiguously,
 * clamps frame deltas), ease curves (bounded, correct endpoints), breathing
 * scale (±amplitude, static when inactive), pulse phase (loops 0..1), and the
 * reduced-motion gate (accessibility.md: prefers-reduced-motion → static).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advanceSceneTime,
  easeInOut,
  easeOutSharp,
  breathingScale,
  pulsePhase,
  motionParams,
  MAX_FRAME_DELTA,
} from "@/plugins/atomic-topology/scene/motion";

test("advanceSceneTime accumulates 0 while paused (static frame)", () => {
  const clock = { now: 42 };
  const t1 = advanceSceneTime(clock, 0.016, true);
  assert.equal(t1, 42);
  const t2 = advanceSceneTime(clock, 0.016, true);
  assert.equal(t2, 42);
  assert.equal(clock.now, 42, "multiple paused frames never move the clock");
});

test("advanceSceneTime resumes contiguously after pause (no jump)", () => {
  const clock = { now: 10 };
  advanceSceneTime(clock, 0.016, true);
  assert.equal(clock.now, 10);
  const t = advanceSceneTime(clock, 0.016, false);
  assert.ok(Math.abs(t - 10.016) < 1e-12, `expected 10.016, got ${t}`);
});

test("advanceSceneTime clamps a large frame delta (tab-switch spike)", () => {
  const clock = { now: 0 };
  const t = advanceSceneTime(clock, 5, false);
  assert.equal(t, MAX_FRAME_DELTA, "a 5 s gap must clamp to MAX_FRAME_DELTA");
});

test("easeInOut is bounded and pinned at the endpoints", () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(0.5), 0.5);
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    assert.ok(Math.abs(easeInOut(t) + easeInOut(1 - t) - 1) < 1e-12, `symmetry at ${t}`);
  }
  assert.equal(easeInOut(-1), 0);
  assert.equal(easeInOut(2), 1);
});

test("easeOutSharp is bounded, fast start, monotone", () => {
  assert.equal(easeOutSharp(0), 0);
  assert.equal(easeOutSharp(1), 1);
  assert.ok(easeOutSharp(0.1) > 0.2, "fast start");
  let prev = 0;
  for (let i = 1; i <= 100; i += 1) {
    const v = easeOutSharp(i / 100);
    assert.ok(v >= prev, `easeOutSharp must be non-decreasing at ${i / 100}`);
    prev = v;
  }
  assert.equal(easeOutSharp(-3), 0);
  assert.equal(easeOutSharp(3), 1);
});

test("breathingScale is bounded to ±amplitude and static when inactive", () => {
  const amp = 0.02;
  for (let i = 0; i <= 60; i += 1) {
    const s = breathingScale(i / 60, 3, amp, true);
    assert.ok(s >= 1 - amp - 1e-12 && s <= 1 + amp + 1e-12, `scale ${s} out of band`);
  }
  assert.equal(breathingScale(1.234, 3, amp, false), 1, "inactive → exactly 1");
  assert.equal(breathingScale(1.234, 0, amp, true), 1, "non-positive period → static");
});

test("pulsePhase loops 0..1 and is zero for a non-positive period", () => {
  assert.equal(pulsePhase(0, 2.5), 0);
  assert.ok(Math.abs(pulsePhase(1.25, 2.5) - 0.5) < 1e-12);
  assert.ok(Math.abs(pulsePhase(2.5, 2.5) - 0) < 1e-12, "wraps to 0 at the period boundary");
  assert.ok(Math.abs(pulsePhase(3.75, 2.5) - 0.5) < 1e-12, "continues across wraps");
  assert.equal(pulsePhase(5, 0), 0);
  assert.equal(pulsePhase(5, -1), 0);
});

test("motionParams: reduced-motion flag returns static params", () => {
  const statics = motionParams({ reducedMotion: true, spinValue: 1.2, spinMode: "measured" });
  assert.equal(statics.spinActive, false);
  assert.equal(statics.breathActive, false);
});

test("motionParams: motion only for a measured positive rate (no fabrication)", () => {
  assert.equal(
    motionParams({ reducedMotion: false, spinValue: 1.2, spinMode: "measured" }).spinActive,
    true,
    "measured rate → spin/breathing active"
  );
  assert.equal(
    motionParams({ reducedMotion: false, spinValue: 0, spinMode: "measured-zero" }).spinActive,
    false,
    "measured-zero → no fabricated motion"
  );
  assert.equal(
    motionParams({ reducedMotion: false, spinValue: 0.1, spinMode: "unavailable" }).spinActive,
    false,
    "unavailable → no fabricated motion"
  );
  const p = motionParams({ reducedMotion: false, spinValue: 1.2, spinMode: "measured" });
  assert.ok(p.breathPeriod > 0, "breathing period must be positive when active");
});
