/**
 * Atomic scene quality fallback — pure ladder + budgets (OR-ATOM-001 v2, M6).
 *
 * A missing signal is treated optimistically (it never lowers quality); only
 * an observed weak signal lowers it. The budgets are the single source the
 * scene consumes (dpr / antialias / tube segments / cloud particles), so a
 * downgrade is a value change, not a refactor.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveSceneQuality, QUALITY_BUDGETS } from "@/plugins/atomic-topology/quality";

/* ------------------------------------------------------------------ */
/* resolveSceneQuality                                                 */
/* ------------------------------------------------------------------ */

test("resolveSceneQuality: webgl2 === false is always 'none'", () => {
  assert.equal(resolveSceneQuality({ webgl2: false }), "none");
  assert.equal(
    resolveSceneQuality({
      webgl2: false,
      devicePixelRatio: 1,
      hardwareConcurrency: 16,
      deviceMemoryGiB: 32,
    }),
    "none"
  );
});

test("resolveSceneQuality: empty probe is optimistic ('high')", () => {
  assert.equal(resolveSceneQuality(), "high");
  assert.equal(resolveSceneQuality({ webgl2: true }), "high");
});

test("resolveSceneQuality: weak memory alone -> 'medium'", () => {
  assert.equal(resolveSceneQuality({ webgl2: true, deviceMemoryGiB: 3 }), "medium");
  // Missing memory never lowers the quality.
  assert.equal(resolveSceneQuality({ webgl2: true, hardwareConcurrency: 16 }), "high");
});

test("resolveSceneQuality: weak cores alone -> 'medium'", () => {
  assert.equal(resolveSceneQuality({ webgl2: true, hardwareConcurrency: 4 }), "medium");
  assert.equal(
    resolveSceneQuality({ webgl2: true, hardwareConcurrency: 8, deviceMemoryGiB: 16 }),
    "high"
  );
});

test("resolveSceneQuality: weak memory AND weak cores -> 'low'", () => {
  assert.equal(
    resolveSceneQuality({ webgl2: true, deviceMemoryGiB: 2, hardwareConcurrency: 4 }),
    "low"
  );
});

test("resolveSceneQuality: very heavy DPR alone -> 'medium'", () => {
  assert.equal(resolveSceneQuality({ webgl2: true, devicePixelRatio: 4 }), "medium");
  assert.equal(resolveSceneQuality({ webgl2: true, devicePixelRatio: 2 }), "high");
});

test("resolveSceneQuality: non-finite signals are treated as absent (optimistic)", () => {
  assert.equal(
    resolveSceneQuality({
      webgl2: true,
      devicePixelRatio: NaN,
      hardwareConcurrency: NaN,
      deviceMemoryGiB: NaN,
    }),
    "high"
  );
  assert.equal(resolveSceneQuality({ webgl2: true, deviceMemoryGiB: -1 }), "high");
});

/* ------------------------------------------------------------------ */
/* QUALITY_BUDGETS                                                     */
/* ------------------------------------------------------------------ */

test("QUALITY_BUDGETS: the ladder is monotonic and bounded", () => {
  assert.deepEqual(QUALITY_BUDGETS.high, {
    dprMax: 2,
    antialias: true,
    tubeSegments: 24,
    cloudParticles: 12,
  });
  assert.deepEqual(QUALITY_BUDGETS.medium, {
    dprMax: 1.5,
    antialias: true,
    tubeSegments: 14,
    cloudParticles: 8,
  });
  assert.deepEqual(QUALITY_BUDGETS.low, {
    dprMax: 1,
    antialias: false,
    tubeSegments: 8,
    cloudParticles: 5,
  });
  assert.deepEqual(QUALITY_BUDGETS.none, {
    dprMax: 1,
    antialias: false,
    tubeSegments: 0,
    cloudParticles: 0,
  });

  // Strictly monotonic down the ladder.
  assert.ok(QUALITY_BUDGETS.high.dprMax > QUALITY_BUDGETS.medium.dprMax);
  assert.ok(QUALITY_BUDGETS.medium.dprMax > QUALITY_BUDGETS.low.dprMax);
  assert.ok(QUALITY_BUDGETS.high.tubeSegments > QUALITY_BUDGETS.medium.tubeSegments);
  assert.ok(QUALITY_BUDGETS.medium.tubeSegments > QUALITY_BUDGETS.low.tubeSegments);
  assert.ok(QUALITY_BUDGETS.high.cloudParticles > QUALITY_BUDGETS.medium.cloudParticles);
  assert.ok(QUALITY_BUDGETS.medium.cloudParticles > QUALITY_BUDGETS.low.cloudParticles);
  // 'none' renders nothing.
  assert.equal(QUALITY_BUDGETS.none.tubeSegments, 0);
  assert.equal(QUALITY_BUDGETS.none.cloudParticles, 0);
});
