/**
 * Step 12 UI: the REPLAY marker is persistent while a session exists, the controls are native
 * keyboard-operable elements, and the empty / loading / error states are explicit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AtomicReplayPanel,
  replayMarkerText,
} from "../../../src/plugins/atomic-topology/overlays/AtomicReplayPanel.tsx";
import {
  createReplayController,
  type ReplayController,
} from "../../../src/plugins/atomic-topology/scene/replayController.ts";
import { buildTraceTimeline } from "../../../src/shared/topology/telemetry/traceHistory.ts";

const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const WINDOW = 5 * 60_000;
const base = {
  schemaVersion: 1 as const,
  capturedAt: T0,
  nodes: [],
  links: [],
};

function controller(rows: unknown[], fail = false): ReplayController {
  return createReplayController({
    getBaseSnapshot: () => base,
    fetchHistory: async () => {
      if (fail) throw new Error("x");
      return {
        timeline: buildTraceTimeline(rows as never, { sinceMs: T0, untilMs: T0 + WINDOW }),
        fetchedRows: rows.length,
        truncated: false,
      };
    },
    onSnapshot: () => {},
    scheduler: { setInterval: () => 0, clearInterval: () => {} },
  });
}

const html = (c: ReplayController, initialExpanded = true) =>
  renderToStaticMarkup(
    createElement(AtomicReplayPanel, { controller: c, onExit: () => {}, initialExpanded })
  );

test("renders nothing until a session exists", () => {
  assert.equal(html(controller([])), "");
});

test("loading: marker says REPLAY and 'loading', controls are disabled", async () => {
  const c = controller([]);
  const p = c.open(WINDOW);
  const out = html(c);
  assert.match(out, /data-atomic-replay-marker/);
  assert.match(out, /REPLAY · loading recorded requests/);
  assert.match(out, /Loading recorded requests/);
  assert.doesNotMatch(out, /type="range"/);
  await p;
});

test("ready: marker shows the playhead time, native controls and a labelled scrubber exist", async () => {
  const c = controller([
    {
      id: "1",
      timestamp: new Date(T0 + 10_000).toISOString(),
      provider: "openai",
      model: "gpt-4o",
      status: 200,
      duration: 100,
    },
  ]);
  await c.open(WINDOW);
  const out = html(c);
  assert.match(out, /REPLAY · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(out, /recorded history, not live/);
  assert.match(out, /aria-label="Play replay"/);
  assert.match(out, /aria-label="Replay position"/);
  assert.match(out, /type="range"/);
  for (const s of ["1", "4", "16"]) assert.match(out, new RegExp(`aria-label="Speed ${s}x"`));
  assert.match(out, /aria-label="Previous recorded event"/);
  assert.match(out, /aria-label="Next recorded event"/);
  assert.match(out, /aria-label="Exit replay and return to live"/);
  assert.match(out, /2 recorded events from 1 requests/);
  assert.match(out, /Health and device telemetry are not replayed/);
  assert.equal(replayMarkerText(c.getView()).startsWith("REPLAY · "), true);
});

test("empty history: says so and disables the transport (nothing to replay)", async () => {
  const c = controller([]);
  await c.open(WINDOW);
  const out = html(c);
  assert.match(out, /No recorded requests in the last 5 min/);
  assert.doesNotMatch(out, /type="range"/);
  assert.match(
    out,
    /<button[^>]*disabled[^>]*aria-label="Play replay"|aria-label="Play replay"[^>]*disabled/
  );
});

test("error: generic message plus a Retry, marker still says REPLAY", async () => {
  const c = controller([], true);
  await c.open(WINDOW);
  const out = html(c);
  assert.match(out, /REPLAY · history unavailable/);
  assert.match(out, /Could not load recorded requests/);
  assert.match(out, />Retry</);
});

// ---- Step 12 fix round (directive 42.4): neutral loading state, never the live scene
import {
  AtomicReplayCover,
  replayCoverVisible,
} from "../../../src/plugins/atomic-topology/overlays/AtomicReplayCover.tsx";
const cover = (c: ReplayController) =>
  renderToStaticMarkup(createElement(AtomicReplayCover, { controller: c }));
test("loading: an opaque neutral cover hides the live scene until the history arrives", async () => {
  const c = controller([]);
  assert.equal(cover(c), "", "closed: no cover");
  const p = c.open(WINDOW);
  const out = cover(c);
  assert.match(out, /data-atomic-replay-cover="loading"/);
  assert.match(out, /Loading recorded requests/);
  assert.match(out, /background:#05070f/);
  await p;
  assert.equal(cover(c), "", "ready: cover removed");
});
test("error: the cover stays (no live scene under the banner) and points at Retry / Exit", async () => {
  const c = controller([], true);
  await c.open(WINDOW);
  assert.match(cover(c), /data-atomic-replay-cover="error"/);
  assert.equal(replayCoverVisible("ready"), false);
  assert.equal(replayCoverVisible("closed"), false);
});

// ---- Step 12 fix round (directive 42.2): slim collapsible transport bar
const one = [
  {
    id: "1",
    timestamp: new Date(T0 + 10_000).toISOString(),
    provider: "openai",
    model: "gpt-4o",
    status: 200,
    duration: 100,
  },
];
test("collapsed (default): slim bar keeps play, step, speed, scrubber, time, moment and Exit", async () => {
  const c = controller(one);
  await c.open(WINDOW);
  const out = html(c, false);
  assert.match(out, /data-expanded="false"/);
  for (const l of [
    "Play replay",
    "Previous recorded event",
    "Next recorded event",
    "Speed 16x",
    "Replay position",
    "Exit replay and return to live",
    "Expand replay options",
  ])
    assert.match(out, new RegExp(`aria-label="${l}"`));
  assert.match(out, /aria-expanded="false"/);
  assert.match(out, /data-atomic-replay-moment="quiet"/);
  assert.match(out, /data-atomic-replay-time/);
  // the optional parts are not rendered
  assert.doesNotMatch(out, /Replay window/);
  assert.doesNotMatch(out, /recorded events from/);
});
test("expanded: window, loop, range and the summary appear; toggle is labelled Collapse", async () => {
  const c = controller(one);
  await c.open(WINDOW);
  const out = html(c, true);
  assert.match(out, /data-expanded="true"/);
  assert.match(out, /aria-label="Replay window"/);
  assert.match(out, /Loop/);
  assert.match(out, /aria-label="Collapse replay options"/);
});
test("the moment chip follows the playhead (in flight / completed)", async () => {
  const c = controller([
    { ...one[0], id: "x", timestamp: new Date(T0 + 10_000).toISOString(), duration: 4000 },
  ]);
  await c.open(WINDOW);
  c.seek(T0 + 12_000);
  assert.match(html(c, false), /data-atomic-replay-moment="in-flight"[^>]*>fleet · 1 in flight</);
  c.seek(T0 + 14_500);
  assert.match(html(c, false), /data-atomic-replay-moment="completed"/);
});
test("a capped history is flagged in the collapsed bar", async () => {
  const c = createReplayController({
    getBaseSnapshot: () => base,
    fetchHistory: async () => ({
      timeline: buildTraceTimeline(one as never, { sinceMs: T0, untilMs: T0 + WINDOW }),
      fetchedRows: 2000,
      truncated: true,
    }),
    onSnapshot: () => {},
    scheduler: { setInterval: () => 0, clearInterval: () => {} },
  });
  await c.open(WINDOW);
  assert.match(html(c, false), /data-atomic-replay-truncated/);
  assert.match(html(c, true), /history capped; oldest rows omitted/);
});
test("loading / error states keep the status line and Exit in the collapsed bar", async () => {
  const c = controller([]);
  const p = c.open(WINDOW);
  const out = html(c, false);
  assert.match(out, /Loading recorded requests/);
  assert.match(out, /aria-label="Exit replay and return to live"/);
  await p;
});
test("the marker never reaches under the detail panel", async () => {
  const c = controller(one);
  await c.open(WINDOW);
  const out = renderToStaticMarkup(
    createElement(AtomicReplayPanel, { controller: c, onExit: () => {}, reservedRight: 344 })
  );
  assert.match(out, /max-width:calc\(100% - 360px\)/);
});
