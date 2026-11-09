/**
 * Step 11 — opt-in GPU / atom detail view: pure state + honest view-model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AtomVisualDescriptor } from "../../../src/plugins/atomic-topology/AtomicTopologyRenderer.tsx";
import type { AtomicEvent } from "../../../src/plugins/atomic-topology/eventPool.ts";
import {
  DETAIL_CLOSED,
  DETAIL_FAILURE_WINDOW_MS,
  buildDetailModel,
  closeDetail,
  countNucleonsByModel,
  openDetail,
  resolveDetailDescriptor,
} from "../../../src/plugins/atomic-topology/scene/detailState.ts";
import { AtomicDetailPanel } from "../../../src/plugins/atomic-topology/overlays/AtomicDetailPanel.tsx";
import { AtomicTooltip } from "../../../src/plugins/atomic-topology/overlays/AtomicTooltip.tsx";

const NOW = 1_800_000_000_000;

function descriptor(over: Partial<AtomVisualDescriptor> = {}): AtomVisualDescriptor {
  return {
    id: "gpu:g1",
    kind: "gpu",
    label: "GPU g1",
    position: { x: 10, y: 0, z: 0 },
    color: "#64748B",
    modelColors: [],
    lane: "unknown",
    laneHue: "#94a3b8",
    spin: { value: 0.1, mode: "unavailable" },
    vibration: { amplitude: 0, frequencyHz: 0, mode: "unavailable" },
    measuredTps: null,
    visualState: { state: "idle", style: { width: 1, opacity: 1, animated: false } },
    activeRequests: null,
    ringIndex: 0,
    energyTier: 1,
    lastActivityAt: null,
    ...over,
  } as AtomVisualDescriptor;
}

const ids = [{ id: "hub" }, { id: "gpu:g1" }, { id: "provider:p1" }];

test("detail is opt-in: closed by default, unknown ids are ignored", () => {
  assert.equal(DETAIL_CLOSED.atomId, null);
  assert.equal(openDetail(DETAIL_CLOSED, "gpu:missing", ids, null), DETAIL_CLOSED);
  assert.equal(openDetail(DETAIL_CLOSED, "", ids, null), DETAIL_CLOSED);
});

test("open remembers the prior focus once; re-opening another atom keeps the original", () => {
  const a = openDetail(DETAIL_CLOSED, "gpu:g1", ids, "provider:p1");
  assert.deepEqual(a, { atomId: "gpu:g1", returnFocusId: "provider:p1" });
  assert.equal(openDetail(a, "gpu:g1", ids, "gpu:g1"), a, "same atom is a no-op");
  const b = openDetail(a, "provider:p1", ids, "gpu:g1");
  assert.equal(b.atomId, "provider:p1");
  assert.equal(b.returnFocusId, "provider:p1", "original focus is kept");
});

test("exit restores the previous focus, or asks for a view reset when there was none", () => {
  const withFocus = closeDetail(openDetail(DETAIL_CLOSED, "gpu:g1", ids, "provider:p1"));
  assert.equal(withFocus.restoreFocusId, "provider:p1");
  assert.equal(withFocus.resetView, false);
  assert.equal(withFocus.state.atomId, null);
  const noFocus = closeDetail(openDetail(DETAIL_CLOSED, "gpu:g1", ids, null));
  assert.equal(noFocus.restoreFocusId, null);
  assert.equal(noFocus.resetView, true);
  const idle = closeDetail(DETAIL_CLOSED);
  assert.equal(idle.resetView, false, "closing a closed view never resets the camera");
});

test("resolveDetailDescriptor: null when closed or when the atom left the snapshot", () => {
  const d = [descriptor()];
  assert.equal(resolveDetailDescriptor(DETAIL_CLOSED, d), null);
  const open = openDetail(DETAIL_CLOSED, "gpu:g1", ids, null);
  assert.equal(resolveDetailDescriptor(open, d), d[0]);
  assert.equal(resolveDetailDescriptor(open, [descriptor({ id: "gpu:other" })]), null);
});

test("null device facts read 'no data' and never 0; no fabricated job panels", () => {
  const m = buildDetailModel(
    descriptor({
      deviceFacts: {
        kind: "gpu",
        utilizationPercent: null,
        vramUsedBytes: null,
        vramTotalBytes: null,
        temperatureC: null,
        powerWatts: null,
        activeJobs: null,
        queuedJobs: null,
      },
    }),
    { now: NOW }
  );
  const byLabel = Object.fromEntries(m.deviceFacts.map((r) => [r.label, r.value]));
  assert.equal(byLabel["GPU util"], "no data");
  assert.equal(byLabel["VRAM"], "no data");
  assert.equal(byLabel["Temp"], "no data");
  assert.equal(byLabel["Power"], "no data");
  assert.deepEqual(m.jobs, [], "no Active/Queued/Failed panel without a real value");
});

test("measured values render with units; a real 0 is kept (observed quiet)", () => {
  const m = buildDetailModel(
    descriptor({
      deviceFacts: {
        kind: "gpu",
        utilizationPercent: 41.25,
        vramUsedBytes: 4e9,
        vramTotalBytes: 16e9,
        temperatureC: 63,
        powerWatts: 210,
        activeJobs: 0,
        queuedJobs: 3,
        hostedRuntimeIds: ["rt-a"],
      },
    }),
    { now: NOW }
  );
  const byLabel = Object.fromEntries(m.deviceFacts.map((r) => [r.label, r.value]));
  assert.equal(byLabel["GPU util"], "41.3%");
  assert.equal(byLabel["VRAM"], "4.00 / 16.00 GB");
  assert.equal(byLabel["Hosted runtimes"], "rt-a (proven runtime_device)");
  assert.deepEqual(
    m.jobs.map((j) => [j.key, j.value]),
    [
      ["active", 0],
      ["queued", 3],
    ]
  );
});

test("Failed panel comes only from real request-failed events for the provider inside the window", () => {
  const p = descriptor({ id: "provider:p1", kind: "provider", providerId: "p1" });
  const ev = (over: Partial<AtomicEvent>): AtomicEvent => ({
    id: String(Math.random()),
    at: NOW - 1000,
    kind: "request-failed",
    providerId: "p1",
    ...over,
  });
  const none = buildDetailModel(p, { now: NOW, events: [] });
  assert.equal(
    none.jobs.find((j) => j.key === "failed"),
    undefined
  );
  const m = buildDetailModel(p, {
    now: NOW,
    events: [
      ev({}),
      ev({ at: NOW - 2000 }),
      ev({ providerId: "other" }),
      ev({ kind: "request-completed" }),
      ev({ at: NOW - DETAIL_FAILURE_WINDOW_MS - 1 }),
      ev({ at: NOW + 5000 }),
    ],
  });
  assert.equal(m.jobs.find((j) => j.key === "failed")?.value, 2);
  // GPU atoms have no provider id, so failures are never attributed to them.
  const g = buildDetailModel(descriptor(), { now: NOW, events: [ev({})] });
  assert.equal(
    g.jobs.find((j) => j.key === "failed"),
    undefined
  );
});

test("model -> nucleon mapping: only observed models, deterministic, counts add up", () => {
  const modelsA = ["llama-3", "qwen-2"];
  const a = countNucleonsByModel("gpu:g1", false, modelsA);
  const b = countNucleonsByModel("gpu:g1", false, [...modelsA].reverse());
  assert.equal(a.total, 24 + Math.round(24 * 0.4));
  assert.equal(a.perGroup.reduce((x, y) => x + y, 0) + a.neutral, a.total);
  assert.equal(a.groups.length, 2);
  assert.deepEqual(
    [...a.groups].sort(),
    [...b.groups].sort(),
    "grouping is order-independent (same canonical groups)"
  );
  const none = countNucleonsByModel("gpu:g1", false, []);
  assert.equal(none.groups.length, 0);
  assert.equal(none.neutral, none.total);
});

test("buildDetailModel: no observed model -> honest neutral nucleus, no invented rows", () => {
  const m = buildDetailModel(descriptor(), { now: NOW });
  assert.equal(m.neutralNucleus, true);
  assert.deepEqual(m.models, []);
});

test("buildDetailModel: observed models carry colour + provenance basis", () => {
  const d = descriptor({
    id: "provider:p1",
    kind: "provider",
    providerId: "p1",
    observedModelIds: ["gpt-x", "claude-y"],
    modelColors: ["#ff0000", "#00ff00"],
    observedModelSources: {
      inFlight: ["gpt-x"],
      callLog: ["claude-y"],
      callLogWindowMs: 15 * 60_000,
    },
  });
  const m = buildDetailModel(d, { now: NOW });
  assert.equal(m.models.length, 2);
  const byModel = Object.fromEntries(m.models.map((r) => [r.model, r]));
  assert.equal(byModel["gpt-x"].basis, "live in-flight");
  assert.equal(byModel["gpt-x"].color, "#ff0000");
  assert.equal(byModel["claude-y"].basis, "call-log, last 15 min");
  assert.equal(byModel["claude-y"].color, "#00ff00");
  assert.ok(m.models.every((r) => r.nucleons > 0));
});

test("activity copy never calls decorative idle 'live'", () => {
  assert.match(buildDetailModel(descriptor({ energyTier: 1 }), { now: NOW }).activity, /idle, no/);
  assert.match(
    buildDetailModel(descriptor({ energyTier: 2, lastActivityAt: NOW - 3 * 60_000 }), { now: NOW })
      .activity,
    /3m ago/
  );
  assert.match(buildDetailModel(descriptor({ energyTier: 0 }), { now: NOW }).activity, /no data/);
});

test("panel: closed renders nothing; open renders sections and omits absent job panels", () => {
  assert.equal(
    renderToStaticMarkup(createElement(AtomicDetailPanel, { model: null, onClose: () => {} })),
    ""
  );
  const html = renderToStaticMarkup(
    createElement(AtomicDetailPanel, {
      model: buildDetailModel(descriptor(), { now: NOW }),
      onClose: () => {},
    })
  );
  assert.match(html, /data-atomic-detail="true"/);
  assert.match(html, /neutral two-tone/);
  assert.doesNotMatch(html, /data-detail="jobs"/);
  assert.match(html, /Back to topology/);
});

test("tooltip: the detail action exists only when the host wires it (default view unchanged)", () => {
  const without = renderToStaticMarkup(
    createElement(AtomicTooltip, { descriptor: descriptor(), capturedAt: NOW })
  );
  assert.doesNotMatch(without, /Open detail view/);
  const withAction = renderToStaticMarkup(
    createElement(AtomicTooltip, {
      descriptor: descriptor(),
      capturedAt: NOW,
      onOpenDetail: () => {},
    })
  );
  assert.match(withAction, /Open detail view/);
});
