// M4 (OR-ATOM-001 v2) — bounded live-request lifecycle stream, core side.
//
// The Atomic renderer owns the *effect* (discharges); the core owns the
// bounded, deduped, order-normalized event stream. This spec pins the
// protection invariants: dedupe, out-of-order safety, bounded capacity,
// invalid-row rejection, determinism, and snapshot immutability — plus a
// regression check that adding `lifecycle` to the snapshot does not change
// the M1 node/link/precedence/lane behavior.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_LIFECYCLE_EVENTS,
  normalizeLifecycleEvents,
  normalizeTopology,
  type TopologyLifecycleInput,
} from "../../../src/shared/topology/domain/normalizeTopology";

const CAPTURED_AT = 1_700_000_000_000;

function row(partial: {
  phase: string;
  requestId?: string;
  observedAt: number;
  provider?: string;
  model?: string;
  outcome?: string;
  error?: string;
}): TopologyLifecycleInput {
  const out: TopologyLifecycleInput = { phase: partial.phase, observedAt: partial.observedAt };
  if (partial.requestId !== undefined) out.requestId = partial.requestId;
  if (partial.provider !== undefined) out.provider = partial.provider;
  if (partial.model !== undefined) out.model = partial.model;
  if (partial.outcome !== undefined) out.outcome = partial.outcome;
  if (partial.error !== undefined) out.error = partial.error;
  return out;
}

describe("normalizeLifecycleEvents", () => {
  test("absent or empty input → null (a lifecycle observation is absent, not empty)", () => {
    assert.equal(normalizeLifecycleEvents(undefined), null);
    assert.equal(normalizeLifecycleEvents(null), null);
    assert.equal(normalizeLifecycleEvents([]), null);
  });

  test("drops rows the topology cannot represent — unknown phase, missing/empty id, invalid timestamp", () => {
    const out = normalizeLifecycleEvents([
      row({ phase: "streaming", observedAt: 100 }), // not a bounded phase
      row({ phase: "started", requestId: "", observedAt: 200 }), // empty id
      row({ phase: "started", observedAt: 300 }), // absent id
      row({ phase: "started", observedAt: Number.NaN }),
      row({ phase: "started", observedAt: Number.POSITIVE_INFINITY }),
      row({ phase: "failed", requestId: "ok", observedAt: 500 }),
    ]);
    assert.ok(out, "the valid row must survive");
    assert.deepEqual(
      out.map((e) => [e.phase, e.requestId, e.observedAt]),
      [["failed", "ok", 500]]
    );
  });

  test("collapses duplicate (phase, requestId, observedAt) rows — replay-safe", () => {
    const out = normalizeLifecycleEvents([
      row({ phase: "started", requestId: "r", observedAt: 5 }),
      row({ phase: "started", requestId: "r", observedAt: 5 }),
      // Same logical request, distinct transition — must NOT collapse.
      row({ phase: "failed", requestId: "r", observedAt: 5 }),
    ]);
    assert.ok(out);
    assert.deepEqual(
      out.map((e) => [e.phase, e.requestId, e.observedAt]),
      [
        ["failed", "r", 5],
        ["started", "r", 5],
      ]
    );
  });

  test("keeps only the newest maxEvents rows (capacity bound)", () => {
    const rows = Array.from({ length: 305 }, (_, i) =>
      row({ phase: "started", requestId: `req-${i}`, observedAt: 1000 + i })
    );
    const out = normalizeLifecycleEvents(rows, MAX_LIFECYCLE_EVENTS);
    assert.ok(out);
    assert.equal(out.length, MAX_LIFECYCLE_EVENTS);
    assert.equal(out[0].requestId, "req-49"); // oldest kept (305 - 256)
    assert.equal(out[out.length - 1].requestId, "req-304");
  });

  test("honors a custom maxEvents bound", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ phase: "started", requestId: `r${i}`, observedAt: i })
    );
    const out = normalizeLifecycleEvents(rows, 2);
    assert.ok(out);
    assert.deepEqual(
      out.map((e) => e.requestId),
      ["r3", "r4"]
    );
  });

  test("orders deterministically by (observedAt, phase, requestId) — out-of-order-safe", () => {
    const out = normalizeLifecycleEvents([
      row({ phase: "completed", requestId: "zeta", observedAt: 3 }),
      row({ phase: "started", requestId: "beta", observedAt: 1 }),
      row({ phase: "failed", requestId: "alpha", observedAt: 1 }),
      row({ phase: "started", requestId: "alpha", observedAt: 2 }),
      row({ phase: "completed", requestId: "alpha", observedAt: 1 }),
    ]);
    assert.ok(out);
    assert.deepEqual(
      out.map((e) => [e.observedAt, e.phase, e.requestId]),
      [
        [1, "completed", "alpha"],
        [1, "failed", "alpha"],
        [1, "started", "beta"],
        [2, "started", "alpha"],
        [3, "completed", "zeta"],
      ]
    );
  });

  test("is a pure reduction: provenance (timestamp) preserved, optional fields pass through", () => {
    const out = normalizeLifecycleEvents([
      row({
        phase: "failed",
        requestId: "r9",
        observedAt: 77,
        provider: "openai",
        model: "gpt-4o",
        outcome: "error",
        error: "503 upstream",
      }),
      row({ phase: "started", requestId: "r10", observedAt: 88, provider: "anthropic" }),
    ]);
    assert.ok(out);
    assert.deepEqual(out[0], {
      phase: "failed",
      requestId: "r9",
      observedAt: 77,
      provider: "openai",
      model: "gpt-4o",
      outcome: "error",
      error: "503 upstream",
    });
    // No fabricated fields: a started row carries no outcome.
    assert.equal(out[1].outcome, undefined);
    assert.equal(out[1].error, undefined);
  });

  test("returns a frozen array of frozen rows (renderers cannot mutate core data)", () => {
    const out = normalizeLifecycleEvents([
      row({ phase: "started", observedAt: 1 }),
      row({ phase: "failed", requestId: "two", observedAt: 2 }),
    ]);
    assert.ok(out);
    assert.ok(Object.isFrozen(out), "container array must be frozen");
    for (const e of out) assert.ok(Object.isFrozen(e), "rows must be frozen");
    assert.equal("provider" in out[0], false, "absent source fields stay absent");
  });
});

