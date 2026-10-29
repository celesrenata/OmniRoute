/**
 * Unit tests for the pure orbital-haze math (OR-ATOM-008 S8.2, `cloudHaze.ts`).
 *
 * Pure helpers only — no `three`, no DOM, no clock: deterministic tier
 * resolution, sprite budgets, counter-rotation bounds, and breathing math.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HAZE_RENDER_ORDER,
  HAZE_TIER,
  HAZE_TIER_TABLE,
  hazeBreathScale,
  hazeSpinRadians,
  hazeSprites,
  resolveHazeQualityTier,
} from "../../../src/plugins/atomic-topology/scene/cloudHaze";
import { fnv1a } from "../../../src/plugins/atomic-topology/scene/cloudShells";

test("resolveHazeQualityTier maps core counts to tiers (stable, no flicker)", () => {
  // 1–7 cores → low, 8–11 → medium, ≥12 → high (floor(cores/4) clamped 1..3).
  assert.equal(resolveHazeQualityTier(1), "low");
  assert.equal(resolveHazeQualityTier(4), "low");
  assert.equal(resolveHazeQualityTier(7), "low");
  assert.equal(resolveHazeQualityTier(8), "medium");
  assert.equal(resolveHazeQualityTier(11), "medium");
  assert.equal(resolveHazeQualityTier(12), "high");
  assert.equal(resolveHazeQualityTier(16), "high");
  assert.equal(resolveHazeQualityTier(128), "high");
  // Falsy / absent → 8-core default (medium) — SSR-safe fallback.
  assert.equal(resolveHazeQualityTier(), "medium");
  assert.equal(resolveHazeQualityTier(0), "medium");
  // Same input always yields the same tier (stable for the module lifetime).
  assert.equal(resolveHazeQualityTier(16), resolveHazeQualityTier(16));
});

test("HAZE_TIER_TABLE constants stay inside the S8.2 spec envelopes", () => {
  for (const tier of ["high", "medium", "low"] as const) {
    const p = HAZE_TIER_TABLE[tier];
    // Bounded sprite budget (web-quality-performance): 1–3 per atom.
    assert.ok(p.spriteCount >= 1 && p.spriteCount <= 3, `${tier}: count ${p.spriteCount}`);
    // Controlled additive glow: per-sprite opacity ~0.03–0.08 (never blown out).
    assert.ok(p.spriteOpacity >= 0.03 && p.spriteOpacity <= 0.08, `${tier}: opacity`);
    // Base radius multiplier keeps the max (base + 0.4 jitter) inside [2.6, 3.4]×.
    assert.ok(
      p.radiusMultiplier >= 2.6 && p.radiusMultiplier + 0.4 <= 3.4,
      `${tier}: radius ${p.radiusMultiplier}`
    );
    // Slow counter-rotation: one revolution in ≈ 70–170 s (0.06–0.08 rad/s).
    const period = (2 * Math.PI) / p.spinRadPerSecond;
    assert.ok(period >= 70 && period <= 170, `${tier}: period ${period}s`);
    // Very slow breathing (±3–5 %, 9–11 s period).
    assert.ok(p.breathAmplitude >= 0.03 && p.breathAmplitude <= 0.05, `${tier}: amp`);
    assert.ok(p.breathPeriodSeconds >= 9 && p.breathPeriodSeconds <= 11, `${tier}: period`);
  }
});

test("sprite budget: 38 atoms × worst-case 3 haze sprites = 114", () => {
  const worstPerAtom = Math.max(...Object.values(HAZE_TIER_TABLE).map((t) => t.spriteCount));
  assert.equal(worstPerAtom, 3);
  const hazeTotal = 38 * worstPerAtom;
  // The haze layer adds at most 114 sprites on top of the existing electron
  // shells (38 atoms × 18 = 684), per the OR-ATOM-008 S8.2 bounded budget.
  assert.equal(hazeTotal, 114);
  assert.ok(hazeTotal <= 114);
});

test("hazeSprites is deterministic per seed and tier (FNV-1a driven)", () => {
  const a = hazeSprites(fnv1a("atom-alpha"), "high");
  const b = hazeSprites(fnv1a("atom-alpha"), "high");
  assert.deepEqual(a, b); // same seed → identical params
  const c = hazeSprites(fnv1a("atom-beta"), "high");
  assert.notDeepEqual(a, c); // different seed → different params
  assert.equal(a.length, 3);
  assert.equal(hazeSprites(fnv1a("atom-alpha"), "medium").length, 2);
  assert.equal(hazeSprites(fnv1a("atom-alpha"), "low").length, 1);
});

test("hazeSprites bounds: scale, counter-spin, phases, opacity jitter", () => {
  for (const seed of [0, 1, 777, 0x811c9dc5, fnv1a("provider-gpu-0")]) {
    for (const tier of ["high", "medium", "low"] as const) {
      const params = HAZE_TIER_TABLE[tier];
      for (const p of hazeSprites(seed, tier)) {
        // Scale stays inside [2.6, 3.4]× the base cloud radius.
        assert.ok(
          p.scaleMultiplier >= 2.6 && p.scaleMultiplier <= 3.4,
          `scale ${p.scaleMultiplier}`
        );
        // Counter-rotation: always negative (electrons spin positive),
        // magnitude in [0.4×, 1.0×] the tier base.
        assert.ok(p.spinRadPerSecond < 0, `spin ${p.spinRadPerSecond}`);
        assert.ok(
          -p.spinRadPerSecond <= params.spinRadPerSecond &&
            -p.spinRadPerSecond >= 0.4 * params.spinRadPerSecond,
          `spin magnitude ${-p.spinRadPerSecond}`
        );
        // Phases inside [0, 2π).
        const twoPi = 2 * Math.PI;
        assert.ok(p.spinPhase >= 0 && p.spinPhase < twoPi, `phase ${p.spinPhase}`);
        assert.ok(p.breathPhase >= 0 && p.breathPhase < twoPi, `bphase ${p.breathPhase}`);
        // Opacity jitter inside [0.85, 1.15].
        assert.ok(p.opacityScale >= 0.85 && p.opacityScale <= 1.15, `osc ${p.opacityScale}`);
      }
    }
  }
});

test("opacity stack stays under 0.25 at the nucleus (banding/blow-out guard)", () => {
  const high = HAZE_TIER_TABLE["high"];
  const worstStack = high.spriteCount * high.spriteOpacity * 1.15; // max jitter
  assert.ok(worstStack < 0.25, `worst stack ${worstStack.toFixed(3)}`);
});

test("hazeSpinRadians is absolute, [0, 2π), and pure in t (exact freeze)", () => {
  const p = hazeSprites(fnv1a("atom-spin"), "high")[0];
  const twoPi = 2 * Math.PI;
  // Absolute: same t → same angle (no accumulated drift).
  assert.equal(hazeSpinRadians(p, 3.7), hazeSpinRadians(p, 3.7));
  // Always in [0, 2π) even with a negative spin speed.
  for (const t of [0, 1, 10.5, 100]) {
    const a = hazeSpinRadians(p, t);
    assert.ok(a >= 0 && a < twoPi, `angle ${a} at t=${t}`);
  }
  // A frozen scene skips the per-frame mutation, so the last computed angle
  // is held exactly by construction (pure in t).
  assert.equal(hazeSpinRadians(p, 5), hazeSpinRadians(p, 5));
  // The angle genuinely moves over time (nonzero spin speed).
  assert.notEqual(hazeSpinRadians(p, 10), hazeSpinRadians(p, 0));
});

test("hazeBreathScale stays in [1 − amp, 1 + amp] and is period-stable", () => {
  for (const tier of ["high", "medium", "low"] as const) {
    const params = HAZE_TIER_TABLE[tier];
    const p = hazeSprites(fnv1a("atom-breath"), tier)[0];
    // Sweep well beyond one period — the envelope never leaves ±amplitude.
    for (let t = 0; t <= params.breathPeriodSeconds * 2; t += 0.25) {
      const s = hazeBreathScale(p, t, params);
      assert.ok(
        s >= 1 - params.breathAmplitude - 1e-12 && s <= 1 + params.breathAmplitude + 1e-12,
        `scale ${s} at t=${t}`
      );
    }
    // Period-stable: the factor repeats every breath period exactly.
    const t0 = 1.37;
    assert.ok(
      Math.abs(
        hazeBreathScale(p, t0, params) - hazeBreathScale(p, t0 + params.breathPeriodSeconds, params)
      ) < 1e-9
    );
  }
});

test("HAZE_RENDER_ORDER is below the electron sprites (renderOrder 0)", () => {
  assert.ok(HAZE_RENDER_ORDER < 0);
});

test("HAZE_TIER resolves once at module scope to a valid tier (SSR-safe)", () => {
  assert.ok(["high", "medium", "low"].includes(HAZE_TIER));
  // Under SSR (no navigator) it must be the 8-core default → medium.
  assert.equal(HAZE_TIER, resolveHazeQualityTier());
});
