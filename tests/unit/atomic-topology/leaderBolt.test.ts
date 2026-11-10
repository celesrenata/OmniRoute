import test from "node:test";
import assert from "node:assert/strict";
import {
  LEADER_MAX_SEGMENTS,
  buildLeaderBolt,
} from "../../../src/plugins/atomic-topology/scene/leaderBolt";
import {
  STRIKE_PROFILES,
  afterglow,
  restrikeIndex,
  strikeLife,
  strokeEnvelope,
} from "../../../src/plugins/atomic-topology/scene/strikeTimeline";

test("buildLeaderBolt: deterministic by seed, different seeds differ", () => {
  const a = buildLeaderBolt({ seed: 7 });
  const b = buildLeaderBolt({ seed: 7 });
  const c = buildLeaderBolt({ seed: 8 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(
    a.segments.map((s) => s.b),
    c.segments.map((s) => s.b)
  );
});

test("buildLeaderBolt: main channel runs exactly from (0,0,0) to (0,0,1) and is connected", () => {
  for (const seed of [1, 2, 3, 11, 99, 4242]) {
    const main = buildLeaderBolt({ seed }).segments.filter((s) => s.generation === 0);
    assert.ok(main.length >= 4, "channel has several leader steps");
    assert.deepEqual(main[0].a, [0, 0, 0]);
    assert.deepEqual(main[main.length - 1].b, [0, 0, 1]);
    for (let i = 1; i < main.length; i += 1) assert.deepEqual(main[i].a, main[i - 1].b);
  }
});

test("buildLeaderBolt: birth grows along the channel (the leader tip advances) and stays in [0,1]", () => {
  const bolt = buildLeaderBolt({ seed: 5 });
  const main = bolt.segments.filter((s) => s.generation === 0);
  for (let i = 1; i < main.length; i += 1) assert.ok(main[i].birth >= main[i - 1].birth);
  assert.ok(main[main.length - 1].birth > 0.85, "tip reaches the end before the return stroke");
  for (const s of bolt.segments) assert.ok(s.birth >= 0 && s.birth <= 1);
});

test("buildLeaderBolt: multi-generation branches that thin out and are bounded", () => {
  let gens = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const bolt = buildLeaderBolt({ seed, branchDepth: 3 });
    assert.ok(bolt.segments.length <= LEADER_MAX_SEGMENTS);
    const count = [0, 0, 0, 0];
    for (const s of bolt.segments) count[s.generation] += 1;
    gens = Math.max(gens, ...bolt.segments.map((s) => s.generation));
    assert.ok(count[1] > 0, `seed ${seed}: main channel sprouts branches`);
    assert.ok(count[2] <= count[1] + count[0], "deeper generations thin out");
  }
  assert.ok(gens >= 2, "at least one seed grows a sub-branch");
});

test("buildLeaderBolt: branches are born after their parent point is reached", () => {
  const bolt = buildLeaderBolt({ seed: 21 });
  const main = bolt.segments.filter((s) => s.generation === 0);
  for (const s of bolt.segments.filter((x) => x.generation === 1)) {
    assert.ok(s.birth >= Math.min(...main.map((m) => m.birth)));
  }
});

test("buildLeaderBolt: the channel meanders (not a straight line) yet stays near the axis", () => {
  const main = buildLeaderBolt({ seed: 9 }).segments.filter((s) => s.generation === 0);
  const lateral = main.map((s) => Math.hypot(s.b[0], s.b[1]));
  assert.ok(Math.max(...lateral) > 0.01, "meanders laterally");
  assert.ok(Math.max(...lateral) < 0.6, "stays bounded around the axis");
});

test("strikeTimeline: strokes only after the leader, re-strike decays, afterglow smooth", () => {
  for (const kind of ["failure", "completion"] as const) {
    const p = STRIKE_PROFILES[kind];
    assert.equal(strokeEnvelope(kind, p.leaderS - 0.01), 0, "dim before the return stroke");
    assert.ok(strokeEnvelope(kind, p.leaderS) >= 0.99, "return stroke at full amplitude");
    assert.ok(strokeEnvelope(kind, p.leaderS + 0.04) < strokeEnvelope(kind, p.leaderS));
    assert.ok(strokeEnvelope(kind, strikeLife(kind)) < 0.02, "dark by the end of its life");
    assert.ok(afterglow(kind, strikeLife(kind)) < 0.12, "afterglow has decayed");
    assert.equal(afterglow(kind, -1), 0);
    assert.equal(restrikeIndex(kind, p.leaderS - 0.01), -1);
  }
});

test("strikeTimeline: failure re-strikes more than completion (violent vs crisp)", () => {
  assert.ok(
    STRIKE_PROFILES.failure.strokeOffsets.length > STRIKE_PROFILES.completion.strokeOffsets.length
  );
  assert.ok(strikeLife("failure") > strikeLife("completion"));
  const f = STRIKE_PROFILES.failure;
  assert.ok(restrikeIndex("failure", f.leaderS + 0.6) === f.strokeOffsets.length - 1);
  assert.ok(
    strokeEnvelope("failure", f.leaderS + f.strokeOffsets[1] + 0.002) > 0.6,
    "second stroke visibly re-strikes"
  );
});
