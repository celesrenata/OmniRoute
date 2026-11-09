import test from "node:test";
import assert from "node:assert/strict";
import {
  TIER1_LEVEL,
  TIER2_DECAY_MS,
  VIBRANT_BRIGHTNESS,
  VIBRANT_SATURATION,
  afterglowWeight,
  resolveEnergyState,
  type EnergyInput,
} from "../../../src/plugins/atomic-topology/scene/energyState.ts";
import { activityCopy } from "../../../src/plugins/atomic-topology/overlays/AtomicTooltip.tsx";

const base: EnergyInput = {
  measuredTps: null,
  activeRequests: null,
  queued: null,
  stale: false,
  reducedMotion: false,
};
const FULL = resolveEnergyState({ ...base, measuredTps: 1e6, tier: 3 });

test("tier 0 (absent) is the ONLY tier that greys and dims", () => {
  const t0 = resolveEnergyState({ ...base, tier: 0 });
  const t1 = resolveEnergyState({ ...base, tier: 1 });
  assert.ok(t0.saturation < 0.5 && t0.brightness < 0.5);
  assert.ok(t1.saturation >= VIBRANT_SATURATION && t1.brightness >= VIBRANT_BRIGHTNESS);
  assert.equal(t0.measured, false);
});

test("tier 1 (idle, healthy) is alive: 70-80 % of the excited richness, no measured flag", () => {
  const t1 = resolveEnergyState({ ...base, tier: 1 });
  assert.equal(t1.measured, false);
  const richness =
    (t1.excitation + t1.saturation + t1.brightness) /
    (FULL.excitation + FULL.saturation + FULL.brightness);
  assert.ok(richness > 0.7 && richness < 0.95, `richness ${richness}`);
  assert.ok(t1.excitation < FULL.excitation, "calmer than excited (motion/FX, not colour)");
  assert.ok(Math.abs(t1.excitation - (0.12 + 0.88 * TIER1_LEVEL)) < 1e-9);
});

test("tier 2 afterglow decays smoothly from warm to the tier-1 rest look over the window", () => {
  const at = (age: number) =>
    resolveEnergyState({ ...base, tier: 2, activityAgeMs: age }).excitation;
  const rest = resolveEnergyState({ ...base, tier: 1 }).excitation;
  assert.ok(at(0) > rest);
  assert.ok(Math.abs(at(TIER2_DECAY_MS) - rest) < 1e-9);
  let prev = at(0);
  for (let a = 0; a <= TIER2_DECAY_MS; a += 15_000) {
    const v = at(a);
    assert.ok(v <= prev + 1e-12, "non-increasing");
    assert.ok(prev - v < 0.03, "no step");
    prev = v;
  }
  assert.equal(afterglowWeight(null), 0);
  assert.equal(afterglowWeight(-5), 0);
});

test("tier 3 is the full excited look; measured work never lowers any tier", () => {
  const t3 = resolveEnergyState({ ...base, tier: 3 });
  assert.ok(t3.excitation >= 0.85);
  const t1m = resolveEnergyState({ ...base, tier: 1, measuredTps: 200 });
  assert.equal(t1m.measured, true);
  assert.ok(t1m.excitation > resolveEnergyState({ ...base, tier: 1 }).excitation);
});

test("no tier given = legacy behaviour (idle fades to grey); stale always wins", () => {
  const legacy = resolveEnergyState(base);
  assert.ok(legacy.saturation < 0.5);
  const stale = resolveEnergyState({ ...base, tier: 3, stale: true });
  assert.ok(stale.saturation < 0.5);
});

test("reduced motion: same tiers, no animation", () => {
  const r = resolveEnergyState({ ...base, tier: 1, reducedMotion: true });
  assert.equal(r.speedMul, 0);
  assert.ok(r.saturation >= VIBRANT_SATURATION);
});

test("tooltip copy separates idle from recent activity and never calls decoration work", () => {
  const now = 1_000_000_000_000;
  assert.match(activityCopy(1, null, now), /idle, no measured activity/);
  assert.match(activityCopy(2, now - 4 * 60_000, now), /recent activity 4m ago/);
  assert.match(activityCopy(2, now - 10_000, now), /< 1m ago/);
  assert.match(activityCopy(0, null, now), /no data/);
  assert.match(activityCopy(3, now, now), /active/);
});
