/**
 * Renderer-neutral topology snapshot types (OR-ATOM-001 v2, T004 / M1 + M4).
 *
 * These types describe the *data* the topology panel observes — a set of atom
 * nodes (hub / provider / gpu) and the route links between them — in a shape
 * that no specific renderer (2D ReactFlow, a future 3D/Atomic renderer, an
 * SVG renderer, …) needs to know about. The core owns this data; a renderer
 * plugin owns only the presentation of a snapshot it is handed
 * (see `src/shared/topology/renderer/types.ts`).
 *
 * Invariants (M1):
 * - Absent data is `null` / `undefined`, never `0` (a `0` would assert that we
 *   *observed* zero — we only ever assert what we actually saw).
 * - M1 never emits `kind: "gpu"`: provider routes must never be conflated with
 *   physical devices. `AtomKind` keeps the member for forward compatibility.
 * - No fabricated telemetry: every `Observed<T>` records its `source` and
 *   `sampledAt`; a value we did not sample is left `null`.
 *
 * Invariants (M4 — live-request lifecycle):
 * - The snapshot may carry a bounded, event-derived `lifecycle` observation
 *   (see {@link TopologyLifecycleEvent}). It is derived ONLY from existing
 *   request started/completed/failed events; the domain never fabricates
 *   events, and every entry keeps the source event's timestamp as provenance.
 * - Snapshot values are provenance-carrying and immutable: normalization
 *   deep-freezes what it returns, so renderers may hold snapshots without
 *   ever mutating core-owned data.
 */

import type { TopologyLane } from "./lane";

/** Atom kinds a topology node can represent. */
export type AtomKind = "hub" | "provider" | "gpu";

/**
 * Connection-health base state, independent of traffic. A provider with a live
 * healthy connection but no in-flight traffic is still `healthy`; one whose
 * connection failed is `unhealthy`; one we have never observed is `unknown`.
 */
export type HealthState = "healthy" | "unhealthy" | "unknown";

/** In-flight / recency traffic state. */
export type TrafficState = "active" | "recent" | "idle";

/**
 * A single observation of a value, tagged with where it came from and when.
 * `value` is `null` when the observation was absent (NOT `0` — see invariants).
 */
export interface Observed<T> {
  value: T | null;
  source: "live-event" | "call-log" | "runtime" | "provider-metrics" | "derived";
  sampledAt: number;
  /** Observation window the value was aggregated over (ms), when meaningful. */
  windowMs?: number;
  /** True when the observation is older than the freshness window. */
  stale?: boolean;
  /** Human-readable derivation basis (e.g. which live channel / log it came from). */
  basis?: string;
}

/**
 * Live-request lifecycle transition observed on the existing gated
 * live-requests feed (M4). The set of transitions is intentionally bounded to
 * what the feed actually emits — started / completed / failed — so renderers
 * can never be asked to animate a state the core has not observed.
 */
export type RequestLifecyclePhase = "started" | "completed" | "failed";

/** Terminal outcome of a request. `error` covers both failed streams and
 * completed-with-error payloads (`status: "error"`). */
export type RequestLifecycleOutcome = "success" | "error" | "unknown";

/**
 * One bounded, provenance-carrying lifecycle event in the snapshot.
 * Derived verbatim from a request started/completed/failed event: every field
 * that the source did not carry is *absent* (never a fabricated placeholder),
 * and `observedAt` is the source event's own timestamp — the renderer's
 * discharge clock, not the snapshot capture time.
 */
export interface TopologyLifecycleEvent {
  /** Source event kind (bounded set; see {@link RequestLifecyclePhase}). */
  phase: RequestLifecyclePhase;
  /** Request id from the source event (stable per logical request). */
  requestId: string;
  /** Provider the request was addressed to, when the source carried one. */
  provider?: string;
  /** Model the request targeted, when the source carried one. */
  model?: string;
  /** Terminal outcome; only meaningful for completed/failed phases. */
  outcome?: RequestLifecycleOutcome;
  /** Upstream error label, when a failed event carried one. */
  error?: string;
  /** Source event timestamp (epoch ms) — provenance, not capture time. */
  observedAt: number;
}

/**
 * One topology node. `id` is the stable canonical layout identity
 * (see `layoutIdentity.ts`): `hub` for the center, `provider:<id>` for a
 * provider. `providerId` / `routeId` / `aliases` carry the click-through and
 * alias-matching metadata; they are absent on the hub.
 */
export interface TopologySceneNode {
  id: string;
  kind: AtomKind;
  label: string;
  providerId?: string;
  routeId?: string;
  aliases?: string[];
  health: HealthState;
  traffic: TrafficState;
  lastRoutedAt?: number;
  latestErrorAt?: number;
  /** In-flight request count for this node, with provenance (absent when idle). */
  activeRequests?: Observed<number>;
  /**
   * Job lane the node is serving right now, derived from its in-flight model
   * ids (see `domain/lane.ts`). Optional on purpose: **absent** means "no
   * classifiable in-flight traffic" — never a fabricated observation. A
   * renderer treats an absent (or unrecognizable) lane as a *coloring default*
   * (neutral hue), which is not an observed lane fact.
   */
  lane?: Observed<TopologyLane>;
}

/**
 * A topology link. In M1 every link is a provider route edge (source = hub,
 * target = provider). `kind` is reserved for future non-route links.
 */
export interface TopologySceneLink {
  id: string;
  source: string;
  target: string;
  kind: "route";
  health: HealthState;
  traffic: TrafficState;
}

/** A renderer-neutral snapshot of the topology at a point in time. */
export interface TopologySceneSnapshot {
  /** Schema version; `1` for the M1/M3 shape. */
  schemaVersion: 1;
  /** Instant the snapshot was captured (ms-since-epoch). */
  capturedAt: number;
  /** All nodes — hub first, then provider/gpu atoms. */
  nodes: TopologySceneNode[];
  /** All route links; empty when no provider routes are observed. */
  links: TopologySceneLink[];
  /**
   * Bounded live-request lifecycle events observed since the last snapshot
   * window, each with its own source provenance (M4). **Absent** when no
   * lifecycle input was given — an empty observation would falsely claim "we
   * watched the feed and nothing happened", which the core cannot know.
   */
  lifecycle?: TopologyLifecycleEvent[];
}
