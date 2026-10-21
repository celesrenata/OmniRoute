/**
 * Atomic event pool — bounded exact-dedupe pool + transient discharge model
 * (OR-ATOM-001 v2, M4/M6).
 *
 * Pure, three-free, DOM-free behavior: capacity/high-watermark eviction,
 * max-age drop, exact dedupe, the attack–hold–decay discharge envelope
 * (red only for failed), per-provider effects, active-now queries, and the
 * `mapLifecycleToAtomicEvents` bridge (lane via `deriveLaneFromModel`,
 * `route:<provider>` linkId, `""` provider when absent, `[]` when no feed).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  atomicEventDedupeKey,
  createAtomicEventPool,
  computeDischarge,
  mapLifecycleToAtomicEvents,
  ATOMIC_EVENT_POOL_CAPACITY,
  ATOMIC_EVENT_HIGH_WATERMARK,
  ATOMIC_EVENT_MAX_AGE_MS,
  DISCHARGE_WINDOWS,
  type AtomicEvent,
} from "@/plugins/atomic-topology/eventPool";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";

/* ------------------------------------------------------------------ */
/* Dedupe key                                                          */
/* ------------------------------------------------------------------ */

test("atomicEventDedupeKey: kind:resourceId??providerId:at", () => {
  assert.equal(
    atomicEventDedupeKey({ kind: "request-started", resourceId: "r1", providerId: "p", at: 100 }),
    "request-started:r1:100"
  );
  // resourceId takes precedence over providerId when present.
  assert.equal(
    atomicEventDedupeKey({ kind: "request-failed", resourceId: "r2", providerId: "p", at: 200 }),
    "request-failed:r2:200"
  );
  // Absent resourceId falls back to providerId.
  assert.equal(
    atomicEventDedupeKey({ kind: "request-completed", providerId: "p9", at: 300 }),
    "request-completed:p9:300"
  );
});

/* ------------------------------------------------------------------ */
/* Pool constants                                                      */
/* ------------------------------------------------------------------ */

test("pool constants match the bounded contract", () => {
  assert.equal(ATOMIC_EVENT_POOL_CAPACITY, 512);
  assert.equal(ATOMIC_EVENT_HIGH_WATERMARK, 448);
  assert.equal(ATOMIC_EVENT_MAX_AGE_MS, 60_000);
  assert.deepEqual(DISCHARGE_WINDOWS, {
    "request-started": { attack: 120, hold: 380, decay: 900 },
    "request-completed": { attack: 80, hold: 0, decay: 1000 },
    "request-failed": { attack: 60, hold: 60, decay: 700 },
  });
});

/* ------------------------------------------------------------------ */
/* createAtomicEventPool                                               */
/* ------------------------------------------------------------------ */

function evt(over: Partial<AtomicEvent> & { at: number; kind: AtomicEvent["kind"] }): AtomicEvent {
  return { id: "id-" + over.at + "-" + over.kind, providerId: "p1", ...over };
}

test("pool defaults (512 / 448 / 60000) and starts empty", () => {
  const pool = createAtomicEventPool();
  assert.equal(pool.capacity, 512);
  assert.equal(pool.highWatermark, 448);
  assert.equal(pool.maxAgeMs, 60_000);
  assert.equal(pool.size, 0);
  assert.deepEqual(pool.events(), []);
});

test("ingest: exact dedupe — re-delivered transitions are no-ops", () => {
  const pool = createAtomicEventPool();
  const e = evt({ at: 1000, kind: "request-started", resourceId: "r1" });
  pool.ingest(e, 1001);
  // Byte-identical re-delivery (same kind / target / at).
  pool.ingest(e, 1002);
  // Same logical event from another source (different `id`, same key).
  pool.ingest({ ...e, id: "other-source-id" }, 1003);
  assert.equal(pool.size, 1);
});

test("ingest: distinct logical targets are kept (different resourceId or at)", () => {
  const pool = createAtomicEventPool();
  pool.ingest(evt({ at: 1000, kind: "request-started", resourceId: "r1" }), 1001);
  pool.ingest(evt({ at: 1000, kind: "request-started", resourceId: "r2" }), 1002);
  pool.ingest(evt({ at: 1001, kind: "request-started", resourceId: "r1" }), 1002);
  assert.equal(pool.size, 3);
});

