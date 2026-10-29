"use client";

/**
 * Atomic topology renderer — Phase B lifecycle adapter (OR-ATOM-001 v2, T006b /
 * M3 Phase B).
 *
 * This module is the *safe lifecycle adapter* between the renderer-plugin
 * contract (`TopologyRendererPlugin` / `TopologyRendererInstance`, see
 * `@/shared/topology/renderer/types.ts`) and the real WebGL2 scene. It is the
 * single client-only surface that:
 *
 *   1. gates `mount` on the environment's WebGL2 capability (re-using the
 *      SSR-safe `detectTopologyCapabilities` from `./capabilities`), throwing
 *      a typed {@link AtomicWebGLUnsupportedError} when it is absent so the
 *      host can fall back to the default 2D renderer;
 *   2. creates a *client-only scene host* — a plain `<div>` owned by the
 *      renderer — into which the 3D scene + DOM overlays are mounted through a
 *      dedicated `react-dom` `Root`; and
 *   3. drives that host imperatively via `update` / `resize` / `setPaused` /
 *      `focusNode` / `dispose` — all idempotent and safe to call after
 *      `dispose` (no-ops).
 *
 * Why the 3D scene is imported *dynamically* (not at the top of this file):
 * the scene subtree (`./scene/*`) is the only place that pulls in `three` +
 * `@react-three/fiber`. Keeping it behind a client-only `import()` means merely
 * importing this adapter — and therefore the plugin `index.ts` — stays cheap on
 * the server and in jsdom, preserving the Phase A-established invariant that
 * the plugin's
 * pure side never drags the heavy 3D stack into the static module graph. The
 * DOM overlay components (`./overlays/*`) are pure React (no `three`) and are
 * imported statically, so they stay testable under jsdom.
 *
 * `mount` is synchronous by contract, so the WebGL gate happens here and the
 * *rendering* of the scene module is deferred to the host component's
 * `useEffect` (client-only).
 *
 * Explicit unknowns (bounded scope — deliberately NOT implemented):
 * - **Spatially-projected labels**: labels are a DOM *roster* (a panel listing
 *   every atom), not pixel-projected screen labels. True projection would
 *   require `three` (for the camera math) or drei's `<Html>`, both of which
 *   would pull the 3D stack into the static graph or add a heavy dependency.
 * - **Live queue telemetry**: the snapshot carries no queue depth, so atom
 *   vibration is always "unavailable" (never fabricated) in this phase.
 * - **GPU device atoms (`kind: "gpu"`)**: never emitted by M1; rendered
 *   forward-compatibly, but no M1 snapshot carries them.
 *
 * Implemented (M4/M6): the bounded request-lifecycle event pool (transient
 * discharges), the deterministic camera fit/focus, the quality-fallback
 * ladder, reduced-motion, the document-hidden pause, the WebGL context-loss
 * guard, and the telemetry stale/unavailable badge — all wired through the
 * host-owned {@link AtomicSceneContextValue} (see `./scene/sceneContext.ts`).
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  TopologyRendererInstance,
  TopologyRendererOptions,
} from "@/shared/topology/renderer/types";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";
import type {
  ReconciledProviderNode,
  ReconciledRuntimeNode,
} from "@/shared/topology/telemetry/reconcile";
import { deriveLaneForProvider } from "@/shared/topology/domain/lane";

import { detectTopologyCapabilities } from "./capabilities";
import { computeAtomicLayout, computeDeviceBandLayout, type AtomicLayoutNode } from "./layout";
import { computeFitRadiusFromPositions } from "./cameraFit";
import {
  asJobLane,
  laneHue,
  modelColor,
  spinRadiansPerSecond,
  queueVibration,
  resolveVisualState,
  type JobLane,
  type TopologyLane,
  type SpinResult,
  type VibrationResult,
  type AtomicVisualState,
  type AtomicVisualStateInput,
} from "./visualEncoding";

import { AtomicControls } from "./overlays/AtomicControls";
import { AtomicLegend } from "./overlays/AtomicLegend";
import { AtomicLabels } from "./overlays/AtomicLabels";
import { AtomicTooltip } from "./overlays/AtomicTooltip";
import { AtomicTelemetryStatus, type AtomicTelemetryState } from "./overlays/AtomicTelemetryStatus";
import {
  createAtomicEventPool,
  mapLifecycleToAtomicEvents,
  type AtomicEventPool,
  type AtomicEventKind,
} from "./eventPool";
import { resolveSceneQuality, type QualityProbe } from "./quality";
import {
  admitPulseEvents,
  canonicalRouteLinkId,
  computeProvenRouteLinks,
  createProvenPulseGate,
  type ProvenPulseGate,
} from "./scene/provenPulse";
import { createAtomicCameraState, type AtomicSceneContextValue } from "./scene/sceneContext";

// Re-export the pure visual-encoding types so the scene/overlay subtree has a
// single import point (this adapter) rather than reaching into `visualEncoding`
// directly.
export type { JobLane, SpinResult, VibrationResult, AtomicVisualState, AtomicVisualStateInput };

/**
 * Dev/test-only pulse trigger (OR-ATOM-009 S9.4 / S9.5). Present on `window`
 * ONLY outside production and while an Atomic renderer instance is mounted
 * (the imperative instance assigns it on create and `delete`s it on
 * `dispose`). It injects ONE deterministic pulse onto a proven route link
 * through the same proven gate + event pool — it never fabricates telemetry
 * into real snapshot data.
 */
declare global {
  interface Window {
    __atomicPulse?: (
      providerId: string,
      kind?: "request-started" | "request-completed" | "request-failed"
    ) => { ok: boolean; reason: string; linkId?: string };
  }
}

/**
 * The snapshot-feed freshness window (ms) the telemetry badge keys off: a
 * snapshot older than this is `stale`, a missing/invalid `capturedAt` is
 * `unavailable`, otherwise `available`. Named so the threshold is a single
 * value change, not a refactor.
 */
const TELEMETRY_FRESH_WINDOW_MS = 5_000;

/**
 * The world-unit margin added beyond the farthest ring atom's centerline when
 * computing the responsive fit radius (UX correction): the atom's visual
 * extent (radius + electron cloud, matching the scene's `ATOM_RADIUS + 16`),
 * so the outermost atom sits just inside the frustum rather than on its edge.
 */
const ATOM_FIT_MARGIN = 38;

