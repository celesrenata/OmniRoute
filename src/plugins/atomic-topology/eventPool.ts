/**
 * Atomic event pool — bounded, exact-dedupe request-lifecycle pool + transient
 * discharge model (OR-ATOM-001 v2, T006a / M3 Phase A → M4/M6).
 *
 * Phase A shipped the event shape, the capacity constants, and the dedupe-key
 * *contract*. M4/M6 ship the behavior this module now owns — all of it
 * three-free and DOM-free (importable from the server, node and jsdom tests):
 *
 *   - {@link createAtomicEventPool} — a bounded pool (512 capacity, 448 high
 *     watermark, 60 s max age) with *exact* dedupe on
 *     `(kind, logical-target, at)`. It is the renderer-side buffer that turns
 *     the snapshot's `lifecycle` stream into a set of **transient** discharges.
 *   - {@link computeDischarge} — a pure, bounded transient envelope (active
 *     discharge / completed impulse-fade / failed red flash) with attack–hold–
 *     decay timing. A discharge decays back to zero; it never reparents a
 *     provider's persistent health state, and it fabricates no telemetry.
 *   - {@link mapLifecycleToAtomicEvents} — the pure bridge from the core's
 *     {@link TopologyLifecycleEvent} stream to pool {@link AtomicEvent}s.
 *
 * No pool state is mirrored into per-frame React state: the scene holds a
 * single pool ref and reads the current discharge for an atom inside
 * `useFrame`, so the animation loop never allocates React updates.
 */
import type { TopologyLifecycleEvent, TopologySceneSnapshot } from "@/shared/topology/domain/types";
import { deriveLaneFromModel } from "@/shared/topology/domain/lane";

import type { JobLane } from "./visualEncoding";

/** Kinds of routed-request events the pool carries. */
export type AtomicEventKind = "request-started" | "request-completed" | "request-failed";

/**
 * A single request event observed on the topology.
 *
 * All fields are copied verbatim from the source observation (call log /
 * live event) — the pool never fabricates or infers fields. Optional fields
 * are absent when the source did not carry them (absent ≠ zero).
 */
export interface AtomicEvent {
  /**
   * Pool-unique event id, assigned by the source (e.g. the call-log id). The
   * pool treats it as opaque; dedupe uses {@link atomicEventDedupeKey}
   * semantics, NOT this id, because two sources may report the same logical
   * request with different ids.
   */
  id: string;
  /** Epoch ms when the event was observed. */
  at: number;
  /** Which request transition occurred. */
  kind: AtomicEventKind;
  /** Provider atom the event is attached to. */
  providerId: string;
  /** In-flight resource/request id (call-log key); present for per-request events. */
  resourceId?: string;
  /** Model that the request targeted, when known. */
  modelId?: string;
  /** Job lane the request belongs to, when classifiable. */
  lane?: JobLane;
  /** Canonical link id (`route:<providerId>`) the event flares, when known. */
  linkId?: string;
}

/**
 * Dedupe key (M4 exact-dedupe contract):
 *
 *   dedupeKey(event) = `${event.kind}:${event.resourceId ?? event.providerId}:${event.at}`
 *
 * Rationale: the same logical request can arrive from two sources (live event
 * + call log) with different `id`s but the same (kind, logical target,
 * timestamp). Keying on `kind` + logical target (`resourceId` when present,
 * else the provider) + `at` collapses those duplicates, while two genuinely
 * distinct requests to the same provider in the same kind at different times
 * keep both. Events without a `resourceId` (provider-level aggregates) dedupe
 * per provider per timestamp, which is the finest granularity available.
 */
export function atomicEventDedupeKey(
  event: Pick<AtomicEvent, "kind" | "resourceId" | "providerId" | "at">
): string {
  return `${event.kind}:${event.resourceId ?? event.providerId}:${event.at}`;
}

/** Hard upper bound on pooled events; the pool must drop/evict beyond this. */
export const ATOMIC_EVENT_POOL_CAPACITY = 512;
/**
 * High-water mark (87.5% of capacity) at which the pool must shed the oldest
 * events before accepting new ones — keeps the steady-state below capacity
 * instead of hugging it.
 */
export const ATOMIC_EVENT_HIGH_WATERMARK = Math.floor(ATOMIC_EVENT_POOL_CAPACITY * 0.875);
/**
 * Maximum age (ms) of a pooled event; anything older is stale and must be
 * dropped on ingest. Bounds the pool's memory even under a silent drain.
 */