test("ingest: high-water mark sheds oldest events, capacity is never exceeded", () => {
  // Small pool for boundary control: capacity 4, HWM 2, no age drop in range.
  const pool = createAtomicEventPool({ capacity: 4, highWatermark: 2, maxAgeMs: 100_000 });
  for (let i = 0; i < 10; i += 1) {
    pool.ingest(evt({ at: i * 100, kind: "request-started", resourceId: "r" + i }), i * 100 + 1);
    assert.ok(pool.size <= 4, "size " + pool.size + " never exceeds capacity 4");
  }
  // Steady state: HWM 2 sheds oldest on each ingest past the mark.
  assert.equal(pool.size, 3);
  // The oldest observations were shed.
  assert.equal(
    pool.events().some((e) => e.at === 0),
    false,
    "oldest event shed"
  );
  assert.equal(
    pool.events().every((e) => e.at >= 700),
    true,
    "only recent events remain"
  );
});

test("ingest: events older than maxAgeMs are dropped", () => {
  const pool = createAtomicEventPool({ capacity: 8, highWatermark: 6, maxAgeMs: 1000 });
  pool.ingest(evt({ at: 100, kind: "request-started", resourceId: "old" }), 200);
  // A later ingest drops the stale event first.
  pool.ingest(evt({ at: 1500, kind: "request-started", resourceId: "new" }), 2000);
  assert.equal(pool.size, 1);
  assert.equal(pool.events()[0].resourceId, "new");
});

test("dropStale: boundary is strict (> maxAgeMs), explicit call works", () => {
  const pool = createAtomicEventPool({ capacity: 8, highWatermark: 6, maxAgeMs: 1000 });
  pool.ingest(evt({ at: 100, kind: "request-started", resourceId: "a" }), 101);
  pool.ingest(evt({ at: 900, kind: "request-started", resourceId: "b" }), 901);
  // Exactly at the age limit (1000ms) — still fresh, not dropped.
  pool.dropStale(1100);
  assert.equal(pool.size, 2);
  // One ms past the limit — dropped.
  pool.dropStale(1101);
  assert.equal(pool.size, 1);
  assert.equal(pool.events()[0].resourceId, "b");
});

test("clear: empties the pool and releases dedupe keys", () => {
  const pool = createAtomicEventPool();
  const e = evt({ at: 1000, kind: "request-started", resourceId: "r1" });
  pool.ingest(e, 1001);
  assert.equal(pool.size, 1);
  pool.clear();
  assert.equal(pool.size, 0);
  // A cleared key may be re-ingested.
  pool.ingest({ ...e, at: 2000, resourceId: "r1" }, 2001);
  pool.ingest(e, 2002);
  assert.equal(pool.size, 2);
});

test("effectsFor: best per-provider discharge, red only while a failed discharge is live", () => {
  const pool = createAtomicEventPool({ capacity: 16, highWatermark: 12, maxAgeMs: 60_000 });
  pool.ingest(evt({ at: 1000, kind: "request-started", providerId: "p1", resourceId: "a" }), 1001);
  pool.ingest(evt({ at: 1010, kind: "request-failed", providerId: "p1", resourceId: "b" }), 1011);
  pool.ingest(evt({ at: 1000, kind: "request-failed", providerId: "p2", resourceId: "c" }), 1001);

  // At t=1030: started age 30 -> 30/120 = 0.25; failed age 20 -> 20/60 (red).
  const p1 = pool.effectsFor("p1", 1030);
  assert.ok(
    Math.abs(p1.intensity - 20 / 60) < 1e-9,
    "expected " + 20 / 60 + ", got " + p1.intensity
  );
  assert.equal(p1.red, true);

  // p2's failed event is live and red (age 30 -> 0.5).
  const p2 = pool.effectsFor("p2", 1030);
  assert.ok(Math.abs(p2.intensity - 30 / 60) < 1e-9);
  assert.equal(p2.red, true);

  // An unknown provider never gets a discharge.
  assert.deepEqual(pool.effectsFor("p3", 1030), { intensity: 0, red: false });
});

