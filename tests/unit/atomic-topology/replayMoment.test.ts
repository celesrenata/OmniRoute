/**
 * Step 12 fix round (directive 42.1): the panel and the detail line must reflect the REPLAYED
 * moment (quiet / in flight / completed / failed) from recorded requests only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  REPLAY_RESULT_HOLD_MS,
  replayMoment,
  replayMomentLabel,
  type ReplayRequest,
} from "../../../src/plugins/atomic-topology/scene/replaySnapshot.ts";
import { replayedActivityLine } from "../../../src/plugins/atomic-topology/scene/detailState.ts";

const T = 1_000_000;
const req = (
  key: string,
  startAt: number,
  endAt: number | null,
  outcome: "ok" | "failed" | null
): ReplayRequest => ({ key, providerKey: "kiro", startAt, endAt, outcome });

test("quiet before any recorded request", () => {
  const m = replayMoment([req("a", T + 5000, T + 9000, "ok")], T);
  assert.deepEqual(m, { state: "quiet", inFlight: 0 });
  assert.equal(replayMomentLabel(m), "quiet");
});
test("in flight between the recorded start and the recorded end", () => {
  const m = replayMoment([req("a", T, T + 4000, "ok")], T + 2000);
  assert.deepEqual(m, { state: "in-flight", inFlight: 1 });
  assert.equal(replayMomentLabel(m), "1 in flight");
});
test("an open (status-less) request stays in flight; a zero-span record is never in flight", () => {
  assert.equal(replayMoment([req("a", T, null, null)], T + 60_000).inFlight, 1);
  assert.equal(replayMoment([req("b", T, T, "ok")], T).inFlight, 0);
});
test("completed then failed are held for the result hold, then it is quiet again", () => {
  const ok = [req("a", T, T + 1000, "ok")];
  assert.equal(replayMoment(ok, T + 1500).state, "completed");
  assert.equal(replayMoment(ok, T + 1000 + REPLAY_RESULT_HOLD_MS).state, "quiet");
  const bad = [req("b", T, T + 1000, "failed")];
  assert.equal(replayMoment(bad, T + 1500).state, "failed");
  assert.equal(replayMoment(bad, T + 1000 + REPLAY_RESULT_HOLD_MS).state, "quiet");
});
test("replayed activity wording follows the replayed descriptor, never live idle", () => {
  const d = (state: string, n: number | null) =>
    ({ visualState: { state }, activeRequests: n }) as never;
  assert.match(
    replayedActivityLine(d("active", 2)),
    /^replayed · in flight \(2 recorded requests\)/
  );
  assert.match(replayedActivityLine(d("active", 1)), /1 recorded request\)/);
  assert.match(replayedActivityLine(d("error", null)), /^replayed · failed/);
  assert.match(replayedActivityLine(d("last", null)), /^replayed · completed/);
  assert.match(replayedActivityLine(d("healthy", null)), /^replayed · quiet/);
  assert.doesNotMatch(replayedActivityLine(d("healthy", null)), /measured activity/);
});