/* ------------------------------------------------------------------ */
/* Typed error for the unsupported-WebGL path                          */
/* ------------------------------------------------------------------ */

/**
 * Thrown by {@link mountAtomicTopologyRenderer} when the environment cannot
 * create a WebGL2 context. The host contract treats a `mount()` throw as
 * "fall back to the default 2D renderer", so this is the clean, catchable
 * signal a caller (or test) can match on. `code` is stable.
 */
export class AtomicWebGLUnsupportedError extends Error {
  /** Stable error code: `ATOMIC_WEBGL_UNSUPPORTED`. */
  readonly code = "ATOMIC_WEBGL_UNSUPPORTED" as const;

  constructor() {
    super(
      "Atomic topology renderer: this environment cannot create a WebGL2 " +
        "context, so the 3D scene cannot be mounted. The host must fall back " +
        "to the default 2D renderer."
    );
    this.name = "AtomicWebGLUnsupportedError";
  }
}

/* ------------------------------------------------------------------ */
/* Pure data → visual-descriptor bridge (testable without WebGL)       */
/* ------------------------------------------------------------------ */

/**
 * The visual parameters for a single atom, derived *purely* from the snapshot
 * + the deterministic layout. The 3D scene consumes these to place and style
 * each atom; tests exercise this function directly (no WebGL required).
 *
 * This is the bridge between "pure" data (layout positions, encoding rules) and
 * the presentational scene: every visual attribute an atom renders is decided
 * here, so a renderer refactor cannot silently change what an atom looks like
 * without touching this mapping.
 */
export interface AtomVisualDescriptor {
  /** Canonical atom id (`hub`, `provider:<id>`, `gpu:<id>`). */
  id: string;
  /** Atom kind. */
  kind: "hub" | "provider" | "gpu" | "runtime";
  /** Human label (from the snapshot node). */
  label: string;
  /** Provider id the atom represents (absent for the hub / gpu atoms). */
  providerId?: string;
  /**
   * Observed in-flight model ids (S8.3 nucleus model identity). Present on
   * device atoms (GPU / runtime) from the PROVEN runtime model residency
   * (OR-ATOM-009 S9.1/W2 — canonicalized, deduped, ≤3); absent on hub/provider
   * atoms, where the snapshot still exposes no per-node model ids → the
   * nucleus renders the honest neutral two-tone.
   */
  observedModelIds?: string[];
  /** World-space position (from {@link computeAtomicLayout}; hub = origin). */
  position: { x: number; y: number; z: number };
  /**
   * Base atom color. For provider atoms: the first observed in-flight model
   * color (honest identity), or neutral slate when no models are observed.
   * For hub/gpu: neutral slate. Never a provider-hash guess.
   */
  color: string;
  /**
   * Observed in-flight model colors (≤3). Each entry is `modelColor(modelId)`
   * for a distinct model actually seen in-flight. Empty when no models are
   * observed — the scene renders only the neutral base in that case.
   * This is the ground truth for the layered nucleus (item 5).
   */
  modelColors: string[];
  /** Resolved job lane (M1 has no per-node lane → `"unknown"`). */
  lane: JobLane;
  /** Lane hue (used by overlays: legend, labels, tooltip). */
  laneHue: string;
  /** Spin speed + provenance (from `spinRadiansPerSecond`). */
  spin: SpinResult;
  /** Queue vibration + provenance (from `queueVibration`; "unavailable" in M1). */
  vibration: VibrationResult;
  /**
   * Raw measured output throughput (tokens/sec) backing {@link spin}
   * (OR-ATOM-009 / S9.2 — nucleus rotation binding): the fresh measured TPS
   * this atom spins from, or `null` when nothing fresh is attributable
   * (stale / missing / unattached / no reconciliation). The nucleus cluster
   * smooths this per frame (`nucleusMotion.ts` `createRotationSmoothing`) —
   * a fresh sample adopts instantly, subsequent samples ease in, and
   * `null` decays the smoothed rate toward 0, so the nucleus spins down
   * smoothly instead of holding a fake speed. The smoothing runs in the
   * scene (per-frame), so this descriptor stays pure + deterministic.
   * `spin` keeps its value/mode contract for the electron cloud, the
   * tooltip and the breathing gate — those are unchanged by S9.2.
   */
  measuredTps: number | null;
  /** Composed health/traffic state + stroke style (from `resolveVisualState`). */
  visualState: {
    state: AtomicVisualState;
    style: { width: number; opacity: number; animated: boolean };
  };
  /** In-flight request count, or `null` when absent (never `0`). */
  activeRequests: number | null;
  /** 0-based ring index; the hub is `-1` (the nucleus, not on a ring). */
  ringIndex: number;
  /**
   * Proven device facts (OR-ATOM-005 — T5.4), present ONLY on device atoms
   * (`kind: "gpu" | "runtime"`). Every field is a real measured value; `null`
   * means "not observed" (the overlay says "no data", it never shows `0`).
   */
  deviceFacts?: {
    /** `"gpu"` or `"runtime"` — the device atom kind. */
    kind: "gpu" | "runtime";
    utilizationPercent?: number | null;
    vramUsedBytes?: number | null;
    vramTotalBytes?: number | null;
    temperatureC?: number | null;
    powerWatts?: number | null;
    /** Scheduler pending queue depth (NOT the OmniRoute rate-limit queue). */
    queuedJobs?: number | null;
    activeJobs?: number | null;
    /**
     * Served model id. Runtime atoms: their own observed model. GPU atoms
     * (OR-ATOM-009 S9.1/W2): the first proven on-GPU runtime model (union of
     * the runtimes proven on the GPU via `runtime_device` edges). `null` when
     * no model is proven — never a guess.
     */
    modelId?: string | null;
  };
  /**
   * Fleet-telemetry sample anchor (OR-ATOM-005 — T5.4): the reconciliation's
   * `capturedAt`, shown by the tooltip's "Fleet sample" row. Present on every
   * descriptor when a reconciliation is in the snapshot (device + provider
   * atoms); absent without one.
   */
  fleetSampledAt?: number | null;
}

/**
 * The visual parameters for a single link, derived purely from the snapshot.
 * The 3D scene uses these to style each hub→provider route edge.
 */