describe("normalizeTopology: snapshot lifecycle integration (M4)", () => {
  test("lifecycle absent when no lifecycle input (regression: M1 snapshot shape)", () => {
    const snap = normalizeTopology({
      providers: [{ provider: "openai" }],
      activeRequests: [],
      lastProvider: "",
      errorProvider: "",
      capturedAt: CAPTURED_AT,
    });
    assert.equal("lifecycle" in snap, false, "absent — not an empty claim");
  });

  test("lifecycle is set, bounded/deduped/ordered, and frozen on the snapshot", () => {
    const lifecycleEvents = [
      row({ phase: "failed", requestId: "b", observedAt: 2 }),
      row({ phase: "started", requestId: "a", observedAt: 1 }),
      row({ phase: "started", requestId: "a", observedAt: 1 }), // duplicate
    ];
    const snap = normalizeTopology({
      providers: [{ provider: "openai" }],
      activeRequests: [],
      lastProvider: "",
      errorProvider: "",
      lifecycleEvents,
      capturedAt: CAPTURED_AT,
    });
    assert.ok(snap.lifecycle, "lifecycle present when a feed was observed");
    assert.ok(Object.isFrozen(snap.lifecycle));
    assert.deepEqual(
      snap.lifecycle.map((e) => [e.observedAt, e.phase, e.requestId]),
      [
        [1, "started", "a"],
        [2, "failed", "b"],
      ]
    );
  });

  test("precedence/aliases/lane untouched by the lifecycle input (regression-safe)", () => {
    const snap = normalizeTopology({
      providers: [
        { provider: "openai", name: "OpenAI", status: "active", aliases: ["openai-api"] },
        { provider: "gemini", status: "idle" },
        { provider: "anthropic", status: "error" },
      ],
      activeRequests: [{ provider: "openai-api", model: "text-embedding-3-small" }],
      lastProvider: "gemini",
      errorProvider: "anthropic",
      lifecycleEvents: [
        row({ phase: "failed", requestId: "x", observedAt: CAPTURED_AT, provider: "anthropic" }),
      ],
      capturedAt: CAPTURED_AT,
    });
    const openai = snap.nodes.find((n) => n.providerId === "openai");
    const gemini = snap.nodes.find((n) => n.providerId === "gemini");
    const anthropic = snap.nodes.find((n) => n.providerId === "anthropic");
    assert.ok(openai && gemini && anthropic, "all provider nodes present");
    // Alias matching: an in-flight request on the alias counts as active for
    // the node — active beats everything in traffic precedence.
    assert.equal(openai.traffic, "active");
    assert.equal(openai.health, "healthy");
    assert.equal(openai.activeRequests?.value, 1);
    // Lane derivation from observed in-flight models is independent of lifecycle.
    assert.equal(openai.lane?.value, "embedding");
    // lastProvider → recent (no active traffic, no error on this node).
    assert.equal(gemini.traffic, "recent");
    assert.equal(gemini.health, "unknown");
    // errorProvider → trafficError: traffic stays idle, health records unhealthy.
    assert.equal(anthropic.traffic, "idle");
    assert.equal(anthropic.health, "unhealthy");
  });

  test("snapshot is deep-frozen; input mutation after the call never leaks in", () => {
    const lifecycleEvents = [row({ phase: "started", requestId: "s1", observedAt: 42 })];
    const snap = normalizeTopology({
      providers: [],
      activeRequests: [],
      lastProvider: "",
      errorProvider: "",
      lifecycleEvents,
      capturedAt: CAPTURED_AT,
    });
    assert.ok(Object.isFrozen(snap));
    assert.ok(Object.isFrozen(snap.nodes));
    assert.ok(snap.lifecycle && Object.isFrozen(snap.lifecycle));
    // The input array is ours to mutate afterwards; the snapshot must not move.
    lifecycleEvents.push(row({ phase: "failed", requestId: "late", observedAt: 99 }));
    assert.equal(snap.lifecycle?.length, 1);
    assert.equal(snap.lifecycle?.[0].requestId, "s1");
  });
});
