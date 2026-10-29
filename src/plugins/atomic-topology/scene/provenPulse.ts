/**
 * Proven pulse gate — OR-ATOM-009 S9.4 / S9.5 (pure, no `three`, no DOM).
 *
 * Decides which route links may carry bounded pulses and, for the dev/test
 * trigger surface, dedupes repeated polling/lifecycle events and caps the
 * concurrent pulses per link. Everything here is *provenance-driven*: a pulse
 * may ride a link only when that link is proven, and "proven" is computed from
 * the snapshot's OWN evidence (an observed provider atom for the route,
 * optionally corroborated by a fleet-telemetry provider sample) — never from a
 * guessed provider→runtime→GPU join.
 *
 * Provenance rule (matches `atomic-topology-step9-attribution-matrix.md` §1):
 *   - A `route:<providerId>` link is **proven** when the target provider atom
 *     (`provider:<providerId>`) is present in the snapshot's node set — the
 *     route was observed routing (call-log / active-request evidence).
 *   - Its **basis** is `call-log route`, strengthened to
 *     `call-log route + fleet-metrics` when a fleet-telemetry provider sample
 *     corroborates the same provider. A link whose target provider atom is
 *     absent (defensively — real snapshots build route links only from present
 *     providers) is **unproven**.
 *   - The downstream provider→runtime→GPU segments are *unknown edges*: no
 *     link exists for them, so pulses animate through the proven route segment
 *     and the rest stays unconnected (S9.4). No join is ever inferred.
 *
 * This module is an EVENT-RATE (ingest / dev-trigger) surface, not a per-frame
 * one: the per-frame packet loop in `EnergyLink.tsx` reads the boolean
 * `descriptor.proven` (derived from {@link computeProvenRouteLinks}) and the
 * fixed `MAX_PACKET_POOL` cap, so the scene never calls into the gate per
 * frame (zero per-frame allocations). The gate's {@link ProvenPulseGate}
 * adds the dedupe-window + concurrent-pulse cap on top, exercised by the
 * dev-only `window.__atomicPulse` trigger and by unit tests.
 */
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";

/** The provenance basis for a proven route link backed only by call-log/route evidence. */
export const PROVEN_BASIS_CALL_LOG = "call-log route" as const;
/** The provenance basis when a fleet-telemetry provider sample corroborates the route. */
export const PROVEN_BASIS_FLEET = "call-log route + fleet-metrics" as const;
/** The provenance tag for a link whose target provider atom is absent (unproven). */
export const UNPROVEN_BASIS_NO_TARGET = "unproven (no target provider atom)" as const;

/**
 * Default concurrent-pulse cap per link. Aligned with `MAX_PACKET_POOL`
 * (`scene/filament.ts`) — the scene already bounds rendered packets to this,
 * so the gate's cap matches the visual cap (one pulse slot per visible packet).
 */
export const DEFAULT_PULSE_CAP = 3;
/**
 * Dedupe window (ms): repeated events for the same link within this window are
 * collapsed (one logical request arriving from polling + lifecycle is a single
 * pulse). Mirrors the pool's short transient windows (≪ 60 s max age).
 */
export const DEFAULT_DEDUPE_WINDOW_MS = 150;
/**
 * A pulse is considered "live" for this long (ms) — aligned with the packet
 * hop period (`PULSE_PERIOD_S` ≈ 2.5 s in `EnergyLink.tsx`), so the concurrent
 * cap counts pulses that are actually on screen.
 */
export const DEFAULT_PULSE_LIFETIME_MS = 2500;

/** The proven-link evidence computed from a single snapshot (pure). */
export interface ProvenRouteLinks {
  /** The set of link ids that may carry pulses (proven route links). */
  readonly provenLinkIds: ReadonlySet<string>;
  /** The provenance basis string per link id (present for every snapshot link). */
  readonly basisById: ReadonlyMap<string, string>;
}

/** The canonical link id for a provider's hub→provider route. */
export function canonicalRouteLinkId(providerId: string): string {
  return `route:${providerId}`;
}

/** The canonical provider atom id for a provider. */
export function canonicalProviderAtomId(providerId: string): string {
  return `provider:${providerId}`;
}

/**
 * Compute which route links are proven (and each one's provenance basis) from
 * a snapshot's OWN evidence. Pure: same snapshot → same result; no clock, no
 * DOM, no WebGL. See the module doc for the provenance rule.
 */
export function computeProvenRouteLinks(snapshot: TopologySceneSnapshot): ProvenRouteLinks {
  const atomIds = new Set<string>();
  for (const node of snapshot.nodes) atomIds.add(node.id);

  // Fleet-telemetry corroboration: which provider atoms also carry a fresh
  // fleet sample (basis strengthening only — never the basis for "proven").
  const fleetProviderAtomIds = new Set<string>();
  const reconciliation = snapshot.fleetTelemetry;
  if (reconciliation) {
    for (const pn of reconciliation.providerNodes) {
      if (pn.providerId) fleetProviderAtomIds.add(canonicalProviderAtomId(pn.providerId));
    }
  }

  const provenLinkIds = new Set<string>();
  const basisById = new Map<string, string>();
  for (const link of snapshot.links) {
    const targetPresent = atomIds.has(link.target);
    if (targetPresent) provenLinkIds.add(link.id);
    basisById.set(
      link.id,
      targetPresent
        ? fleetProviderAtomIds.has(link.target)
          ? PROVEN_BASIS_FLEET
          : PROVEN_BASIS_CALL_LOG
        : UNPROVEN_BASIS_NO_TARGET
    );
  }
  return { provenLinkIds, basisById };
}

