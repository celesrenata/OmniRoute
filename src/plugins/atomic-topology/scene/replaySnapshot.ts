/**
 * Replay snapshot builder (OR-ATOM Step 12). Pure, three-free, DOM-free.
 *
 * Turns a LIVE snapshot (only its structure: which atoms and links exist) plus
 * the recorded {@link TraceRecord}s into the snapshot the scene would have had
 * at replay time `atMs`. Only recorded observations drive it:
 *
 *   - a provider is `active` while a recorded request is in flight
 *     (`start <= atMs < start + measured duration`), `recent` for
 *     {@link REPLAY_RESULT_HOLD_MS} after a recorded success, and shows its
 *     `error` state for the same hold after a recorded failure;
 *   - in-flight models, lane and recent-models (nucleus colours, afterglow tier)
 *     come from the recorded rows by the same rules the live adapter uses;
 *   - everything LIVE is suspended: the lifecycle stream is dropped and every
 *     fleet-telemetry measurement is neutralised to "no data" (value `null`,
 *     stale) so spin, queue vibration and device bars never show current live
 *     values during a replay. Atom membership and proven relationships are kept
 *     so the layout (and the camera framing) does not move.
 *   - connection health is not a recorded fact: it is kept from the live
 *     snapshot, except a live `unhealthy` reads as `unknown` (not asserted).
 *
 * Nothing is interpolated or invented: no records, no activity.
 */
import type {
  Observed,
  TopologySceneLink,
  TopologySceneNode,
  TopologySceneSnapshot,
} from "@/shared/topology/domain/types";
import { deriveLaneForProvider } from "@/shared/topology/domain/lane";
import {
  RECENT_MODELS_BASIS,
  RECENT_MODELS_WINDOW_MS,
  canonicalModelId,
  deriveRecentProviderModels,
  recentModelsForEntry,
  type RecentCallLogRow,
} from "@/shared/topology/domain/recentModels";
import type { TraceRecord } from "@/shared/topology/telemetry/traceHistory";

/** How long a recorded outcome keeps its "recent" / "error" state (replay time). */
export const REPLAY_RESULT_HOLD_MS = 4000;
/** Provenance label carried on every replay-derived observation. */
export const REPLAY_BASIS = "recorded request history (replay)";
/** Per-link traffic-heat decay constant (replay time). */
export const REPLAY_HEAT_TAU_MS = 20_000;
/** Added to a link's steady filament intensity at full heat (idle base is 0.14..0.36). */
export const REPLAY_HEAT_GAIN = 0.45;

/** One recorded request: its start and (when recorded) its outcome. */
export interface ReplayRequest {
  key: string;
  /** Lower-cased provider key (join key for atoms and aliases). */
  providerKey: string;
  model?: string;
  startAt: number;
  /** Terminal time; `null` while the row was still in flight when fetched. */
  endAt: number | null;
  outcome: "ok" | "failed" | null;
}

/** Pair each request's started / terminal records. Pure, order-preserving by start. */
export function buildReplayRequests(records: readonly TraceRecord[]): ReplayRequest[] {
  const byKey = new Map<string, ReplayRequest>();
  const order: ReplayRequest[] = [];
  for (const r of records) {
    const key = r.id.slice(r.id.indexOf(":") + 1);
    let req = byKey.get(key);
    if (!req) {
      req = {
        key,
        providerKey: r.providerId.toLowerCase(),
        model: r.modelId,
        startAt: r.at,
        endAt: null,
        outcome: null,
      };
      byKey.set(key, req);
      order.push(req);
    }
    if (r.kind === "request-started") {
      req.startAt = r.at;
    } else {
      req.endAt = r.at;
      req.outcome = r.kind === "request-failed" ? "failed" : "ok";
    }
  }
  return order;
}

function nodeMatches(node: TopologySceneNode, providerKey: string): boolean {
  if (node.providerId && node.providerId.toLowerCase() === providerKey) return true;
  return (node.aliases ?? []).some((a) => a.toLowerCase() === providerKey);
}

interface ProviderState {
  inFlight: ReplayRequest[];
  lastStartAt: number | null;
  recentOkAt: number | null;
  recentFailAt: number | null;
}

/** Recorded state of one provider node at `atMs`. */
function stateAt(
  node: TopologySceneNode,
  requests: readonly ReplayRequest[],
  atMs: number
): ProviderState {
  const s: ProviderState = {
    inFlight: [],
    lastStartAt: null,
    recentOkAt: null,
    recentFailAt: null,
  };
  for (const req of requests) {
    if (req.startAt > atMs) continue;
    if (!nodeMatches(node, req.providerKey)) continue;
    if (s.lastStartAt == null || req.startAt > s.lastStartAt) s.lastStartAt = req.startAt;
    const ended = req.endAt != null && req.endAt <= atMs;
    // In flight: started, not yet ended (or still open when fetched) and a measured span.
    if (!ended && req.endAt !== req.startAt) s.inFlight.push(req);
    if (ended && atMs - (req.endAt as number) < REPLAY_RESULT_HOLD_MS) {
      if (req.outcome === "failed") {
        if (s.recentFailAt == null || (req.endAt as number) > s.recentFailAt)
          s.recentFailAt = req.endAt;
      } else if (req.outcome === "ok") {
        if (s.recentOkAt == null || (req.endAt as number) > s.recentOkAt) s.recentOkAt = req.endAt;
      }
    }
  }
  return s;
}

const observed = <T>(value: T, atMs: number, basis: string): Observed<T> => ({
  value,
  source: "call-log",
  sampledAt: atMs,
  basis,
});

