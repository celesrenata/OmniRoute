/**
 * Step 12: request-trace history. Ordering, bounds, error rows -> failure events,
 * empty history -> empty replay, no events outside the range, no synthetic events.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTraceTimeline,
  countByProvider,
  recordsBetween,
} from "../../../src/shared/topology/telemetry/traceHistory.ts";
import {
  TRACE_PAGE_SIZE,
  fetchTraceHistory,
  traceHistoryUrl,
} from "../../../src/shared/topology/telemetry/traceHistoryFetch.ts";

const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const row = (over: Record<string, unknown>) => ({
  id: "r1",
  timestamp: iso(T0 + 1000),
  provider: "openai",
  model: "gpt-4o",
  status: 200,
  duration: 500,
  tokens: { in: 10, out: 20 },
  ...over,
});
const win = { sinceMs: T0, untilMs: T0 + 60_000 };

test("a finished row yields started + one terminal record at timestamp + duration", () => {
  const tl = buildTraceTimeline([row({})], win);
  assert.deepEqual(
    tl.records.map((r) => [r.kind, r.at - T0]),
    [
      ["request-started", 1000],
      ["request-completed", 1500],
    ]
  );
  assert.equal(tl.rowCount, 1);
  const [s, c] = tl.records;
  assert.equal(s.providerId, "openai");
  assert.equal(s.linkId, "route:openai");
  assert.equal(s.modelId, "gpt-4o");
  assert.equal(c.status, 200);
  assert.deepEqual(c.tokens, { in: 10, out: 20 });
  assert.equal(c.durationMs, 500);
});

test("error rows (status >= 400 or an error summary) become request-failed", () => {
  const tl = buildTraceTimeline(
    [
      row({ id: "a", status: 502 }),
      row({ id: "b", status: 200, error: "upstream reset", timestamp: iso(T0 + 2000) }),
    ],
    win
  );
  const terminals = tl.records.filter((r) => r.kind !== "request-started");
  assert.deepEqual(
    terminals.map((r) => [r.resourceId, r.kind]),
    [
      ["a", "request-failed"],
      ["b", "request-failed"],
    ]
  );
});

test("in-flight and status-less rows get a started record only (no invented outcome)", () => {
  const tl = buildTraceTimeline(
    [
      row({ id: "live", active: true, status: 0 }),
      row({ id: "nostatus", status: undefined, timestamp: iso(T0 + 3000) }),
    ],
    win
  );
  assert.deepEqual(
    tl.records.map((r) => r.kind),
    ["request-started", "request-started"]
  );
});

test("empty / null history gives an empty replay", () => {
  assert.equal(buildTraceTimeline([], win).records.length, 0);
  assert.equal(buildTraceTimeline(null, win).records.length, 0);
  assert.equal(buildTraceTimeline(undefined, win).rowCount, 0);
});

test("no events outside the window; a boundary-straddling request keeps only the in-range side", () => {
  const before = row({ id: "before", timestamp: iso(T0 - 5000) });
  const after = row({ id: "after", timestamp: iso(T0 + 60_001) });
  const straddleStart = row({ id: "s1", timestamp: iso(T0 - 100), duration: 400 });
  const straddleEnd = row({ id: "s2", timestamp: iso(T0 + 59_800), duration: 400 });
  const tl = buildTraceTimeline([before, after, straddleStart, straddleEnd], win);
  for (const r of tl.records) assert.ok(r.at >= win.sinceMs && r.at <= win.untilMs);
  assert.deepEqual(
    tl.records.map((r) => `${r.resourceId}:${r.kind}`),
    ["s1:request-completed", "s2:request-started"]
  );
});

test("records are ordered by time, start before outcome on ties, then id", () => {
  const tl = buildTraceTimeline(
    [
      row({ id: "z", timestamp: iso(T0 + 5000), duration: 0 }),
      row({ id: "a", timestamp: iso(T0 + 1000), duration: 4000 }),
      row({ id: "m", timestamp: iso(T0 + 3000), duration: 2000 }),
    ],
    win
  );
  const ats = tl.records.map((r) => r.at);
  assert.deepEqual(
    ats,
    [...ats].sort((x, y) => x - y)
  );
  const atFive = tl.records.filter((r) => r.at === T0 + 5000).map((r) => r.id);
  assert.deepEqual(atFive, [
    "request-started:z",
    "request-completed:a",
    "request-completed:m",
    "request-completed:z",
  ]);
});

test("duplicate row ids, connection-test probes, unparseable timestamps and provider-less rows are dropped", () => {
  const tl = buildTraceTimeline(
    [
      row({ id: "dup" }),
      row({ id: "dup" }),
      row({ id: "probe", model: "connection-test" }),
      row({ id: "badts", timestamp: "not a date" }),
      row({ id: "noprov", provider: "" }),
    ],
    win
  );
  assert.deepEqual([...new Set(tl.records.map((r) => r.resourceId))], ["dup"]);
  assert.equal(tl.records.length, 2);
});

test("lane is classified only when the model classifies; a missing duration is not interpolated", () => {
  const tl = buildTraceTimeline(
    [
      row({ id: "x", model: "totally-unknown-model-xyz", duration: undefined }),
      row({ id: "y", model: "text-embedding-3-small", timestamp: iso(T0 + 9000) }),
    ],
    win
  );
  const x = tl.records.filter((r) => r.resourceId === "x");
  assert.equal(x[0].lane, undefined);
  assert.equal(x[0].durationMs, undefined);
  // no duration: the terminal sits at the row timestamp, never a guessed later time
  assert.equal(x[1].at, x[0].at);
});

test("countByProvider and recordsBetween", () => {
  const tl = buildTraceTimeline(
    [
      row({ id: "1" }),
      row({ id: "2", provider: "anthropic", status: 500, timestamp: iso(T0 + 2000) }),
    ],
    win
  );
  assert.deepEqual(countByProvider(tl.records), {
    openai: { started: 1, completed: 1, failed: 0 },
    anthropic: { started: 1, completed: 0, failed: 1 },
  });
  const mid = recordsBetween(tl.records, T0 + 1000, T0 + 2000);
  // (1000, 2000]: openai completed @1500, anthropic started @2000
  assert.deepEqual(
    mid.map((r) => r.id),
    ["request-completed:1", "request-started:2"]
  );
  assert.equal(recordsBetween(tl.records, T0 + 60_000, T0 + 61_000).length, 0);
});

test("traceHistoryUrl carries since/until/offset/limit and excludeTests", () => {
  const u = new URL(traceHistoryUrl(T0, T0 + 1000, 400), "http://x");
  assert.equal(u.pathname, "/api/usage/call-logs");
  assert.equal(u.searchParams.get("since"), iso(T0));
  assert.equal(u.searchParams.get("until"), iso(T0 + 1000));
  assert.equal(u.searchParams.get("offset"), "400");
  assert.equal(u.searchParams.get("limit"), String(TRACE_PAGE_SIZE));
  assert.equal(u.searchParams.get("excludeTests"), "1");
});

function fakeFetch(pages: unknown[][], seen: string[]): typeof fetch {
  return (async (url: string) => {
    seen.push(url);
    const idx = Number(new URL(url, "http://x").searchParams.get("offset")) / TRACE_PAGE_SIZE;
    return { ok: true, status: 200, json: async () => pages[idx] ?? [] } as Response;
  }) as unknown as typeof fetch;
}

test("fetchTraceHistory pages until a short page and de-dupes rows repeated across pages", async () => {
  const full = Array.from({ length: TRACE_PAGE_SIZE }, (_, i) =>
    row({ id: `p0-${i}`, timestamp: iso(T0 + 1000 + i) })
  );
  const tail = [row({ id: "p0-0" }), row({ id: "tail", timestamp: iso(T0 + 30_000) })];
  const seen: string[] = [];
  const res = await fetchTraceHistory({
    windowMs: 60_000,
    nowMs: T0 + 60_000,
    fetchImpl: fakeFetch([full, tail], seen),
  });
  assert.equal(seen.length, 2);
  assert.equal(res.fetchedRows, TRACE_PAGE_SIZE + 1);
  assert.equal(res.truncated, false);
  assert.equal(res.timeline.rowCount, TRACE_PAGE_SIZE + 1);
});

test("fetchTraceHistory surfaces HTTP failures and malformed bodies", async () => {
  const bad = (async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  await assert.rejects(fetchTraceHistory({ windowMs: 1000, nowMs: T0, fetchImpl: bad }), /500/);
  const obj = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  await assert.rejects(
    fetchTraceHistory({ windowMs: 1000, nowMs: T0, fetchImpl: obj }),
    /unexpected/
  );
});