/** The outcome of a pulse admission attempt (reason is `"admitted"` when ok). */
export interface PulseAdmission {
  ok: boolean;
  reason: "admitted" | "unproven" | "deduped" | "capped";
}

/**
 * A proven-gated pulse admission surface (event-rate; dev trigger + tests).
 * `admit` succeeds only when the link is proven, the event is not a
 * dedupe-window duplicate, and the per-link concurrent cap has a free slot.
 */
export interface ProvenPulseGate {
  /** The concurrent-pulse cap per link. */
  readonly cap: number;
  /** Whether `linkId` is a proven link. */
  isProven(linkId: string): boolean;
  /**
   * Admit one pulse on `linkId` at `nowMs`. Returns the rejection reason when
   * the link is unproven, the event is a dedupe-window duplicate, or the cap
   * is reached. Idempotent-safe: a duplicate is dropped, not double-counted.
   */
  admit(linkId: string, nowMs: number): PulseAdmission;
  /** The number of live pulses on `linkId` at `nowMs` (0 when unproven). */
  activeOn(linkId: string, nowMs: number): number;
  /** The number of links currently carrying at least one live pulse. */
  activeLinkCount(nowMs: number): number;
}

/** Options for {@link createProvenPulseGate}. */
export interface ProvenPulseGateOptions {
  cap?: number;
  dedupeWindowMs?: number;
  pulseLifetimeMs?: number;
}

/**
 * Create a proven-gated pulse admission surface over a set of proven link ids.
 * Allocation is bounded by the number of proven links (built once); per-call
 * work is a bounded Map read/prune (event-rate, not per-frame).
 */
export function createProvenPulseGate(
  provenLinkIds: Iterable<string>,
  options: ProvenPulseGateOptions = {}
): ProvenPulseGate {
  const cap = options.cap ?? DEFAULT_PULSE_CAP;
  const dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const pulseLifetimeMs = options.pulseLifetimeMs ?? DEFAULT_PULSE_LIFETIME_MS;

  const proven = new Set<string>(provenLinkIds);
  // Per-link admit timestamps (used for both the dedupe window and the cap).
  const admitTimes = new Map<string, number[]>();

  function liveCount(linkId: string, nowMs: number): number {
    const times = admitTimes.get(linkId);
    if (!times || times.length === 0) return 0;
    const cutoff = nowMs - pulseLifetimeMs;
    // Prune expired pulses in place (event-rate; bounded by the cap).
    let firstLive = 0;
    while (firstLive < times.length && times[firstLive] < cutoff) firstLive += 1;
    if (firstLive > 0) times.splice(0, firstLive);
    return times.length;
  }

  return {
    cap,
    isProven: (linkId) => proven.has(linkId),
    admit(linkId, nowMs): PulseAdmission {
      if (!proven.has(linkId)) return { ok: false, reason: "unproven" }; // unproven — never a pulse
      const times = admitTimes.get(linkId);
      if (times && times.length > 0) {
        // Dedupe: an event within the dedupe window of the last admit on this
        // link is a repeat (polling + lifecycle for the same request) → drop.
        if (nowMs - times[times.length - 1] < dedupeWindowMs) {
          return { ok: false, reason: "deduped" };
        }
      }
      if (liveCount(linkId, nowMs) >= cap) return { ok: false, reason: "capped" }; // cap reached
      if (times) times.push(nowMs);
      else admitTimes.set(linkId, [nowMs]);
      return { ok: true, reason: "admitted" };
    },
    activeOn: (linkId, nowMs) => (proven.has(linkId) ? liveCount(linkId, nowMs) : 0),
    activeLinkCount(nowMs) {
      let count = 0;
      for (const linkId of proven) if (liveCount(linkId, nowMs) > 0) count += 1;
      return count;
    },
  };
}

/**
 * Filter a batch of lifecycle events through a proven gate (S9.4 ingest
 * surface). Returns the sub-batch that may enter the event pool: only events
 * on a PROVEN link, deduped within the gate's window and capped at the
 * gate's concurrent-pulse budget. Events without a link id are never pulsed
 * (no proven segment to ride). Pure: no mutation of the input, no clock.
 */
export function admitPulseEvents<T extends { linkId?: string }>(
  events: readonly T[],
  gate: ProvenPulseGate,
  nowMs: number
): T[] {
  const out: T[] = [];
  for (const e of events) {
    if (!e.linkId) continue; // no link → no proven segment → never a pulse
    if (gate.admit(e.linkId, nowMs).ok) out.push(e);
  }
  return out;
}