export interface LinkVisualDescriptor {
  /** Canonical link id (`route:<providerId>`). */
  id: string;
  /** Source atom id (the hub). */
  source: string;
  /** Target atom id (the provider). */
  target: string;
  /** Resolved lane of the link (M1 → `"unknown"`). */
  lane: JobLane;
  /** Lane hue for the edge color. */
  laneHue: string;
  /**
   * Proven pulse gate (OR-ATOM-009 S9.4): whether this link may carry bounded
   * pulses. A route link is proven when its target provider atom is present
   * in the snapshot's node set (call-log / active-request route evidence).
   * The scene's packet layer rides only proven links; the thin filament,
   * completion impulse and failure discharge are unaffected (event-level,
   * never suppressed). See `scene/provenPulse.ts` for the provenance rule.
   */
  proven: boolean;
  /**
   * Provenance basis for {@link proven} (shown by the dev diagnostics panel,
   * OR-ATOM-009 S9.5): the call-log route basis, optionally corroborated by
   * a fleet-telemetry provider sample; "unproven (no target provider atom)"
   * when the target atom is absent.
   */
  provenBasis: string;
  /** Composed health/traffic state + stroke style. */
  visualState: {
    state: AtomicVisualState;
    style: { width: number; opacity: number; animated: boolean };
  };
}

/** Neutral slate for atoms with no recognizable color key (hub / unknown). */
export const UNKNOWN_ATOM_COLOR = "#64748B";

/** Output TPS that maps to the maximum spin speed (see `spinRadiansPerSecond`). */
export const SPIN_REFERENCE_TPS = 24;

/**
 * Resolve the *full* set of atom descriptors for a snapshot, joining each node
 * to its deterministic layout position.
 *
 * Pure: same snapshot + same options → same descriptors; no clock, no DOM, no
 * WebGL. The hub is always present (nucleus at the origin); provider atoms are
 * placed by {@link computeAtomicLayout}, and — when the snapshot carries a
 * fleet-telemetry reconciliation (OR-ATOM-005, T5.4) — proven GPU /
 * inference-runtime device atoms are placed in the OUTER device band by
 * {@link computeDeviceBandLayout} (rings beyond the provider rings, so no
 * provider atom moves). Provider spin/vibration are then bound to the
 * *measured* fleet values (`ReconciliationResult.providerNodes`) instead of
 * the honest M1 "unavailable" baseline; without a reconciliation the
 * descriptors are byte-identical to the pre-telemetry behavior.
 */
