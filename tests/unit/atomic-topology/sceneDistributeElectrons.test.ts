/**
 * Unit tests for the electron-budget distribution bridge (OR-ATOM-007 on
 * release): {@link distributeElectrons} maps the release's quality-scaled
 * `cloudParticles` budget across the 007 shell geometry (4:6:8 ratio).
 *
 * Pins: same-total invariant (the quality budget is never exceeded),
 * determinism, the per-shell ratio (inner shells denser), clamping of
 * shellCount to 1–3, and the zero/negative-total degenerate cases.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  distributeElectrons,
  SHELL_COUNT,
  SHELL_ELECTRON_COUNTS,
} from "@/plugins/atomic-topology/scene/cloudShells";

test("distributeElectrons: the sum of the shell counts equals the total budget", () => {
  for (const total of [0, 1, 2, 5, 8, 9, 12, 14, 18, 20, 30]) {
    for (const shells of [1, 2, 3]) {
      const out = distributeElectrons(7, shells, total);
      assert.ok(out.length >= 1, `expected at least one shell, got ${out.length}`);
      const sum = out.reduce((a, b) => a + b, 0);
      assert.equal(
        sum,
        total,
        `total ${total} across ${shells} shells must sum to ${total}, got ${out}`
      );
    }
  }
});

test("distributeElectrons: the full 18 budget maps exactly to the 4:6:8 ratio", () => {
  assert.deepEqual(distributeElectrons(7, 3, 18), [4, 6, 8]);
});

test("distributeElectrons: quality tiers scale the same ratio (release budgets)", () => {
  // QUALITY_BUDGETS: high=12, medium=8, low=5 (3 shells).
  const high = distributeElectrons(7, 3, 12);
  const medium = distributeElectrons(7, 3, 8);
  const low = distributeElectrons(7, 3, 5);
  assert.equal(
    high.reduce((a, b) => a + b, 0),
    12
  );
  assert.equal(
    medium.reduce((a, b) => a + b, 0),
    8
  );
  assert.equal(
    low.reduce((a, b) => a + b, 0),
    5
  );
  // Inner shells stay denser than outer ones (the 4:6:8 ratio, scaled down).
  assert.ok(high[0] <= high[2], "inner shell must not exceed the outer");
  assert.ok(low[0] >= 1, "the low tier keeps the inner shell non-empty");
});

test("distributeElectrons: deterministic — same inputs → same output", () => {
  const a = distributeElectrons(42, 3, 12);
  const b = distributeElectrons(42, 3, 12);
  assert.deepEqual(a, b, "the distribution must be stable across renders");
});

test("distributeElectrons: clamps the shell count to 1–3", () => {
  assert.equal(distributeElectrons(7, 0, 12).length, 1);
  assert.equal(distributeElectrons(7, 1, 12).length, 1);
  assert.equal(distributeElectrons(7, 3, 12).length, 3);
  assert.equal(distributeElectrons(7, 9, 12).length, SHELL_COUNT);
});

test("distributeElectrons: two-shell variant (low quality drops the outer shell)", () => {
  const out = distributeElectrons(7, 2, 12);
  assert.equal(out.length, 2);
  assert.equal(
    out.reduce((a, b) => a + b, 0),
    12
  );
  assert.ok(out[0] <= out[1], "the 4:6 ratio keeps the inner shell ≤ the outer");
});

test("distributeElectrons: zero / negative budgets yield an all-zero (never empty) plan", () => {
  assert.deepEqual(distributeElectrons(7, 3, 0), [0, 0, 0]);
  assert.deepEqual(distributeElectrons(7, 3, -3), [0, 0, 0]);
  // Every emitted count is bounded by the remaining budget (no negative).
  for (const c of distributeElectrons(7, 3, 1)) assert.ok(c >= 0);
});

test("distributeElectrons: a single shell carries the whole budget", () => {
  assert.deepEqual(distributeElectrons(7, 1, 9), [9]);
  assert.deepEqual(distributeElectrons(7, 1, 0), [0]);
});

test("distributeElectrons: respects the 4:6:8 ratio shape for large budgets", () => {
  // 36 → exactly 2× the canonical ratio (4:6:8) = 8:12:16.
  const out = distributeElectrons(7, 3, 36);
  assert.equal(
    out.reduce((a, b) => a + b, 0),
    36
  );
  assert.ok(out[0] < out[1] && out[1] < out[2], "inner < middle < outer for a large budget");
  assert.deepEqual(SHELL_ELECTRON_COUNTS, [4, 6, 8], "the canonical ratio is the pinned 4:6:8");
});
