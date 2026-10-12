/**
 * Atomic event pool — types and capacity constants ONLY
 * (OR-ATOM-001 v2, T006a / M3 Phase A).
 *
 * This module is the *contract* for the event-driven animation pipeline that
 * M4 implements (request started / completed / failed → atom pulses, ring
 * waves, link flares). Phase A deliberately ships no behavior: no pool
 * implementation, no timers, no `three` imports — only the event shape, the
 * bounded capacity constants, and the dedupe-key semantics documented below.
 */
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
   * pool treats it as opaque; dedupe uses {@link dedupeKey} semantics, NOT
   * this id, because two sources may report the same logical request with
   * different ids.
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
 * Dedupe key semantics (M4 must implement exactly this):
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
