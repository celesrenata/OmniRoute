/**
 * Directive 36: every electron orbit advances with the clock at every energy tier.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  WIRE_SPEED_MIN,
  advanceElectronClock,
  electronAngle,
  electronClockRate,
} from "../../../src/plugins/atomic-topology/scene/electronMotion.ts";
import { orbitWires } from "../../../src/plugins/atomic-topology/scene/orbitalDensity.ts";
import { SPEED_MIN } from "../../../src/plugins/atomic-topology/scene/energyState.ts";
import { WIRES_PER_ATOM } from "../../../src/plugins/atomic-topology/scene/rt/atomLayout.ts";
const TAU = Math.PI * 2;
const wrapDelta = (a: number, b: number): number => {
  const d = Math.abs(a - b) % TAU;
  return Math.min(d, TAU - d);
};
test("every wire of every seed has |speed| >= the generator floor", () => {
  for (let seed = 1; seed < 400; seed += 7) {
    for (const w of orbitWires(seed, WIRES_PER_ATOM)) {
      assert.ok(Math.abs(w.speed) >= WIRE_SPEED_MIN - 1e-9);
    }
  }
});
test("every electron group displaces visibly in 1 s at every tier (incl. the lowest)", () => {
  for (const speedMul of [SPEED_MIN, 0.4, 0.7, 1]) {
    for (const seed of [3, 41, 977, 12345]) {
      const wires = orbitWires(seed, WIRES_PER_ATOM);
      const c0 = 5;
      const c1 = advanceElectronClock(c0, 1 / 60, speedMul, false);
      let c = c0;
      for (let i = 0; i < 60; i += 1) c = advanceElectronClock(c, 1 / 60, speedMul, false);
      assert.ok(c1 > c0);
      wires.forEach((w, idx) => {
        for (const off of [0, Math.PI + 1.3]) {
          const d = wrapDelta(
            electronAngle(w.phase, w.speed, c0, off),
            electronAngle(w.phase, w.speed, c, off)
          );
          assert.ok(d > 0.3, `wire ${idx} seed ${seed} tier ${speedMul}: ${d} rad/s`);
        }
      });
    }
  }
});
test("pause (dt 0) and reduced motion hold the clock exactly", () => {
  assert.equal(advanceElectronClock(2, 0, 1, false), 2);
  assert.equal(advanceElectronClock(2, 0.016, 1, true), 2);
  assert.equal(electronClockRate(1, true), 0);
  assert.equal(advanceElectronClock(2, NaN, 1, false), 2);
});
test("rate follows the energy tier monotonically and tolerates bad input", () => {
  assert.ok(electronClockRate(1, false) > electronClockRate(0.15, false));
  assert.ok(electronClockRate(NaN, false) > 0);
  assert.ok(electronClockRate(9, false) <= electronClockRate(1, false));
});
