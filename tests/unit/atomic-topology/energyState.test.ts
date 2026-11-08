/**
 * Energy-state mapping, smoothing and reduced-motion behaviour for the
 * ray-traced atom (Gate A) — `scene/energyState.ts` (pure, three-free).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityOf,
  advanceAnimationPhase,
  BRIGHTNESS_MIN,
  CLOUD_RADIUS_MIN,
  createEnergySmoother,
  energyFromActivity,
  IDLE_EXCITATION,
  resolveEnergyState,
  SATURATION_MIN,
  SPEED_MIN,
} from "../../../src/plugins/atomic-topology/scene/energyState";

const base = {
  measuredTps: null,
  activeRequests: null,
  queued: null,
  stale: false,
  reducedMotion: false,
};

test("idle (no measurement) is the lower-energy floor, not zero, and not 'measured'", () => {
  const e = resolveEnergyState(base);
  assert.equal(e.excitation, IDLE_EXCITATION);
  assert.equal(e.saturation, SATURATION_MIN);
  assert.equal(e.brightness, BRIGHTNESS_MIN);
  assert.equal(e.cloudRadiusMul, CLOUD_RADIUS_MIN);
  assert.equal(e.speedMul, SPEED_MIN);
  assert.equal(e.measured, false);
  assert.ok(e.brightness > 0 && e.saturation > 0, "idle stays rich, not black/grey-zero");
});

test("excitation, saturation, brightness, cloud radius and speed are monotonic in tps", () => {
  let prev = resolveEnergyState({ ...base, measuredTps: 0 });
  for (const tps of [5, 20, 60, 140, 400]) {
    const cur = resolveEnergyState({ ...base, measuredTps: tps });
    assert.ok(cur.excitation >= prev.excitation);
    assert.ok(cur.saturation >= prev.saturation);
    assert.ok(cur.brightness >= prev.brightness);
    assert.ok(cur.cloudRadiusMul >= prev.cloudRadiusMul);
    assert.ok(cur.speedMul >= prev.speedMul);
    assert.equal(cur.measured, true);
    prev = cur;
  }
  assert.ok(prev.excitation <= 1 && prev.cloudRadiusMul <= 1 && prev.speedMul <= 1);
});

test("stale telemetry resolves to idle (never a fabricated activity level)", () => {
  const e = resolveEnergyState({ ...base, measuredTps: 500, activeRequests: 9, stale: true });
  assert.equal(e.excitation, IDLE_EXCITATION);
  assert.equal(e.measured, false);
});

test("garbage inputs (NaN, Infinity, negative) fall back to idle, all outputs finite", () => {
  for (const v of [NaN, Infinity, -5]) {
    const e = resolveEnergyState({ ...base, measuredTps: v, activeRequests: v, queued: v });
    for (const x of [e.excitation, e.saturation, e.brightness, e.cloudRadiusMul, e.speedMul]) {
      assert.ok(Number.isFinite(x));
    }
    if (v !== Infinity) assert.equal(e.measured, false);
  }
});

test("reduced motion: zero speed and a held animation phase (no strobing)", () => {
  const e = resolveEnergyState({
    ...base,
    measuredTps: 200,
    activeRequests: 4,
    reducedMotion: true,
  });
  assert.equal(e.speedMul, 0);
  assert.equal(advanceAnimationPhase(1.25, 0.016, e.speedMul, true), 1.25);
  assert.equal(
    advanceAnimationPhase(1.25, 0.016, 1, true),
    1.25,
    "reduced flag alone also holds phase"
  );
  assert.ok(advanceAnimationPhase(1.25, 0.016, 1, false) > 1.25);
});

test("queued jobs raise activity but are capped well below full excitation", () => {
  const e = resolveEnergyState({ ...base, queued: 100 });
  assert.ok(e.excitation > IDLE_EXCITATION && e.excitation < 0.5);
});

test("smoother is frame-rate independent (30/60/120 fps) and rises faster than it falls", () => {
  const run = (fps: number, target: number, seconds: number, start = 0): number => {
    const s = createEnergySmoother(start);
    const dt = 1 / fps;
    let v = start;
    for (let t = 0; t < seconds - 1e-9; t += dt) v = s.step(target, dt);
    return v;
  };
  const up30 = run(30, 1, 0.8);
  const up60 = run(60, 1, 0.8);
  const up120 = run(120, 1, 0.8);
  assert.ok(Math.abs(up30 - up60) < 0.02 && Math.abs(up60 - up120) < 0.02);
  const rise = run(60, 1, 1, 0);
  const fall = 1 - run(60, 0, 1, 1);
  assert.ok(rise > fall, "rise tau (0.4s) is faster than fall tau (3s)");
});

test("activityOf inverts energyFromActivity", () => {
  for (const a of [0, 0.25, 0.5, 1]) {
    assert.ok(Math.abs(activityOf(energyFromActivity(a, true, false)) - a) < 1e-9);
  }
});
