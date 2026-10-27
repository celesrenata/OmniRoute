/**
 * Unit tests for the pure one-shot event bookkeeping (OR-ATOM-007):
 * edge-triggered booking (fires exactly once per state transition, never
 * while steady), and the impulse intensity curves (sharp ease-out completion
 * flash, exponential-decay failure burst).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bookTransition,
  oneShotIntensity,
  COMPLETION_FLASH_MS,
  FAILURE_BURST_MS,
} from "@/plugins/atomic-topology/scene/oneShot";

test("bookTransition: no event when state is unchanged (never re-fires)", () => {
  assert.equal(bookTransition("error", "error", 10), null);
  assert.equal(bookTransition("active", "active", 10), null);
  assert.equal(bookTransition("idle", "idle", 10), null);
});

test("bookTransition: transition INTO 'last' books exactly one completion event", () => {
  const e = bookTransition("active", "last", 5);
  assert.ok(e, "active → last must book a completion flash");
  assert.equal(e?.kind, "completion");
  assert.equal(e?.startAt, 5);
  assert.equal(e?.duration, COMPLETION_FLASH_MS / 1000);
  // Same edge again is a fresh booking only because the state actually
  // changed; steady 'last' never re-books.
  assert.equal(bookTransition("last", "last", 6), null, "steady 'last' is not an edge");
});

test("bookTransition: transition INTO 'error' books exactly one failure event", () => {
  const e = bookTransition("healthy", "error", 7.5);
  assert.ok(e, "healthy → error must book a failure burst");
  assert.equal(e?.kind, "failure");
  assert.equal(e?.startAt, 7.5);
  assert.equal(e?.duration, FAILURE_BURST_MS / 1000);
  assert.equal(bookTransition("error", "error", 8.5), null, "steady 'error' is not an edge");
});

test("bookTransition: other transitions are not one-shot impulses", () => {
  assert.equal(bookTransition("idle", "active", 1), null);
  assert.equal(bookTransition("active", "idle", 1), null);
  assert.ok(bookTransition("idle", "error", 1) !== null, "idle → error IS a failure edge");
});

test("oneShotIntensity: completion flash starts at 1, decays to 0, single-shot", () => {
  const e = { kind: "completion" as const, startAt: 0, duration: COMPLETION_FLASH_MS / 1000 };
  assert.equal(oneShotIntensity(e, 0), 1, "full intensity at the start");
  assert.equal(oneShotIntensity(e, -0.1), 1, "before the start → full");
  // Monotone non-increasing through the flash.
  let prev = 1;
  for (let i = 1; i <= 20; i += 1) {
    const t = (i / 20) * e.duration;
    const v = oneShotIntensity(e, t);
    assert.ok(v <= prev + 1e-12, `flash must decay at ${t}`);
    prev = v;
  }
  assert.equal(oneShotIntensity(e, e.duration), 0, "done at the duration");
  assert.equal(oneShotIntensity(e, e.duration + 1), 0, "never re-plays");
});

test("oneShotIntensity: failure burst is exponential-decay and single-shot", () => {
  const e = { kind: "failure" as const, startAt: 2, duration: FAILURE_BURST_MS / 1000 };
  assert.equal(oneShotIntensity(e, 2), 1, "full at the start");
  assert.equal(oneShotIntensity(e, 1.9), 1, "before the start");
  // Mid-window: strictly between 0 and 1.
  const mid = oneShotIntensity(e, 2 + FAILURE_BURST_MS / 2000);
  assert.ok(mid > 0 && mid < 1, `mid-intensity ${mid} in (0,1)`);
  assert.equal(oneShotIntensity(e, 2 + e.duration), 0, "done at the duration");
  assert.equal(oneShotIntensity(e, 2 + e.duration + 5), 0, "single-shot, no loop");
  // Exponential character: intensity at 25% of the window is well above the
  // intensity at 75% (fast decay from the top, not linear).
  const q1 = oneShotIntensity(e, 2 + e.duration * 0.25);
  const q3 = oneShotIntensity(e, 2 + e.duration * 0.75);
  assert.ok(q1 > q3, "exponential decay is front-loaded");
});