test("effectsFor: a failed discharge past its window is gone (no lingering red)", () => {
  const pool = createAtomicEventPool({ capacity: 8, highWatermark: 6, maxAgeMs: 60_000 });
  pool.ingest(evt({ at: 1000, kind: "request-failed", providerId: "p1", resourceId: "a" }), 1001);
  // failed window ends at 60 + 60 + 700 = 820 -> at t=1821 it is fully discharged.
  assert.deepEqual(pool.effectsFor("p1", 1821), { intensity: 0, red: false });
});

test("activeAt: only events with a live (intensity > 0) discharge; future events excluded", () => {
  const pool = createAtomicEventPool({ capacity: 16, highWatermark: 12, maxAgeMs: 60_000 });
  pool.ingest(
    evt({ at: 1000, kind: "request-started", providerId: "p1", resourceId: "live" }),
    1001
  );
  pool.ingest(
    evt({ at: 1000, kind: "request-completed", providerId: "p1", resourceId: "done" }),
    1001
  );
  pool.ingest(
    evt({ at: 5000, kind: "request-started", providerId: "p1", resourceId: "future" }),
    1001
  );

  // t=1100: started age 100 (attack 120) -> live at 0.833; completed age 100
  // (attack 80, hold 0, decay 1000) -> 1 - 20/1000 = 0.98, still live.
  const at1100 = pool.activeAt(1100);
  assert.deepEqual(at1100.map((e) => e.resourceId).sort(), ["done", "live"]);
  // t=2500: started age 1500 >= end (1400); completed age 1500 >= end (1080) -> none.
  assert.deepEqual(pool.activeAt(2500), []);
  // The future-observed event never counts as active (negative age is not live).
  assert.ok(
    pool.activeAt(1100).every((e) => e.resourceId !== "future"),
    "future-observed event is never active"
  );
});

/* ------------------------------------------------------------------ */
/* computeDischarge — the transient attack–hold–decay envelope         */
/* ------------------------------------------------------------------ */

test("computeDischarge: request-started (attack 120 / hold 380 / decay 900)", () => {
  // Attack ramp 0->1 over 120ms.
  assert.equal(computeDischarge(0, "request-started").intensity, 0);
  assert.ok(Math.abs(computeDischarge(60, "request-started").intensity - 0.5) < 1e-9);
  // Hold: full intensity through 120 + 380 = 500ms.
  assert.equal(computeDischarge(120, "request-started").intensity, 1);
  assert.equal(computeDischarge(500, "request-started").intensity, 1);
  // Decay: 1->0 over the next 900ms (end at 1400).
  assert.ok(Math.abs(computeDischarge(950, "request-started").intensity - 0.5) < 1e-9);
  assert.deepEqual(computeDischarge(1400, "request-started"), { intensity: 0, red: false });
  // Never red for a started event.
  assert.equal(computeDischarge(300, "request-started").red, false);
});

test("computeDischarge: request-completed (attack 80 / hold 0 / decay 1000)", () => {
  assert.ok(Math.abs(computeDischarge(40, "request-completed").intensity - 0.5) < 1e-9);
  assert.equal(computeDischarge(80, "request-completed").intensity, 1);
  // hold = 0 -> decay starts immediately after the 80ms attack.
  assert.ok(Math.abs(computeDischarge(540, "request-completed").intensity - 0.54) < 1e-9);
  assert.deepEqual(computeDischarge(1080, "request-completed"), { intensity: 0, red: false });
  assert.equal(computeDischarge(900, "request-completed").red, false);
});

test("computeDischarge: request-failed (attack 60 / hold 60 / decay 700) is the only red", () => {
  assert.deepEqual(computeDischarge(30, "request-failed"), { intensity: 0.5, red: true });
  assert.deepEqual(computeDischarge(60, "request-failed"), { intensity: 1, red: true });
  assert.deepEqual(computeDischarge(120, "request-failed"), { intensity: 1, red: true });
  assert.ok(Math.abs(computeDischarge(470, "request-failed").intensity - 0.5) < 1e-9);
  assert.ok(computeDischarge(470, "request-failed").red);
  // Past the 820ms window the red flash is gone (intensity 0 -> not red).
  assert.deepEqual(computeDischarge(820, "request-failed"), { intensity: 0, red: false });
});