export function resolveAtomDescriptors(
  snapshot: TopologySceneSnapshot,
  options?: { radiusScale?: number }
): AtomVisualDescriptor[] {
  const layoutNodes: AtomicLayoutNode[] = snapshot.nodes.map((n) => ({ id: n.id, kind: n.kind }));
  const layout = computeAtomicLayout(layoutNodes, { radiusScale: options?.radiusScale });

  const placementById = new Map<
    string,
    { position: { x: number; y: number; z: number }; ringIndex: number }
  >();
  for (const p of layout.placements) {
    placementById.set(p.id, { position: p.position, ringIndex: p.ringIndex });
  }

  // Fleet-telemetry reconciliation join (OR-ATOM-005 — T5.4). When the
  // snapshot carries one, provider atoms bind their spin/vibration to the
  // *measured* fleet values and proven device atoms are appended in the outer
  // band. Without a reconciliation every descriptor is byte-identical to the
  // pre-telemetry M1 baseline (honest "unavailable" spin/vibration).
  const reconciliation = snapshot.fleetTelemetry ?? null;
  const providerJoin = new Map<string, ReconciledProviderNode>();
  if (reconciliation) {
    for (const pn of reconciliation.providerNodes) providerJoin.set(pn.providerId, pn);
  }

  const descriptors: AtomVisualDescriptor[] = snapshot.nodes.map((node) => {
    const isHub = node.id === "hub";
    const placement = placementById.get(node.id);
    const position = isHub
      ? { x: 0, y: 0, z: 0 }
      : placement
        ? placement.position
        : { x: 0, y: 0, z: 0 };
    const ringIndex = isHub ? -1 : placement ? placement.ringIndex : 0;

    // Lane comes from the shared domain when the snapshot carries one
    // (derived from in-flight model ids — see `domain/lane.ts`); fall back
    // to the honest "unknown" when there is no observation (idle providers,
    // unrecognizable model ids, hub). The "unknown" here is a *coloring
    // default*, never a fabricated lane fact.
    // `asJobLane` pins the domain→JobLane subsumption as a compile-time check
    // (see `visualEncoding.ts`): if `TopologyLane` ever grows a value the
    // palette doesn't know, this assignment stops compiling rather than
    // silently rendering an unmapped lane.
    const lane: JobLane = isHub ? "unknown" : asJobLane(node.lane?.value ?? "unknown");

    // Honest model-color composition (OR-ATOM-002 item 4): colors come ONLY
    // from observed in-flight model ids — never from a provider-hash guess.
    // At most 3 distinct model colors are rendered; the remainder is neutral.
    const inFlightModelIds = node.inFlightModels?.value;
    const modelColors =
      inFlightModelIds && inFlightModelIds.length > 0
        ? inFlightModelIds.slice(0, 3).map((m) => modelColor(m))
        : [];
    const color = modelColors.length > 0 ? modelColors[0] : UNKNOWN_ATOM_COLOR;

    // Spin + queue vibration (OR-ATOM-002 item 2 baseline, OR-ATOM-005 T5.4
    // binding): WITHOUT a reconciliation the snapshot carries only a request
    // *count*, not a tokens-per-second measurement — feeding a count into
    // `spinRadiansPerSecond` would fabricate TPS, so the honest encoding is
    // `unavailable`. WITH a reconciliation, the *measured* provider values
    // (and the measured scheduler pending-queue depth) are bound instead.
    // A stale `Observed` (upstream decayed it to `null`) or an absent fact
    // stays "unavailable" — never fabricated as 0.
    const joinedProvider =
      !isHub && node.providerId ? providerJoin.get(node.providerId) : undefined;
    const joinedTps =
      joinedProvider && !joinedProvider.stale && joinedProvider.outputTokensPerSecond?.value != null
        ? joinedProvider.outputTokensPerSecond.value
        : null;
    const joinedQueued =
      joinedProvider && !joinedProvider.stale && joinedProvider.queuedJobs?.value != null
        ? joinedProvider.queuedJobs.value
        : null;
    const spin = spinRadiansPerSecond(reconciliation ? joinedTps : null, SPIN_REFERENCE_TPS);
    const vibration = queueVibration(reconciliation ? joinedQueued : null);
    const visualState = resolveVisualState({
      health: node.health,
      traffic: node.traffic,
      latestErrorAt: node.latestErrorAt ?? null,
    });

    return {
      id: node.id,
      kind: node.kind,
      label: node.label,
      providerId: node.providerId,
      position,
      color,
      lane,
      laneHue: laneHue(lane),
      spin,
      vibration,
      // S9.2 — the raw measured TPS behind `spin` (null when no reconciliation
      // or the joined sample is stale/absent): the nucleus smooths exactly
      // this value per frame; the hub (no providerId) stays null.
      measuredTps: reconciliation ? joinedTps : null,
      visualState,
      activeRequests: node.activeRequests?.value ?? null,
      ringIndex,
      modelColors,
      fleetSampledAt: reconciliation ? reconciliation.capturedAt : null,
    } satisfies AtomVisualDescriptor;
  });

  // Proven device atoms (OR-ATOM-005 — T5.4). Placed ONLY in the outer device
  // band (rings beyond the provider rings) by `computeDeviceBandLayout`, so
  // no provider atom moves. Deterministic: keyed to the canonical id set,
  // de-duplicated, hash-sorted — never to array order.
  if (reconciliation) {
    const maxProviderRing = layout.placements.reduce((max, p) => Math.max(max, p.ringIndex), 0);
    const bandNodes: Array<{ id: string; kind: "gpu" | "runtime" }> = [
      ...reconciliation.gpuNodes.map((g) => ({ id: g.resourceId, kind: "gpu" as const })),
      ...reconciliation.runtimeNodes.map((r) => ({
        id: r.resourceId,
        kind: "runtime" as const,
      })),
    ];
    const band = computeDeviceBandLayout(bandNodes, { startRingIndex: maxProviderRing + 1 });
    const gpuById = new Map(reconciliation.gpuNodes.map((g) => [g.resourceId, g]));
    const runtimeById = new Map(reconciliation.runtimeNodes.map((r) => [r.resourceId, r]));
    const providerById = new Map(reconciliation.providerNodes.map((p) => [p.resourceId, p]));

    // Proven-relationship indexes, built ONLY from `reconciliation.edges`
    // (never from display labels / name joins — S9.1 provenance rule).
    //   runtime_device    : runtime canonical id -> [runtime nodes on that GPU]
    //   provider_runtime  : runtime canonical id -> [proven provider nodes]
    // A runtime's own observed model comes from its reconciled `modelId` (the
    // reconciler sets it only from a proven sample), so no separate runtime→model
    // index is needed — a GPU's models are the union of its attributed runtimes'.
    const runtimesByGpu = new Map<string, ReconciledRuntimeNode[]>();
    const providersByRuntime = new Map<string, ReconciledProviderNode[]>();
    for (const edge of reconciliation.edges) {
      if (edge.relation === "runtime_device") {
        const rt = runtimeById.get(edge.source);
        if (rt) {
          const list = runtimesByGpu.get(edge.target);
          if (list) list.push(rt);
          else runtimesByGpu.set(edge.target, [rt]);
        }
      } else if (edge.relation === "provider_runtime") {
        const provider = providerById.get(edge.source);
        if (provider) {
          const list = providersByRuntime.get(edge.target);
          if (list) list.push(provider);
          else providersByRuntime.set(edge.target, [provider]);
        }
      }
    }

    for (const placement of band.placements) {
      const gpu = placement.kind === "gpu" ? gpuById.get(placement.id) : undefined;
      const runtime = placement.kind === "runtime" ? runtimeById.get(placement.id) : undefined;
      const isGpu = placement.kind === "gpu";
      // A stale reconciliation node (upstream decayed its values) must read as
      // "unavailable", never animate from decayed/absent facts (T5.4 honesty).
      const deviceStale = Boolean(gpu?.stale ?? runtime?.stale);
      const obsValue = (o: { value: number | null } | null | undefined): number | null =>
        !deviceStale && o && o.value != null ? o.value : null;

      // Proven attribution for THIS atom (S9.1): a GPU's work comes ONLY from
      // the runtimes proven to run on it (runtime_device edges); a runtime's is
      // itself. One-to-many / many-to-many preserved — never an even split.
      const attributedRuntimes: ReconciledRuntimeNode[] = isGpu
        ? (runtimesByGpu.get(placement.id) ?? [])
        : runtime
          ? [runtime]
          : [];
      const singleRuntime = attributedRuntimes.length === 1 ? attributedRuntimes[0] : undefined;
      // Facts ATTRIBUTED from the single proven on-GPU runtime must also
      // respect that runtime's own staleness — the same rule as the
      // spin/vibration attribution above (S9.1: a decayed value is never
      // shown on the GPU).
      const attributedValue = (
        o: { value: number | null; stale?: boolean } | null | undefined
      ): number | null =>
        !deviceStale && !singleRuntime?.stale && o && o.value != null ? o.value : null;

      // Observed model ids — ONLY from proven runtime→(gpu) residency (S9.3).
      // Canonicalized (trim + lowercase), deduped, capped at 3 so the descriptor's
      // nucleus colors match `resolveModelGroups` (MAX_MODEL_GROUPS = 3).
      const modelSet = new Set<string>();
      for (const rt of attributedRuntimes) {
        // A stale runtime's residency is decayed — attribute nothing from it
        // (S9.1: stale → unavailable, never shown on the device it once ran on).
        if (rt.modelId && !rt.stale) modelSet.add(rt.modelId.trim().toLowerCase());
      }
      const observedModelIds = [...modelSet]
        .filter((id) => id.length > 0)
        .sort()
        .slice(0, 3);
      const modelColors = observedModelIds.map((id) => modelColor(id));
      // Lane from the observed model ids via the tested domain classifier
      // (S9.4): a single recognizable lane -> that lane; mixed -> observed
      // "unknown"; none observed / none recognizable -> coloring "unknown".
      const laneResult =
        observedModelIds.length > 0 ? deriveLaneForProvider(observedModelIds) : null;
      const lane: JobLane = laneResult ? asJobLane(laneResult.lane) : "unknown";

      // Spin (S9.2): per-device attribution only. A GPU spins from its OWN
      // measured TPS, or — when exactly one runtime is proven on it — from that
      // runtime's measured TPS (unambiguous single-GPU attribution). A runtime
      // spins from its own measured TPS. Never split an aggregate across GPUs.
      let spinTps: number | null = null;
      if (isGpu) {
        const own = gpu?.outputTokensPerSecond;
        if (own && own.value != null && !own.stale) spinTps = own.value;
        else if (singleRuntime && !singleRuntime.stale) {
          const t = singleRuntime.outputTokensPerSecond;
          if (t && t.value != null && !t.stale) spinTps = t.value;
        }
      } else {
        const t = runtime?.outputTokensPerSecond;
        if (t && t.value != null) spinTps = t.value;
      }
      const spin = spinRadiansPerSecond(deviceStale ? null : spinTps, SPIN_REFERENCE_TPS);

      // Queue vibration (S9.3): a GPU vibrates only when a single runtime's
      // scheduler queue is safely attributed to it (no double counting); a
      // runtime vibrates from its own queue.
      let vibQueue: number | null = null;
      if (isGpu) {
        const q = singleRuntime?.queuedJobs;
        if (q && q.value != null && !q.stale && !singleRuntime.stale) vibQueue = q.value;
      } else {
        const q = runtime?.queuedJobs;
        if (q && q.value != null) vibQueue = q.value;
      }
      const vibration = queueVibration(deviceStale ? null : vibQueue);

      // Proven provider linkage (S9.1): a runtime carries its proven
      // provider_runtime edge; a GPU stays provider-unattached (its link to a
      // provider is only transitive through its runtime — never drawn directly).
      const providerId = isGpu
        ? undefined
        : (providersByRuntime.get(placement.id)?.[0]?.providerId ?? undefined);

      descriptors.push({
        id: placement.id,
        kind: placement.kind,
        label: placement.id,
        providerId,
        observedModelIds,
        position: placement.position,
        color: modelColors.length > 0 ? modelColors[0] : UNKNOWN_ATOM_COLOR,
        modelColors,
        lane,
        laneHue: laneHue(lane),
        spin,
        vibration,
        // S9.2 — the raw measured TPS behind `spin`, stale-gated exactly like
        // the spin itself (a decayed sample spins the nucleus down, never
        // holds a fake speed; multi-runtime GPUs carry null — no split).
        measuredTps: deviceStale ? null : spinTps,
        // Device atoms are telemetry evidence, not route traffic: no route
        // link connects them, so they render as idle/unknown (neutral).
        visualState: resolveVisualState({ health: "unknown", traffic: "idle" }),
        activeRequests: null,
        ringIndex: placement.ringIndex,
        deviceFacts: {
          kind: placement.kind,
          utilizationPercent: obsValue(gpu?.utilizationPercent),
          vramUsedBytes: obsValue(gpu?.vramUsedBytes),
          vramTotalBytes: obsValue(gpu?.vramTotalBytes),
          temperatureC: obsValue(gpu?.temperatureC),
          powerWatts: obsValue(gpu?.powerWatts),
          queuedJobs: isGpu
            ? singleRuntime
              ? attributedValue(singleRuntime.queuedJobs)
              : null
            : obsValue(runtime?.queuedJobs),
          activeJobs: isGpu
            ? singleRuntime
              ? attributedValue(singleRuntime.activeJobs)
              : null
            : obsValue(runtime?.activeJobs),
          modelId: isGpu
            ? (observedModelIds[0] ?? null)
            : deviceStale
              ? null
              : (runtime?.modelId ?? null),
        },
        fleetSampledAt: reconciliation.capturedAt,
      });
    }
  }

  return descriptors;
}

