/**
 * Directive 40: usage-driven feeder traces. Mapping, source priority, hysteresis/easing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  atomFeederSignal,
  callsPerMinute,
  createFeederState,
  feederLine,
  feederSignal,
  feederTarget,
  stepFeeder,
  FEEDER_DEADBAND,
  FEEDER_RANGE,
} from "../../../src/plugins/atomic-topology/scene/feederUsage.ts";
import { placeBoardParts } from "../../../src/plugins/atomic-topology/scene/boardComponents.ts";
import { routeTraces } from "../../../src/plugins/atomic-topology/scene/traceRouter.ts";

test("mapping: zero at zero, null -> none, bounded, monotonic", () => {
  assert.equal(feederTarget({ basis: "none", value: 0 }), 0);
  assert.equal(feederTarget({ basis: "tps", value: 0 }), 0);
  assert.equal(feederTarget(feederSignal({ tps: null, inFlight: null, callsPerMin: null })), 0);
  for (const basis of ["tps", "inflight", "calls"] as const) {
    let prev = 0;
    for (let v = 0.1; v < FEEDER_RANGE[basis].max * 4; v *= 1.3) {
      const t = feederTarget({ basis, value: v });
      assert.ok(t >= prev, `${basis} monotonic at ${v}`);
      assert.ok(t >= 0 && t <= 1, `${basis} bounded at ${v}`);
      prev = t;
    }
    assert.equal(feederTarget({ basis, value: FEEDER_RANGE[basis].max * 10 }), 1, "saturates");
  }
  // Proportional and log-style: ~20 tok/s is clearly below ~80 tok/s, both lit.
  const t20 = feederTarget({ basis: "tps", value: 20 });
  const t80 = feederTarget({ basis: "tps", value: 80 });
  assert.ok(t20 > 0.3 && t20 < t80 && t80 < 1, `t20=${t20} t80=${t80}`);
  for (const bad of [NaN, -5, Infinity])
    assert.equal(feederTarget({ basis: "tps", value: bad }), 0);
});

test("source priority: tok/s, else in-flight, else call-log rate; stale in-flight ignored", () => {
  assert.deepEqual(feederSignal({ tps: 12, inFlight: 3, callsPerMin: 9 }), {
    basis: "tps",
    value: 12,
  });
  assert.deepEqual(feederSignal({ tps: null, inFlight: 3, callsPerMin: 9 }), {
    basis: "inflight",
    value: 3,
  });
  assert.deepEqual(feederSignal({ tps: null, inFlight: 3, callsPerMin: 9, inFlightStale: true }), {
    basis: "calls",
    value: 9,
  });
  // A measured zero tok/s with real in-flight work: the active source wins.
  assert.equal(feederSignal({ tps: 0, inFlight: 2, callsPerMin: null }).basis, "inflight");
  // All measured zero: observed quiet on the first basis, no effect.
  const quiet = feederSignal({ tps: 0, inFlight: 0, callsPerMin: 0 });
  assert.deepEqual(quiet, { basis: "tps", value: 0 });
  assert.equal(feederTarget(quiet), 0);
  assert.deepEqual(feederSignal({ tps: undefined, inFlight: NaN, callsPerMin: -1 }), {
    basis: "none",
    value: 0,
  });
});

test("call-log rate counts real started requests in the window only", () => {
  const now = 1_000_000;
  const ev = [
    { at: now - 1_000, kind: "request-started", providerId: "a" },
    { at: now - 30_000, kind: "request-started", providerId: "a" },
    { at: now - 90_000, kind: "request-started", providerId: "a" }, // outside 60 s
    { at: now - 2_000, kind: "request-completed", providerId: "a" }, // not a call start
    { at: now - 2_000, kind: "request-started", providerId: "b" },
  ];
  assert.equal(callsPerMinute(ev, "a", now), 2);
  assert.equal(callsPerMinute(ev, null, now), 3, "hub: every provider");
  assert.equal(callsPerMinute(null, "a", now), null, "no feed -> null, never 0");
  const dev = atomFeederSignal(
    { kind: "gpu", measuredTps: null, activeRequests: null, deviceFacts: { activeJobs: null } },
    { events: ev, nowMs: now, inFlightStale: false }
  );
  assert.equal(dev.basis, "none", "a device atom has no call log");
});

test("easing: frame-rate independent, ~0.5-1 s, hysteresis deadband, zero always applies", () => {
  const a = createFeederState();
  const b = createFeederState();
  for (let i = 0; i < 60; i += 1) stepFeeder(a, 0.8, 1 / 60);
  for (let i = 0; i < 240; i += 1) stepFeeder(b, 0.8, 1 / 240);
  assert.ok(Math.abs(a.level - b.level) < 1e-6, "same after 1 s at 60 vs 240 fps");
  assert.ok(a.level > 0.8 * 0.9 && a.level < 0.8, `~95 % at 1 s (${a.level})`);
  const half = createFeederState();
  stepFeeder(half, 1, 0.5);
  assert.ok(half.level > 0.6 && half.level < 0.9, "most of the way by 0.5 s");
  // Hysteresis: a small wobble inside the deadband does not move the goal.
  const h = createFeederState();
  stepFeeder(h, 0.5, 10);
  stepFeeder(h, 0.5 + FEEDER_DEADBAND * 0.5, 10);
  assert.equal(h.goal, 0.5);
  stepFeeder(h, 0.5 + FEEDER_DEADBAND * 2, 10);
  assert.ok(h.goal > 0.5);
  // Usage stopping is never held by the deadband, and settles to exactly 0.
  stepFeeder(h, 0.01, 10);
  assert.equal(h.goal, 0);
  assert.equal(h.level, 0);
  // Reduced motion: instant.
  const r = createFeederState();
  assert.equal(stepFeeder(r, 0.7, 0, true), 0.7);
});

test("explanation line names the basis and says idle when there is none", () => {
  assert.match(
    feederLine({ basis: "tps", value: 24 }, null),
    /measured output tok\/s \(24\.0 tok\/s\)/
  );
  assert.match(
    feederLine({ basis: "inflight", value: 3 }, 2500),
    /live in-flight requests \(3 in flight, 3 s ago\)/
  );
  assert.match(feederLine({ basis: "none", value: 0 }, null), /idle \(no measured usage/);
  assert.match(feederLine({ basis: "calls", value: 0 }, null), /observed quiet: no effect/);
});

test("router: every atom pad is fed by tagged nets; branches inherit; others decorative", () => {
  const EXT = { wallX: 1100, ceilY: 700, nearZ: 1000, farZ: -1200, floorY: -66 };
  const PADS = [
    { x: 0, z: 0, r: 120 },
    { x: -420, z: -260, r: 62 },
    { x: 400, z: -300, r: 62 },
    { x: -360, z: 330, r: 62 },
    { x: 380, z: 360, r: 62 },
  ];
  const L = routeTraces(EXT, PADS, placeBoardParts(EXT, PADS));
  const fedPads = new Set(L.segments.filter((s) => s.feed >= 0).map((s) => s.feed));
  assert.deepEqual([...fedPads].sort(), [0, 1, 2, 3, 4], "each pad has feeder nets");
  assert.ok(
    L.segments.some((s) => s.feed === -1),
    "decorative nets remain"
  );
  for (const s of L.segments) assert.ok(s.feed >= -1 && s.feed < PADS.length);
  // Terminals / joints carry the same tag as their net.
  assert.ok(L.terminals.some((t) => t.feed >= 0) && L.joints.some((j) => j.feed >= 0));
});