test("computeDischarge: degenerate inputs are always {0, false}", () => {
  for (const age of [-1, NaN, Infinity, 61_000]) {
    for (const kind of ["request-started", "request-completed", "request-failed"] as const) {
      assert.deepEqual(
        computeDischarge(age, kind),
        { intensity: 0, red: false },
        "age=" + age + " kind=" + kind
      );
    }
  }
});

test("computeDischarge: intensity is always bounded in [0, 1]", () => {
  for (const kind of ["request-started", "request-completed", "request-failed"] as const) {
    for (let age = 0; age < 61_000; age += 137) {
      const d = computeDischarge(age, kind);
      assert.ok(
        d.intensity >= 0 && d.intensity <= 1,
        "age=" + age + " kind=" + kind + " -> " + d.intensity
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* mapLifecycleToAtomicEvents — the core stream -> pool bridge        */
/* ------------------------------------------------------------------ */

function snapshot(
  over: Partial<Pick<TopologySceneSnapshot, "lifecycle">> = {}
): TopologySceneSnapshot {
  return { schemaVersion: 1, capturedAt: 0, nodes: [], links: [], ...over };
}

test("mapLifecycleToAtomicEvents: absent lifecycle -> [] (absent != 0)", () => {
  assert.deepEqual(mapLifecycleToAtomicEvents(snapshot()), []);
  assert.deepEqual(mapLifecycleToAtomicEvents(snapshot({ lifecycle: [] })), []);
});

test("mapLifecycleToAtomicEvents: full event maps phase/provider/model verbatim", () => {
  const events = mapLifecycleToAtomicEvents(
    snapshot({
      lifecycle: [
        {
          phase: "started",
          requestId: "req-1",
          provider: "p1",
          model: "text-embedding-3-small",
          observedAt: 1234,
        },
      ],
    })
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    id: "request-started:req-1:1234",
    at: 1234,
    kind: "request-started",
    providerId: "p1",
    resourceId: "req-1",
    modelId: "text-embedding-3-small",
    lane: "embedding",
    linkId: "route:p1",
  });
});

test("mapLifecycleToAtomicEvents: phase -> kind for all three transitions", () => {
  const events = mapLifecycleToAtomicEvents(
    snapshot({
      lifecycle: [
        { phase: "started", requestId: "r", provider: "p", observedAt: 1 },
        { phase: "completed", requestId: "r", provider: "p", observedAt: 2, outcome: "success" },
        { phase: "failed", requestId: "r", provider: "p", observedAt: 3, error: "timeout" },
      ],
    })
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ["request-started", "request-completed", "request-failed"]
  );
});

test("mapLifecycleToAtomicEvents: absent provider -> providerId '' and no linkId", () => {
  const events = mapLifecycleToAtomicEvents(
    snapshot({ lifecycle: [{ phase: "failed", requestId: "r9", observedAt: 5 }] })
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].providerId, "");
  assert.equal(events[0].linkId, undefined);
  assert.equal(events[0].id, "request-failed:r9:5");
});

test("mapLifecycleToAtomicEvents: lane is conservatively classified (never fabricated)", () => {
  const events = mapLifecycleToAtomicEvents(
    snapshot({
      lifecycle: [
        {
          phase: "started",
          requestId: "a",
          provider: "p",
          model: "cohere-rerank-3",
          observedAt: 1,
        },
        { phase: "started", requestId: "b", provider: "p", model: "qwen-vl-max", observedAt: 2 },
        { phase: "started", requestId: "c", provider: "p", model: "gpt-4o", observedAt: 3 },
        { phase: "started", requestId: "d", provider: "p", observedAt: 4 },
      ],
    })
  );
  assert.equal(events[0].lane, "rerank");
  assert.equal(events[1].lane, "vision");
  // Ordinary chat models do not classify -> lane is absent, not "unknown".
  assert.equal(events[2].lane, undefined);
  // No model id at all -> no lane observation.
  assert.equal(events[3].lane, undefined);
  // The unclassified event still carries the route linkId.
  assert.equal(events[2].linkId, "route:p");
});
