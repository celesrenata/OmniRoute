/**
 * Unit tests for the proven pulse gate (OR-ATOM-009 S9.4 / S9.5):
 * `computeProvenRouteLinks` (proven link set + basis from the snapshot's OWN
 * evidence) and the `ProvenPulseGate` (proven-link eligibility, dedupe
 * window, concurrent-pulse cap, live-count bookkeeping).
 *
 * Pure — no DOM, no WebGL, no wall clock (all "now" values are injected).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROVEN_BASIS_CALL_LOG,
  PROVEN_BASIS_FLEET,
  UNPROVEN_BASIS_NO_TARGET,
  DEFAULT_PULSE_CAP,
  DEFAULT_DEDUPE_WINDOW_MS,
  DEFAULT_PULSE_LIFETIME_MS,
  admitPulseEvents,
  canonicalProviderAtomId,
  canonicalRouteLinkId,
  computeProvenRouteLinks,
  createProvenPulseGate,
} from "@/plugins/atomic-topology/scene/provenPulse";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";

const T = 1_700_000_000_000;

function routeSnapshot(extra?: Partial<TopologySceneSnapshot>): TopologySceneSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: T,
    links: [
      {
        id: "route:openai",
        source: "hub",
        target: "provider:openai",
        kind: "route",
        health: "healthy",
        traffic: "active",
      },
      {
        id: "route:anthropic",
        source: "hub",
        target: "provider:anthropic",
        kind: "route",
        health: "healthy",
        traffic: "idle",
      },
    ],
    nodes: [
      { id: "hub", kind: "hub", label: "Router", health: "healthy", traffic: "idle" },
      {
        id: "provider:openai",
        kind: "provider",
        label: "OpenAI",
        providerId: "openai",
        health: "healthy",
        traffic: "active",
      },
    ],
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* computeProvenRouteLinks — proven set + basis                        */
/* ------------------------------------------------------------------ */

test("computeProvenRouteLinks: route link is proven when the target provider atom exists", () => {
  const { provenLinkIds, basisById } = computeProvenRouteLinks(routeSnapshot());
  assert.ok(provenLinkIds.has("route:openai"), "openai route is proven (atom present)");
  assert.equal(basisById.get("route:openai"), PROVEN_BASIS_CALL_LOG);
});

test("computeProvenRouteLinks: a route link without its target atom is unproven (no guess)", () => {
  // Defensively: a link whose target provider atom is absent (e.g. a stale
  // link list vs a pruned node list) must NOT be proven.
  const { provenLinkIds, basisById } = computeProvenRouteLinks(routeSnapshot());
  assert.equal(provenLinkIds.has("route:anthropic"), false, "anthropic route is unproven");
  assert.equal(basisById.get("route:anthropic"), UNPROVEN_BASIS_NO_TARGET);
});

test("computeProvenRouteLinks: fleet-telemetry provider sample strengthens the basis only", () => {
  const snapshot = routeSnapshot({
    fleetTelemetry: {
      schemaVersion: 1,
      capturedAt: T,
      gpuNodes: [],
      runtimeNodes: [],
      providerNodes: [{ resourceId: "provider:openai", providerId: "openai", stale: false }],
      edges: [],
      providerCentricFallback: true,
    },
  });
  const { provenLinkIds, basisById } = computeProvenRouteLinks(snapshot);
  assert.ok(provenLinkIds.has("route:openai"));
  assert.equal(basisById.get("route:openai"), PROVEN_BASIS_FLEET);
});

test("computeProvenRouteLinks: no snapshot links → empty proven set", () => {
  const { provenLinkIds, basisById } = computeProvenRouteLinks(routeSnapshot({ links: [] }));
  assert.equal(provenLinkIds.size, 0);
  assert.equal(basisById.size, 0);
});

test("canonical id helpers are the exact `route:` / `provider:` forms", () => {
  assert.equal(canonicalRouteLinkId("openai"), "route:openai");
  assert.equal(canonicalProviderAtomId("openai"), "provider:openai");
});

/* ------------------------------------------------------------------ */
/* ProvenPulseGate — eligibility + dedupe + cap                        */
/* ------------------------------------------------------------------ */