/**
 * Resolve the visual parameters for every link in a snapshot.
 * Pure (no DOM / WebGL); the 3D scene styles each route edge from these.
 */
export function resolveLinkDescriptors(snapshot: TopologySceneSnapshot): LinkVisualDescriptor[] {
  // Map node id → observed lane so a link can inherit its target atom's lane.
  // The `Observed` wrapper may be present with a `null` value (unrecognizable
  // lane), so check the value itself, not just the wrapper's presence.
  const nodeLaneById = new Map<string, TopologyLane | null>();
  for (const n of snapshot.nodes) {
    if (n.lane && n.lane.value != null) nodeLaneById.set(n.id, n.lane.value);
  }
  // Proven pulse gate (OR-ATOM-009 S9.4): which links may carry pulses, from
  // the snapshot's OWN evidence (the target provider atom; fleet-telemetry
  // corroboration strengthens the basis only). Pure — see `scene/provenPulse`.
  const { provenLinkIds, basisById } = computeProvenRouteLinks(snapshot);
  return snapshot.links.map((link) => {
    // Honest lane (OR-ATOM-002 item 3): join the target node's observed lane
    // when present; fall back to explicit "unknown" when absent.
    const targetLane = nodeLaneById.get(link.target);
    const lane: JobLane = targetLane ? asJobLane(targetLane) : "unknown";
    const visualState = resolveVisualState({ health: link.health, traffic: link.traffic });
    return {
      id: link.id,
      source: link.source,
      target: link.target,
      lane,
      laneHue: laneHue(lane),
      proven: provenLinkIds.has(link.id),
      provenBasis: basisById.get(link.id) ?? "unproven",
      visualState,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Client-only scene host                                              */
/* ------------------------------------------------------------------ */

/**
 * The shape of the dynamically-loaded 3D scene module. `AtomicScene` is the
 * R3F `<Canvas>` composition. Loading it via `import()` keeps `three`/R3F out
 * of the static module graph (see module doc).
 */
interface AtomicSceneModule {
  AtomicScene: (props: AtomicSceneProps) => ReactElement | null;
}

/** Props the 3D scene receives (the pure descriptors + runtime state). */
export interface AtomicSceneProps {
  descriptors: AtomVisualDescriptor[];
  linkDescriptors: LinkVisualDescriptor[];
  paused: boolean;
  focusNodeId: string | null;
  emptyStateLabel?: string;
  /**
   * The host-owned ambient scene state (event pool, focus, reduced motion,
   * quality, camera framing). Carried into the scene via the
   * `AtomicSceneContext` provider.
   */
  sceneContext: AtomicSceneContextValue;
}

/** Props for the client-only scene host component. */
export interface AtomicTopologyRendererProps {
  /** The current snapshot (host-driven via `update`). */
  snapshot: TopologySceneSnapshot;
  /** Container size in CSS pixels (host-driven via `resize`). */
  size: { width: number; height: number };
  /** Whether continuous animation is paused (host-driven via `setPaused`). */
  paused: boolean;
  /**
   * Monotonic reset token (OR-ATOM-003, V7): bumped on each "reset view"
   * request so the scene's `CameraRig` re-applies the base fit. `0` until the
   * first reset. Carried into the scene via {@link AtomicSceneContextValue}.
   */
  resetToken: number;
  /** The atom id the view should center on (host-driven via `focusNode`). */
  focusNodeId: string | null;
  /**
   * The bounded request-lifecycle event pool owned by the imperative instance
   * (stable across renders). Absent on the steady-state-only path — the scene
   * primitives treat it as "no discharge".
   */
  eventPool?: AtomicEventPool;
  /** Renderer options (empty-state label + delegated provider click). */
  options: TopologyRendererOptions;
  /**
   * Let the DOM overlay (labels) request a focus change from inside the React
   * tree. Wired by the imperative instance to update its own focus state.
   */
  onFocusRequest?: (nodeId: string) => void;
}

/**
 * A minimal WebGL2 probe for the *render* path: attempts to create a real
 * context on a detached canvas. The `mount` gate (via `detectTopologyCapabilities`)
 * is the primary line of defense; this render-time probe is a second one, so
 * that if the context turns out to be unusable we render the empty state
 * rather than throwing out of an R3F `<Canvas>`.
 */
function canCreateWebGL2AtRender(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2");
    return context != null;
  } catch {
    return false;
  }
}

/**
 * The client-only scene host. It:
 * - dynamically imports the 3D scene module (client-only) and renders it when
 *   a real WebGL2 context is available, otherwise renders the empty state; and
 * - hosts the DOM overlay layer (controls / legend / labels / tooltip) over
 *   the canvas.
 *
 * Pure with respect to props: the imperative instance
 * ({@link createAtomicTopologyInstance}) re-renders it with new props on each
 * `update` / `resize` / `setPaused` / `focusNode`.
 */
export function AtomicTopologyRenderer({
  snapshot,
  paused,
  resetToken,
  focusNodeId,
  options,
  onFocusRequest,
  eventPool,
  size,
}: AtomicTopologyRendererProps) {
  const [sceneModule, setSceneModule] = useState<AtomicSceneModule | null>(null);

  // Load the 3D scene module on the client only.
  useEffect(() => {
    let alive = true;
    import("./scene/AtomicScene")
      .then((m) => {
        if (alive) setSceneModule(m as unknown as AtomicSceneModule);
      })
      .catch(() => {
        if (alive) setSceneModule(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Recompute the pure descriptors whenever the snapshot changes.
  const descriptors = resolveAtomDescriptors(snapshot);
  const linkDescriptors = resolveLinkDescriptors(snapshot);

  // The tooltip tracks the focused atom (the only in-scope hover proxy —
  // 3D picking is an explicit unknown).
  const focusedDescriptor = focusNodeId
    ? (descriptors.find((d) => d.id === focusNodeId) ?? null)
    : null;

  // Environment signals are stable for the lifetime of this host, so probe
  // them once (the WebGL2 probe creates a real context — not free to repeat on
  // every render).
  const { reducedMotion, quality } = useMemo(() => {
    const caps = detectTopologyCapabilities();
    const probe: QualityProbe = {
      webgl2: caps.webgl2,
      devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : undefined,
      hardwareConcurrency:
        typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined,
      deviceMemoryGiB:
        typeof navigator !== "undefined"
          ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
          : undefined,
    };
    return {
      reducedMotion: caps.reducedMotion,
      quality: resolveSceneQuality(probe),
    };
  }, []);

  // The stable per-frame camera snapshot the DOM label overlay reads
  // (UX correction — projected labels). Created once; the scene writes to it
  // every frame and the overlay reads it via requestAnimationFrame. A single
  // mutable object shared between the R3F tree (writers) and the DOM overlay
  // (reader) — kept outside React state so per-frame writes never re-render.
  const [cameraState] = useState(() => createAtomicCameraState());

  // Responsive framing (UX correction): fit the *actual* layout bounds, not
  // the constant `DEFAULT_FIT_RADIUS`. The hub is the origin, so only the ring
  // atoms contribute; the margin covers the atom radius + electron cloud.
  // When device atoms are present (OR-ATOM-005 — T5.4), they live in the OUTER
  // band, beyond the provider rings — the provider-only fit cap would clip
  // them, so the upper clamp is raised to contain the farthest device atom.
  // No device atoms → `undefined` cap → byte-identical to the M1 framing.
  const deviceAtoms = descriptors.filter((d) => d.kind === "gpu" || d.kind === "runtime");
  let deviceBandCap = undefined as number | undefined;
  if (deviceAtoms.length > 0) {
    let maxDeviceNorm = 0;
    for (const d of deviceAtoms) {
      const norm = Math.hypot(d.position.x, d.position.y, d.position.z);
      if (norm > maxDeviceNorm) maxDeviceNorm = norm;
    }
    deviceBandCap = maxDeviceNorm + ATOM_FIT_MARGIN;
  }
  const ringPositions = descriptors.filter((d) => d.kind !== "hub");
  const fitRadius = computeFitRadiusFromPositions(
    ringPositions.map((d) => d.position),
    ATOM_FIT_MARGIN,
    deviceBandCap
  );

  // The live viewport aspect drives the fit: a wide, short canvas needs a
  // different framing than a tall one. Before the first measured size both
  // dimensions are 0 → fall back to the square default (aspect 1).
  const cameraAspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1;

  // The host-owned ambient scene state (M4/M6): the instance's stable event
  // pool, the focused atom's world position, and the shared camera framing.
  // Carried into the scene via the `AtomicSceneContext` provider.
  const sceneContext: AtomicSceneContextValue = {
    pool: eventPool ?? null,
    focusTarget: focusedDescriptor ? focusedDescriptor.position : null,
    reducedMotion,
    quality,
    cameraFovDeg: 50,
    cameraAspect,
    // Deterministic discharge clock for render-time (reduced-motion) reads:
    // the snapshot's own capture time, so renders never touch the wall clock.
    nowMs: Number.isFinite(snapshot.capturedAt) ? snapshot.capturedAt : 0,
    cameraState,
    fitRadius,
    resetToken,
  };

  // Feed-freshness state for the telemetry badge (M6): `unavailable` when the
  // snapshot has no usable `capturedAt`, `stale` when the feed was older than
  // the freshness window *when it arrived*, `available` otherwise. The
  // freshness is measured once per snapshot, and measured *asynchronously*
  // (deferred in an effect) — `Date.now()` during render is impure, and a
  // synchronous `setState` inside an effect is a cascading-render risk, so
  // the measurement runs one tick after the snapshot lands. A snapshot does
  // not age in place, so the badge reflects the feed state at the moment it
  // became observable.
  // T5.4: prefer the fleet-telemetry sample's `capturedAt` over the snapshot's
  // own — the badge should reflect the freshness of the *measured* feed that
  // powers the spin/vibration binding, not the (possibly stale) snapshot feed.
  const capturedAt = snapshot.fleetTelemetry?.capturedAt ?? snapshot.capturedAt;
  const [telemetryState, setTelemetryState] = useState<AtomicTelemetryState>("unavailable");
  useEffect(() => {
    const id = setTimeout(() => {
      if (capturedAt != null && Number.isFinite(capturedAt)) {
        const ageMs = Date.now() - capturedAt;
        setTelemetryState(ageMs > TELEMETRY_FRESH_WINDOW_MS ? "stale" : "available");
      } else {
        setTelemetryState("unavailable");
      }
    }, 0);
    return () => clearTimeout(id);
  }, [capturedAt]);

  const handleProviderClick = useCallback(
    (providerId: string) => {
      options.onProviderClick?.(providerId);
    },
    [options]
  );

  return (
    <div
      className="atomic-scene-host"
      style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}
      data-atomic-host="true"
      aria-label="Atomic topology scene"
    >
      {/* 3D canvas layer (client-only, WebGL-gated) */}
      <div className="atomic-scene-canvas" style={{ position: "absolute", inset: 0 }}>
        {sceneModule && descriptors.length > 1 && canCreateWebGL2AtRender() ? (
          <sceneModule.AtomicScene
            descriptors={descriptors}
            linkDescriptors={linkDescriptors}
            paused={paused}
            focusNodeId={focusNodeId}
            emptyStateLabel={options.emptyStateLabel}
            sceneContext={sceneContext}
          />
        ) : (
          <div
            className="atomic-scene-empty"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#64748B",
              fontSize: 12,
            }}
            data-atomic-empty="true"
          >
            {options.emptyStateLabel ?? "No topology to render"}
          </div>
        )}
      </div>

      {/* DOM overlay layer (pure React + CSS, no three) */}
      <div
        className="atomic-overlays"
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <AtomicTelemetryStatus state={telemetryState} capturedAt={capturedAt} />
        <AtomicLegend descriptors={descriptors} />
        <AtomicControls paused={paused} />
        <AtomicLabels
          descriptors={descriptors}
          focusNodeId={focusNodeId}
          onProviderClick={handleProviderClick}
          onFocusRequest={onFocusRequest}
          cameraState={cameraState}
        />
        <AtomicTooltip descriptor={focusedDescriptor} capturedAt={capturedAt} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Imperative lifecycle adapter (the safe host contract)               */
/* ------------------------------------------------------------------ */

/**
 * The imperative state held by a mounted instance. Everything the host drives
 * (`snapshot` / `size` / `paused` / `focusNodeId`) lives here; `update` /
 * `resize` / `setPaused` / `focusNode` mutate it and push a re-render through
 * the React root.
 */
interface AtomicInstanceState {
  snapshot: TopologySceneSnapshot;
  size: { width: number; height: number };
  paused: boolean;
  focusNodeId: string | null;
  options: TopologyRendererOptions;
  /** Monotonic "reset view" token (OR-ATOM-003, V7) — bumped on reset requests. */
  resetToken: number;
}

/**
 * Create a safe, idempotent renderer instance that owns a client-only scene
 * host inside `container`.
 *
 * Lifecycle guarantees:
 * - `update(snapshot)` re-renders the host with the new snapshot; idempotent
 *   for the same snapshot (the host is a pure function of props).
 * - `resize(w, h)` records the container size and re-renders (the R3F canvas
 *   self-sizes via its own ResizeObserver, so this is a cheap no-op for the
 *   3D layer).
 * - `setPaused(p)` toggles animation (the electron clouds stop spinning).
 * - `focusNode(id)` centers the view on a canonical atom id (a no-op for
 *   unknown ids — a foreign id never crashes the renderer).
 * - `dispose()` removes the host element and unmounts the React root exactly
 *   once; every method is a no-op after `dispose()`.
 *
 * @param container the plain container element to mount into (host-owned).
 * @param initial   the first snapshot to render.
 * @param options   renderer options (empty-state label + provider click).
 * @returns the controlling {@link TopologyRendererInstance}.
 */
export function createAtomicTopologyInstance(
  container: HTMLElement,
  initial: TopologySceneSnapshot,
  options: TopologyRendererOptions
): TopologyRendererInstance {
  // The renderer owns its own host element (a client-only scene host).
  const host = document.createElement("div");
  host.className = "atomic-topology-host";
  host.style.width = "100%";
  host.style.height = "100%";
  host.style.position = "relative";
  host.style.overflow = "hidden";
  container.appendChild(host);

  const root: Root = createRoot(host);

  const state: AtomicInstanceState = {
    snapshot: initial,
    size: { width: container.clientWidth || 0, height: container.clientHeight || 0 },
    paused: false,
    focusNodeId: null,
    options,
    resetToken: 0,
  };

  let disposed = false;

  // Delegated overlay controls (OR-ATOM-003, V7): the pause chip and the
  // reset-view button in `overlays/AtomicControls.tsx` are presentational —
  // they dispatch `window` CustomEvents, and this instance (the single owner
  // of the animation state) is the listener. Wiring them here — rather than in
  // the host panel — keeps the controls authoritative for every mount path and
  // lets a bare renderer instance respond to the same chips. Both listeners
  // are removed in `dispose()` so a destroyed instance never lingers on the
  // `window` event bus.
  const onTogglePause = (event: Event): void => {
    if (disposed) return;
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as { pause?: unknown }).pause
        : !state.paused;
    state.paused = detail === true;
    render();
  };
  const onResetView = (): void => {
    if (disposed) return;
    // Monotonic: the scene's `CameraRig` re-applies the base fit when this
    // changes, even while an atom is focused (reset frames the whole scene).
    state.resetToken += 1;
    render();
  };
  window.addEventListener("atomic:toggle-pause", onTogglePause);
  window.addEventListener("atomic:reset-view", onResetView);

  // The renderer owns the bounded request-lifecycle event pool (M4): a stable
  // ref handed to the host, populated from each snapshot's `lifecycle` stream
  // on `update`, and cleared on `dispose`. The scene reads it per-frame
  // (inside `useFrame`) for transient discharges — never React state.
  const pool = createAtomicEventPool();

  // Proven pulse gate (OR-ATOM-009 S9.4): a fresh gate per ingest (event-rate
  // surface — the per-frame packet loop reads `descriptor.proven`, NOT the
  // gate). Lifecycle events may enter the pool only along a PROVEN link,
  // deduped within the gate's window and capped at the concurrent-pulse budget.
  // The gate carries the admission history (dedupe window + per-link
  // concurrent cap) — building one per snapshot would reset that state on
  // every lifecycle event and every dev trigger, so the 150 ms dedupe window
  // could never fire (two identical pulses both "admitted"). Cache the gate
  // and rebuild ONLY when the proven-link set actually changes.
  let cachedGate: ProvenPulseGate | null = null;
  let cachedGateKey = "";
  const pulseGate = (snapshot: TopologySceneSnapshot): ProvenPulseGate => {
    const proven = computeProvenRouteLinks(snapshot).provenLinkIds;
    const key = Array.from(proven).sort().join("\u0000");
    if (!cachedGate || cachedGateKey !== key) {
      cachedGate = createProvenPulseGate(proven);
      cachedGateKey = key;
    }
    return cachedGate;
  };

  const ingestSnapshot = (snapshot: TopologySceneSnapshot): void => {
    if (disposed) return;
    const nowMs = Date.now();
    const events = mapLifecycleToAtomicEvents(snapshot);
    for (const e of admitPulseEvents(events, pulseGate(snapshot), nowMs)) pool.ingest(e, nowMs);
  };

  // Dev/test-only trigger (OR-ATOM-009 S9.4 / S9.5): `window.__atomicPulse`
  // injects ONE deterministic pulse onto a proven route link through the SAME
  // proven gate + pool path — never fabricating telemetry into real data.
  // Defined only outside production; `dispose` removes it. The trigger function
  // is kept at instance scope so `dispose()` can delete ONLY this instance's
  // trigger from the shared `window` surface — a deferred StrictMode cleanup
  // from an earlier mount must never clobber a newer instance's trigger.
  let pulseTrigger:
    | ((
        providerId: string,
        kind?: AtomicEventKind
      ) => { ok: boolean; reason: string; linkId?: string })
    | null = null;
  if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
    pulseTrigger = (providerId: string, kind?: AtomicEventKind) => {
      if (disposed || typeof providerId !== "string" || providerId.length === 0) {
        return { ok: false, reason: "bad-input" as const };
      }
      const eventKind: AtomicEventKind = kind ?? "request-started"; // default: the "active" discharge
      const linkId = canonicalRouteLinkId(providerId);
      const admission = pulseGate(state.snapshot).admit(linkId, Date.now());
      if (admission.ok) {
        pool.ingest(
          {
            id: `devpulse:${eventKind}:${providerId}:${Date.now()}`,
            at: Date.now(),
            kind: eventKind,
            providerId,
            resourceId: `devpulse:${providerId}`,
            linkId,
          },
          Date.now()
        );
      }
      return { ok: admission.ok, reason: admission.reason, linkId };
    };
    window.__atomicPulse = pulseTrigger;
  }

  const render = (): void => {
    if (disposed) return;
    // `root.render` is a batched, idempotent React commit — calling it with the
    // same props is a no-op re-render, so every imperative method below is
    // safe to repeat.
    root.render(
      <AtomicTopologyRenderer
        snapshot={state.snapshot}
        size={state.size}
        paused={state.paused}
        resetToken={state.resetToken}
        focusNodeId={state.focusNodeId}
        options={state.options}
        eventPool={pool}
        onFocusRequest={(nodeId: string) => {
          if (disposed) return;
          state.focusNodeId = nodeId;
          render();
        }}
      />
    );
  };

  // Ingest the initial snapshot's lifecycle stream, then render it.
  ingestSnapshot(initial);
  render();

  return {
    update(snapshot: TopologySceneSnapshot): void {
      if (disposed) return;
      state.snapshot = snapshot;
      ingestSnapshot(snapshot);
      render();
    },
    resize(width: number, height: number): void {
      if (disposed) return;
      state.size = { width, height };
      render();
    },
    setPaused(paused: boolean): void {
      if (disposed) return;
      state.paused = paused;
      render();
    },
    focusNode(nodeId: string): void {
      if (disposed) return;
      state.focusNodeId = nodeId;
      render();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Detach the delegated control listeners so a destroyed instance never
      // keeps reacting to `atomic:toggle-pause` / `atomic:reset-view` events.
      window.removeEventListener("atomic:toggle-pause", onTogglePause);
      window.removeEventListener("atomic:reset-view", onResetView);
      // Remove only this instance's dev-only pulse trigger. A deferred cleanup
      // from an earlier StrictMode mount must not delete a newer instance's
      // trigger from the shared window surface.
      if (window.__atomicPulse === pulseTrigger) delete window.__atomicPulse;
      // Release the event pool so no pooled events survive the teardown.
      pool.clear();
      try {
        root.unmount();
      } catch {
        // Unmount must never take the panel down with it.
      }
      if (host.parentNode === container) container.removeChild(host);
    },
  };
}

/**
 * The Phase B `mount` implementation for the Atomic renderer plugin.
 *
 * - Gates on the environment's WebGL2 capability via {@link
 *   detectTopologyCapabilities}; a `false` capability (SSR / jsdom / a
 *   WebGL2-less browser) throws {@link AtomicWebGLUnsupportedError} — a clear,
 *   catchable error for the caller to handle (the host contract turns it into
 *   a fallback to the default 2D renderer).
 * - Otherwise creates a client-only scene host and returns the imperative
 *   instance from {@link createAtomicTopologyInstance}.
 *
 * @param container the plain container element to mount into.
 * @param initial   the first snapshot to render.
 * @param options   renderer options (empty-state label + provider click).
 * @returns the controlling {@link TopologyRendererInstance}.
 * @throws {@link AtomicWebGLUnsupportedError} when WebGL2 is unavailable.
 */
export function mountAtomicTopologyRenderer(
  container: HTMLElement,
  initial: TopologySceneSnapshot,
  options: TopologyRendererOptions
): TopologyRendererInstance {
  const { webgl2 } = detectTopologyCapabilities();
  if (!webgl2) throw new AtomicWebGLUnsupportedError();
  return createAtomicTopologyInstance(container, initial, options);
}
