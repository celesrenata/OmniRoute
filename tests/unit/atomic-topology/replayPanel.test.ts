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

const html = (c: ReplayController) =>
  renderToStaticMarkup(createElement(AtomicReplayPanel, { controller: c, onExit: () => {} }));

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
