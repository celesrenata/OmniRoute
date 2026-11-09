/** Step 12: replay clock (scrub, speed, loop bounds, stepping). */
import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceReplay,
  advanceReplayStepped,
  clampSpeed,
  createReplayClock,
  nextEventTime,
  prevEventTime,
  replayProgress,
  seekReplay,
  setReplayLoop,
  setReplayPlaying,
  setReplaySpeed,
} from "../../../src/plugins/atomic-topology/scene/replayClock.ts";

const mk = (over = {}) => createReplayClock(1000, 11_000, over);

test("starts at the window start, paused", () => {
  const c = mk();
  assert.equal(c.positionMs, 1000);
  assert.equal(c.playing, false);
  assert.equal(c.speed, 1);
});

test("a paused clock never moves; bad dt is ignored; input is not mutated", () => {
  const c = mk();
  assert.equal(advanceReplay(c, 500), c);
  const p = setReplayPlaying(c, true);
  assert.equal(advanceReplay(p, 0), p);
  assert.equal(advanceReplay(p, -5), p);
  assert.equal(advanceReplay(p, Number.NaN), p);
  const moved = advanceReplay(p, 500);
  assert.equal(moved.positionMs, 1500);
  assert.equal(p.positionMs, 1000);
});

test("speed scales real time (1x / 4x / 16x); unknown speeds fall back to 1x", () => {
  for (const s of [1, 4, 16]) {
    const c = advanceReplay(setReplayPlaying(setReplaySpeed(mk(), s), true), 100);
    assert.equal(c.positionMs, 1000 + 100 * s);
  }
  assert.equal(clampSpeed(3), 1);
  assert.equal(setReplaySpeed(mk(), 99).speed, 1);
});

test("stops at the end without loop; wraps with loop", () => {
  const p = setReplayPlaying(setReplaySpeed(mk(), 16), true);
  const end = advanceReplay(seekReplay(p, 10_900), 100);
  assert.equal(end.positionMs, 11_000);
  assert.equal(end.playing, false);
  const looped = advanceReplay(setReplayLoop(seekReplay(p, 10_900), true), 100);
  assert.equal(looped.playing, true);
  // 10_900 + 1600 = 12_500 -> wraps by 1_500 into [1000, 11000)
  assert.equal(looped.positionMs, 2500);
});

test("seek clamps to the window; non-finite seeks are ignored", () => {
  assert.equal(seekReplay(mk(), -1).positionMs, 1000);
  assert.equal(seekReplay(mk(), 99_999).positionMs, 11_000);
  assert.equal(seekReplay(seekReplay(mk(), 5000), Number.NaN).positionMs, 5000);
});

test("playing from the end restarts at the start", () => {
  const c = setReplayPlaying(seekReplay(mk(), 11_000), true);
  assert.equal(c.positionMs, 1000);
  assert.equal(c.playing, true);
});

test("a zero-length window cannot play", () => {
  const z = createReplayClock(5, 5, { playing: true });
  assert.equal(advanceReplay(z, 100).playing, false);
  assert.equal(replayProgress(z), 0);
});

test("event stepping finds the next / previous recorded time", () => {
  const times = [2000, 4000, 4000, 9000];
  const c = seekReplay(mk(), 4000);
  assert.equal(nextEventTime(c, times), 9000);
  assert.equal(prevEventTime(c, times), 2000);
  assert.equal(nextEventTime(seekReplay(mk(), 9000), times), 11_000);
  assert.equal(prevEventTime(seekReplay(mk(), 2000), times), 1000);
  assert.equal(nextEventTime(mk(), []), 11_000);
});

test("reduced-motion playback jumps event to event and stops after the last", () => {
  const times = [2000, 4000];
  let c = setReplayPlaying(mk(), true);
  c = advanceReplayStepped(c, times);
  assert.equal(c.positionMs, 2000);
  c = advanceReplayStepped(c, times);
  assert.equal(c.positionMs, 4000);
  c = advanceReplayStepped(c, times);
  assert.equal(c.positionMs, 11_000);
  assert.equal(c.playing, false);
  // paused: no movement
  assert.equal(advanceReplayStepped(mk(), times).positionMs, 1000);
});

test("progress is 0..1", () => {
  assert.equal(replayProgress(mk()), 0);
  assert.equal(replayProgress(seekReplay(mk(), 6000)), 0.5);
  assert.equal(replayProgress(seekReplay(mk(), 11_000)), 1);
});