/** Make every measurement in a fleet-telemetry block "no data" (value null, stale). */
export function neutralizeFleetTelemetry<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => neutralizeFleetTelemetry(v)) as unknown as T;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("value" in o && "source" in o && "sampledAt" in o) {
      return { ...o, value: null, stale: true } as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = neutralizeFleetTelemetry(v);
    if (typeof o.stale === "boolean") out.stale = true;
    return out as T;
  }
  return value;
}

/**
 * The snapshot the scene would have had at replay time `atMs`.
 * `requests` is {@link buildReplayRequests} of the timeline (computed once).
 */
export function buildReplaySnapshot(
  live: TopologySceneSnapshot,
  requests: readonly ReplayRequest[],
  atMs: number
): TopologySceneSnapshot {
  // Pseudo call-log rows for the recent-models rule: successful recorded requests only.
  const okRows: RecentCallLogRow[] = [];
  for (const req of requests) {
    if (req.outcome !== "ok" || req.endAt == null || req.endAt > atMs || !req.model) continue;
    okRows.push({
      provider: req.providerKey,
      model: req.model,
      status: 200,
      timestamp: new Date(req.endAt).toISOString(),
    });
  }
  const tallies = deriveRecentProviderModels(okRows, { now: atMs });

  let hubActive = 0;
  const trafficById = new Map<string, TopologySceneNode>();
  const nodes: TopologySceneNode[] = live.nodes.map((node) => {
    if (node.kind === "hub") return node;
    const {
      activeRequests: _a,
      inFlightModels: _m,
      lane: _l,
      observedModels: _o,
      latestErrorAt: _e,
      lastRoutedAt: _r,
      ...rest
    } = node;
    (void _a, _m, _l, _o, _e, _r);
    const s = stateAt(node, requests, atMs);
    const failed = s.recentFailAt != null;
    const active = s.inFlight.length > 0;
    const next: TopologySceneNode = {
      ...rest,
      health: failed ? "unhealthy" : node.health === "unhealthy" ? "unknown" : node.health,
      traffic: active ? "active" : s.recentOkAt != null ? "recent" : "idle",
    };
    if (s.lastStartAt != null) next.lastRoutedAt = s.lastStartAt;
    if (failed) next.latestErrorAt = s.recentFailAt as number;
    if (active) {
      hubActive += s.inFlight.length;
      next.activeRequests = observed(s.inFlight.length, atMs, REPLAY_BASIS);
      const models = Array.from(
        new Set(s.inFlight.map((r) => canonicalModelId(r.model)).filter(Boolean))
      );
      if (models.length > 0) {
        next.inFlightModels = observed(models, atMs, REPLAY_BASIS);
        const lane = deriveLaneForProvider(models);
        if (lane) next.lane = observed(lane.lane, atMs, lane.basis);
      }
    }
    const recent = recentModelsForEntry(tallies, {
      provider: node.providerId ?? node.id,
      aliases: node.aliases,
    });
    if (recent) {
      next.observedModels = {
        value: recent.models,
        source: "call-log",
        sampledAt: recent.newestAt,
        windowMs: RECENT_MODELS_WINDOW_MS,
        basis: `${RECENT_MODELS_BASIS} (${REPLAY_BASIS})`,
      };
    }
    trafficById.set(node.id, next);
    return next;
  });

  const withHub = nodes.map((n) => {
    if (n.kind !== "hub") return n;
    const { activeRequests: _a, ...rest } = n;
    void _a;
    const hub: TopologySceneNode = { ...rest, traffic: hubActive > 0 ? "active" : "idle" };
    if (hubActive > 0) hub.activeRequests = observed(hubActive, atMs, REPLAY_BASIS);
    return hub;
  });

  const links: TopologySceneLink[] = live.links.map((link) => {
    const target = trafficById.get(link.target);
    return target ? { ...link, health: target.health, traffic: target.traffic } : link;
  });

  const snap: TopologySceneSnapshot = {
    schemaVersion: 1,
    capturedAt: atMs,
    nodes: withHub,
    links,
  };
  if (live.fleetTelemetry) snap.fleetTelemetry = neutralizeFleetTelemetry(live.fleetTelemetry);
  return snap;
}

/**
 * Cheap change key: the scene only needs a re-render when something it reads
 * from the snapshot changes. Excludes `capturedAt` on purpose.
 */
export function replaySnapshotKey(snap: TopologySceneSnapshot): string {
  return snap.nodes
    .map(
      (n) =>
        `${n.id}|${n.health}|${n.traffic}|${n.latestErrorAt ?? ""}|${n.activeRequests?.value ?? ""}|` +
        `${(n.inFlightModels?.value ?? []).join(",")}|${(n.observedModels?.value ?? []).join(",")}|` +
        `${n.observedModels?.sampledAt ?? ""}`
    )
    .join(";");
}

/**
 * Spatial traffic history: per-provider decaying heat in `[0, 1)` at `atMs`, from
 * recorded started + outcome records. Each record contributes
 * `exp(-(atMs - at) / tau)`; the sum saturates smoothly (`1 - exp(-sum/2)`).
 * Records after `atMs` contribute nothing; no records means exactly 0.
 */
export function trafficHeat(
  events: readonly { at: number; providerId?: string }[] | null | undefined,
  providerId: string | null | undefined,
  atMs: number,
  tauMs = REPLAY_HEAT_TAU_MS
): number {
  if (!events || !providerId || !Number.isFinite(atMs)) return 0;
  const key = providerId.toLowerCase();
  let sum = 0;
  for (const e of events) {
    if (!e.providerId || e.providerId.toLowerCase() !== key) continue;
    const age = atMs - e.at;
    if (age < 0) continue;
    sum += Math.exp(-age / tauMs);
  }
  return sum > 0 ? 1 - Math.exp(-sum / 2) : 0;
}