export const ATOMIC_EVENT_MAX_AGE_MS = 60_000;

/**
 * Transient discharge timing windows (ms), per event kind. A discharge is
 * attack (0→1) → hold (1) → decay (1→0) and is fully gone by
 * `attack + hold + decay`. Windows are deliberately short (≪ the 60 s pool
 * max age) so a pooled event is almost always already discharged by the time
 * it is evicted — the pool is a *buffer*, not a persistent state store.
 *
 * - `request-started`   → **active discharge** (an energy build + fade).
 * - `request-completed` → **completed impulse/fade** (a single spike).
 * - `request-failed`    → **failed red flash** (short, red).
 */
export const DISCHARGE_WINDOWS = {
  "request-started": { attack: 120, hold: 380, decay: 900 },
  "request-completed": { attack: 80, hold: 0, decay: 1000 },
  "request-failed": { attack: 60, hold: 60, decay: 700 },
} as const;

/** A computed transient discharge for a single event at a given age. */
export interface Discharge {
  /** Bounded 0..1 discharge intensity. */
  intensity: number;
  /** `true` only for a failed (red) discharge still within its window. */
  red: boolean;
}

/**
 * Compute the transient discharge for one event `ageMs` old.
 *
 * Pure and bounded: returns `{ intensity: 0, red: false }` for any age outside
 * the event's attack–hold–decay window (including negative/future ages and
 * anything past the 60 s max age). A discharge never outlives its window, so
 * the pool's discharge output cannot be read as a persistent health fact.
 */
export function computeDischarge(ageMs: number, kind: AtomicEventKind): Discharge {
  if (!Number.isFinite(ageMs) || ageMs < 0) return { intensity: 0, red: false };
  if (ageMs > ATOMIC_EVENT_MAX_AGE_MS) return { intensity: 0, red: false };

  const w = DISCHARGE_WINDOWS[kind];
  // Widen the `as const` literal windows to plain numbers so the degenerate
  // guards below type-check (the windows are data, not a closed union).
  const { attack, hold, decay }: { attack: number; hold: number; decay: number } = w;
  const attackEnd = attack;
  const holdEnd = attack + hold;
  const end = holdEnd + decay;
  if (ageMs >= end) return { intensity: 0, red: false };

  let intensity: number;
  if (ageMs < attackEnd) {
    intensity = attack === 0 ? 1 : ageMs / attack;
  } else if (ageMs <= holdEnd) {
    intensity = 1;
  } else {
    intensity = 1 - (ageMs - holdEnd) / decay;
  }

  // Clamp against float drift and guarantee a clean zero.
  if (intensity > 1) intensity = 1;
  else if (intensity < 0) intensity = 0;

  return { intensity, red: kind === "request-failed" };
}

/** Options to size a pool (defaults match the M4/M6 contract). */
export interface AtomicEventPoolOptions {
  capacity?: number;
  highWatermark?: number;
  maxAgeMs?: number;
}

/** The bounded, exact-dedupe event pool the Atomic scene reads from a ref. */
export interface AtomicEventPool {
  readonly capacity: number;
  readonly highWatermark: number;
  readonly maxAgeMs: number;
  /** Number of events currently pooled (after dedupe + eviction). */
  size: number;
  /**
   * Ingest one event at `nowMs`. Drops events older than `maxAgeMs`, drops
   * exact duplicates (same {@link atomicEventDedupeKey}), and sheds the
   * oldest events when the pool crosses the high-water mark so it never
   * exceeds `capacity`. Idempotent for a duplicate.
   */
  ingest(event: AtomicEvent, nowMs: number): void;
  /** Drop every event older than `maxAgeMs` relative to `nowMs`. */
  dropStale(nowMs: number): void;
  /** Remove every event. */
  clear(): void;
  /**
   * The strongest transient discharge for `providerId` at `nowMs` — the max
   * intensity across that provider's events still within their windows, with
   * `red` set if any failed discharge is live. `{ intensity: 0, red: false }`
   * when the provider has no live discharge (the atom shows its steady state).
   */
  effectsFor(providerId: string, nowMs: number): Discharge;
  /** Every pooled event still inside its transient window at `nowMs` (tests/snapshots). */
  activeAt(nowMs: number): AtomicEvent[];
  /** Every pooled event (deduped, bounded, not necessarily live). */
  events(): readonly AtomicEvent[];
}

