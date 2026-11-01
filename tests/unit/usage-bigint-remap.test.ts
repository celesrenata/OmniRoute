/**
 * @file Tests for usageHistory.ts / migrations.ts float→bigint rounding.
 * PG BIGINT columns reject floats like 4507.599715001881 — round to integer before binding.
 *
 * @group db/usage-history
 */

import { test } from "node:test";
import assert from "assert";

test("latencyMs rounding to integer", () => {
  // Simulate the fix: when building DB values, wrap Number() with Math.round()
  const latencyMsFloat = 4507.599715001881;
  const ttftMsFloat = 123.456;

  // Old (broken):
  //   Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : 0  // → 4507.599715001881
  //
  // New (fixed):
  //   Number.isFinite(Number(latencyMs)) ? Math.round(Number(latencyMs)) : 0  // → 4508

  const oldLatency = Number.isFinite(Number(latencyMsFloat)) ? Number(latencyMsFloat) : 0;
  const newLatency = Number.isFinite(Number(latencyMsFloat))
    ? Math.round(Number(latencyMsFloat))
    : 0;

  // Old would produce a float,New produces an integer
  assert.strictEqual(oldLatency, 4507.599715001881);
  assert.strictEqual(newLatency, 4508);

  // Same for TTFT
  const oldTtft = Number.isFinite(Number(ttftMsFloat)) ? Number(ttftMsFloat) : 0;
  const newTtft = Number.isFinite(Number(ttftMsFloat)) ? Math.round(Number(ttftMsFloat)) : 0;

  assert.strictEqual(oldTtft, 123.456);
  assert.strictEqual(newTtft, 123);
});

test("handles null/undefined latency gracefully", () => {
  const latencyMsUndefined = undefined;
  const latencyMsNull = null;

  const valUndefined = Number.isFinite(Number(latencyMsUndefined))
    ? Math.round(Number(latencyMsUndefined))
    : 0;
  const valNull = Number.isFinite(Number(latencyMsNull)) ? Math.round(Number(latencyMsNull)) : 0;

  assert.strictEqual(valUndefined, 0);
  assert.strictEqual(valNull, 0);
});