test("gate: unproven link never admits (even with a free slot)", () => {
  const gate = createProvenPulseGate(["route:openai"]);
  const r = gate.admit("route:ghost", T);
  assert.deepEqual(r, { ok: false, reason: "unproven" });
  assert.equal(gate.activeOn("route:ghost", T + 1000), 0);
});

test("gate: admits on a proven link, then dedupes repeats inside the dedupe window", () => {
  const gate = createProvenPulseGate(["route:openai"]);
  assert.deepEqual(gate.admit("route:openai", T), { ok: true, reason: "admitted" });
  // A repeat (polling + lifecycle for the same request) within the window →
  // collapsed.
  assert.deepEqual(gate.admit("route:openai", T + DEFAULT_DEDUPE_WINDOW_MS - 1), {
    ok: false,
    reason: "deduped",
  });
  // After the window elapses the next event is a fresh pulse.
  assert.deepEqual(gate.admit("route:openai", T + DEFAULT_DEDUPE_WINDOW_MS), {
    ok: true,
    reason: "admitted",
  });
});

test("gate: concurrent-pulse cap bounds live pulses per link", () => {
  const gate = createProvenPulseGate(["route:openai"], {
    cap: 2,
    dedupeWindowMs: 1,
    pulseLifetimeMs: 2500,
  });
  const t0 = T;
  assert.ok(gate.admit("route:openai", t0).ok);
  assert.ok(gate.admit("route:openai", t0 + 100).ok);
  // Third concurrent pulse on the same link → capped (2 live).
  assert.deepEqual(gate.admit("route:openai", t0 + 200), { ok: false, reason: "capped" });
  assert.equal(gate.activeOn("route:openai", t0 + 300), 2);
  assert.equal(gate.activeLinkCount(t0 + 300), 1);
  // Once the oldest pulse ages out of its lifetime, a slot frees up.
  assert.deepEqual(gate.admit("route:openai", t0 + 2500 + 200), { ok: true, reason: "admitted" });
});

test("gate: defaults match the scene's visual cap and the dedupe/lifetime windows", () => {
  assert.equal(DEFAULT_PULSE_CAP, 3, "gate cap aligns with MAX_PACKET_POOL");
  assert.equal(DEFAULT_DEDUPE_WINDOW_MS, 150);
  assert.equal(DEFAULT_PULSE_LIFETIME_MS, 2500, "aligned with the 2.5 s packet hop");
});

test("gate: per-link isolation — a cap on one link does not block another", () => {
  const gate = createProvenPulseGate(["route:a", "route:b"], {
    cap: 1,
    dedupeWindowMs: 1,
    pulseLifetimeMs: 2500,
  });
  assert.ok(gate.admit("route:a", T).ok);
  // route:a is capped, but route:b still has a free slot.
  assert.deepEqual(gate.admit("route:a", T + 10), { ok: false, reason: "capped" });
  assert.ok(gate.admit("route:b", T + 10).ok);
  assert.equal(gate.activeLinkCount(T + 20), 2);
});

/* ------------------------------------------------------------------ */
/* admitPulseEvents — batch ingest filter                              */
/* ------------------------------------------------------------------ */

test("admitPulseEvents: only proven, non-duplicate, uncapped events pass through", () => {
  const events = [
    { linkId: "route:openai" },
    { linkId: "route:ghost" }, // unproven → dropped
    { linkId: undefined }, // no link → never pulsed
    { linkId: "route:openai" }, // dedupe-window repeat → dropped
  ];
  const gate = createProvenPulseGate(["route:openai"], { dedupeWindowMs: 1000 });
  const out = admitPulseEvents(events, gate, T);
  assert.equal(out.length, 1, "exactly one event admitted");
  assert.equal(out[0].linkId, "route:openai");
});

test("admitPulseEvents: does not mutate the input batch", () => {
  const events = [{ linkId: "route:openai" }, { linkId: "route:openai" }];
  const gate = createProvenPulseGate(["route:openai"]);
  const out = admitPulseEvents(events, gate, T);
  assert.equal(events.length, 2);
  assert.equal(out.length, 1);
  assert.equal(events[0].linkId, "route:openai");
  assert.equal(events[1].linkId, "route:openai");
});