/**
 * Create a bounded, exact-dedupe event pool.
 *
 * Storage is a plain array + a `Set` of dedupe keys; no timers, no `three`,
 * no DOM. Eviction is by age (max age) and by count (high-water mark → cap),
 * so memory is bounded even if a feed goes silent or floods.
 */
export function createAtomicEventPool(options: AtomicEventPoolOptions = {}): AtomicEventPool {
  const capacity = options.capacity ?? ATOMIC_EVENT_POOL_CAPACITY;
  const highWatermark = options.highWatermark ?? Math.floor(capacity * 0.875);
  const maxAgeMs = options.maxAgeMs ?? ATOMIC_EVENT_MAX_AGE_MS;

  const events: AtomicEvent[] = [];
  const keys = new Set<string>();

  function dropStale(nowMs: number): void {
    if (events.length === 0) return;
    let start = 0;
    // Events are kept oldest-first; find the first still-fresh index.
    while (start < events.length && nowMs - events[start].at > maxAgeMs) start += 1;
    if (start > 0) {
      events.splice(0, start);
      rebuildKeys();
    }
  }

  function rebuildKeys(): void {
    keys.clear();
    for (const e of events) keys.add(atomicEventDedupeKey(e));
  }

  function shedOldest(): void {
    while (events.length > highWatermark) events.shift();
    rebuildKeys();
  }

  return {
    capacity,
    highWatermark,
    maxAgeMs,
    get size() {
      return events.length;
    },
    ingest(event, nowMs) {
      const key = atomicEventDedupeKey(event);
      // Exact dedupe: a re-delivered transition is a no-op.
      if (keys.has(key)) return;
      // Drop stale first so a burst of old events cannot push us over capacity.
      dropStale(nowMs);
      if (events.length >= highWatermark) shedOldest();
      events.push(event);
      keys.add(key);
      // Keep the array within the hard cap even if a single ingest pushed it over.
      if (events.length > capacity) {
        events.splice(0, events.length - capacity);
        rebuildKeys();
      }
    },
    dropStale,
    clear() {
      events.length = 0;
      keys.clear();
    },
    effectsFor(providerId, nowMs) {
      let best = 0;
      let red = false;
      for (const e of events) {
        if (e.providerId !== providerId) continue;
        const age = nowMs - e.at;
        if (age < 0) continue; // not yet (future-observed); never negative age
        const d = computeDischarge(age, e.kind);
        if (d.intensity > best) best = d.intensity;
        if (d.red && d.intensity > 0) red = true;
      }
      return { intensity: best, red };
    },
    activeAt(nowMs) {
      const out: AtomicEvent[] = [];
      for (const e of events) {
        const age = nowMs - e.at;
        if (age < 0) continue;
        if (computeDischarge(age, e.kind).intensity > 0) out.push(e);
      }
      return out;
    },
    events() {
      return events;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Core lifecycle stream → pool AtomicEvents (pure bridge)            */
/* ------------------------------------------------------------------ */

/** Bounded core lifecycle phase → Atomic pool event kind. */
const PHASE_TO_KIND: Record<TopologyLifecycleEvent["phase"], AtomicEventKind> = {
  started: "request-started",
  completed: "request-completed",
  failed: "request-failed",
};

/**
 * Map a snapshot's bounded `lifecycle` stream into pool {@link AtomicEvent}s.
 *
 * Pure: same snapshot → same events; the mapping copies fields verbatim and
 * attaches a *conservatively-classified* lane only when the observed model id
 * actually classifies ({@link deriveLaneFromModel}) — it never fabricates a
 * lane. Returns `[]` when the snapshot carries no lifecycle feed (absent ≠ 0).
 */
export function mapLifecycleToAtomicEvents(snapshot: TopologySceneSnapshot): AtomicEvent[] {
  const lifecycle = snapshot.lifecycle;
  if (!lifecycle || lifecycle.length === 0) return [];

  const out: AtomicEvent[] = [];
  for (const ev of lifecycle) {
    const kind = PHASE_TO_KIND[ev.phase];
    if (!kind) continue; // defensive: only the bounded set maps

    const providerId = ev.provider ?? "";
    const lane = ev.model ? deriveLaneFromModel(ev.model) : null;

    out.push({
      id: `${kind}:${ev.requestId}:${ev.observedAt}`,
      at: ev.observedAt,
      kind,
      providerId,
      resourceId: ev.requestId,
      modelId: ev.model,
      lane: lane ?? undefined,
      linkId: providerId ? `route:${providerId}` : undefined,
    });
  }
  return out;
}
