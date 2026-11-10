import test from "node:test";
import assert from "node:assert/strict";
import {
  ORBIT_DAMPING_60,
  SYNC_REFRESH_KEY,
  TARGET_FPS,
  createFrameThrottle,
  getSyncRefresh,
  orbitDampingFor,
  readSyncRefresh,
  subscribeSyncRefresh,
  writeSyncRefresh,
} from "../../../src/plugins/atomic-topology/scene/frameRate";

// Operator directive 45: 30 fps by default, a real throttle (skipped ticks do nothing).

/** Simulate rAF ticks at `hz` (with optional jitter) for `seconds`; return rendered timestamps. */
function run(hz: number, seconds: number, jitterMs = 0, fps = TARGET_FPS): number[] {
  const th = createFrameThrottle(fps);
  const out: number[] = [];
  const period = 1000 / hz;
  for (let i = 0; i * period <= seconds * 1000; i += 1) {
    const j = jitterMs ? Math.sin(i * 12.9898) * jitterMs : 0;
    const t = 1000 + i * period + j;
    if (th.due(t)) out.push(t);
  }
  return out;
}

test("throttle holds 30 fps on 60, 120 and 144 Hz displays (with rAF jitter)", () => {
  assert.equal(TARGET_FPS, 30);
  for (const hz of [60, 120, 144, 90, 240]) {
    for (const jitter of [0, 0.8]) {
      const f = run(hz, 10, jitter);
      const fps = (f.length - 1) / ((f[f.length - 1] - f[0]) / 1000);
      assert.ok(Math.abs(fps - 30) < 0.6, `${hz} Hz jitter ${jitter}: ${fps.toFixed(2)} fps`);
      // Never two frames within one display period, never a gap beyond one interval + period.
      for (let i = 1; i < f.length; i += 1) {
        const d = f[i] - f[i - 1];
        assert.ok(d > 1000 / 30 - 1000 / hz - 2.5, `${hz} Hz: gap ${d.toFixed(2)} too short`);
        assert.ok(d < 1000 / 30 + 1000 / hz + 2.5, `${hz} Hz: gap ${d.toFixed(2)} too long`);
      }
    }
  }
});

test("throttle: 60 Hz renders exactly every 2nd tick, 120 Hz every 4th", () => {
  const th60 = createFrameThrottle(30);
  const ticks60 = Array.from({ length: 12 }, (_, i) => th60.due(i * (1000 / 60)));
  assert.deepEqual(ticks60, [
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
  ]);
  const th120 = createFrameThrottle(30);
  const ticks120 = Array.from({ length: 12 }, (_, i) => th120.due(i * (1000 / 120)));
  assert.deepEqual(ticks120, [
    true,
    false,
    false,
    false,
    true,
    false,
    false,
    false,
    true,
    false,
    false,
    false,
  ]);
});

test("throttle: a skipped tick is a pure no-op (does not move the cadence)", () => {
  const a = createFrameThrottle(30);
  const b = createFrameThrottle(30);
  a.due(0);
  b.due(0);
  // b sees extra early ticks that must be rejected and leave its state untouched.
  for (const t of [1, 5, 10, 20, 30]) assert.equal(b.due(t), false);
  assert.equal(a.due(33.4), b.due(33.4));
  assert.equal(a.due(50), b.due(50));
  assert.equal(a.due(66.7), b.due(66.7));
});

test("throttle: re-anchors after a stall instead of bursting; reset renders the next tick", () => {
  const th = createFrameThrottle(30);
  assert.equal(th.due(0), true);
  assert.equal(th.due(1000), true); // long stall: one frame, then normal cadence
  assert.equal(th.due(1016.7), false);
  assert.equal(th.due(1033.4), true);
  th.reset();
  assert.equal(th.due(1040), true);
  assert.equal(th.due(Number.NaN), false);
});

test("throttle: fps <= 0 means every tick (synced mode)", () => {
  const th = createFrameThrottle(0);
  assert.deepEqual([th.due(0), th.due(1), th.due(2)], [true, true, true]);
});

test("sync preference: default off (30 fps), persisted as 1/0, broadcast to listeners", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  assert.equal(readSyncRefresh(storage), false);
  assert.equal(readSyncRefresh(null), false);
  const seen: boolean[] = [];
  const un = subscribeSyncRefresh((v) => seen.push(v));
  writeSyncRefresh(true, storage);
  assert.equal(store.get(SYNC_REFRESH_KEY), "1");
  assert.equal(readSyncRefresh(storage), true);
  assert.equal(getSyncRefresh(), true);
  writeSyncRefresh(false, storage);
  assert.equal(store.get(SYNC_REFRESH_KEY), "0");
  assert.equal(getSyncRefresh(), false);
  un();
  writeSyncRefresh(true, storage);
  assert.deepEqual(seen, [true, false]);
  // Blocked storage never throws.
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readSyncRefresh(blocked), false);
  writeSyncRefresh(false, blocked);
  assert.equal(getSyncRefresh(), false);
});

test("orbit damping is time-based: same glide length in seconds at 30, 60 and 120 fps", () => {
  assert.ok(Math.abs(orbitDampingFor(1 / 60) - ORBIT_DAMPING_60) < 1e-12);
  const remainingAfter = (fps: number, seconds: number) => {
    let r = 1;
    const k = orbitDampingFor(1 / fps);
    for (let i = 0; i < Math.round(fps * seconds); i += 1) r *= 1 - k;
    return r;
  };
  for (const s of [0.1, 0.2, 0.5]) {
    const r60 = remainingAfter(60, s);
    assert.ok(Math.abs(remainingAfter(30, s) - r60) < 1e-9, `30 fps at ${s}s`);
    assert.ok(Math.abs(remainingAfter(120, s) - r60) < 1e-9, `120 fps at ${s}s`);
  }
  assert.ok(orbitDampingFor(1 / 30) > orbitDampingFor(1 / 120));
  assert.ok(Math.abs(orbitDampingFor(Number.NaN) - ORBIT_DAMPING_60) < 1e-12);
});
