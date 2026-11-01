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
  // OR-ATOM-010 iteration-e regression fix: bloom is OFF by default on the
  // high/medium tiers — the GPU bloom pass (26a67bbf7) regressed the material
  // by washing thin links at default auto-fit framing on real pixels (the
  // independent audit dropped filament clarity 3 → 2). The pass stays wired
  // and reachable via the dev `bloom=` bench override for A/B; only the
  // default ships off, on the crisp material baseline (probe_bloom_off).
  assert.deepEqual(QUALITY_BUDGETS.high, {
    dprMax: 2,
    antialias: true,
    tubeSegments: 24,
    cloudParticles: 12,
    bloom: { enabled: false, strength: 0.35, radius: 0.3, threshold: 3.0 },
  });
  assert.deepEqual(QUALITY_BUDGETS.medium, {
    dprMax: 1.5,
    antialias: true,
    tubeSegments: 14,
    cloudParticles: 8,
    bloom: { enabled: false, strength: 0.28, radius: 0.3, threshold: 2.5 },
  });
  assert.deepEqual(QUALITY_BUDGETS.low, {
    dprMax: 1,
    antialias: false,
    tubeSegments: 8,
    cloudParticles: 5,
    bloom: { enabled: false, strength: 0, radius: 0, threshold: 1 },
  });
  assert.deepEqual(QUALITY_BUDGETS.none, {
    dprMax: 1,
    antialias: false,
    tubeSegments: 0,
    cloudParticles: 0,
    bloom: { enabled: false, strength: 0, radius: 0, threshold: 1 },
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

  // OR-ATOM-010 iteration-e regression fix: bloom is OFF by default on every
  // tier — the GPU bloom pass (26a67bbf7) washed thin links at default auto-fit
  // framing on real pixels, so the default ships on the crisp material
  // baseline (probe_bloom_off). The budget values are retained so the dev
  // `bloom=` bench override (AtomicScene override path) can re-enable the pass
  // for A/B without a re-shape.
  assert.equal(QUALITY_BUDGETS.high.bloom.enabled, false);
  assert.equal(QUALITY_BUDGETS.medium.bloom.enabled, false);
  assert.equal(QUALITY_BUDGETS.low.bloom.enabled, false);
  assert.equal(QUALITY_BUDGETS.none.bloom.enabled, false);
  // The high tier still carries the stronger budget so a dev-override
  // comparison is monotonic down the ladder.
  assert.ok(QUALITY_BUDGETS.high.bloom.strength > QUALITY_BUDGETS.medium.bloom.strength);
  // iteration-e washout guard: with ACES tone-mapping a low threshold makes
  // the whole scene the bloom source (headless A/B: threshold 0.75 raised
  // scene mean luminance 28 → 136 and erased the neon palette). The enabled
  // tiers must keep the threshold above the non-emissive output band and
  // the strength low (the halo is carried by the threshold, not the
  // intensity). See src/plugins/atomic-topology/quality.ts → BloomBudget.
  assert.ok(QUALITY_BUDGETS.high.bloom.threshold >= 2.5);
  assert.ok(QUALITY_BUDGETS.medium.bloom.threshold >= 2.0);
  assert.ok(QUALITY_BUDGETS.high.bloom.strength <= 0.5);
  assert.ok(QUALITY_BUDGETS.medium.bloom.strength <= 0.5);
  // Disabled tiers: zero strength/radius + threshold at the radiance ceiling
  // (a disabled pass is never constructed, but the budget stays sane).
  assert.equal(QUALITY_BUDGETS.low.bloom.strength, 0);
  assert.equal(QUALITY_BUDGETS.none.bloom.strength, 0);
});
