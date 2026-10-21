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

import { detectTopologyCapabilities } from "./capabilities";
import { computeAtomicLayout, type AtomicLayoutNode } from "./layout";
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
} from "./eventPool";
import { resolveSceneQuality, type QualityProbe } from "./quality";
import { createAtomicCameraState, type AtomicSceneContextValue } from "./scene/sceneContext";

// Re-export the pure visual-encoding types so the scene/overlay subtree has a
// single import point (this adapter) rather than reaching into `visualEncoding`
// directly.
export type { JobLane, SpinResult, VibrationResult, AtomicVisualState, AtomicVisualStateInput };

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
  kind: "hub" | "provider" | "gpu";
  /** Human label (from the snapshot node). */
  label: string;
  /** Provider id the atom represents (absent for the hub / gpu atoms). */
  providerId?: string;
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
  /** Composed health/traffic state + stroke style (from `resolveVisualState`). */
  visualState: {
    state: AtomicVisualState;
    style: { width: number; opacity: number; animated: boolean };
  };
  /** In-flight request count, or `null` when absent (never `0`). */
  activeRequests: number | null;
  /** 0-based ring index; the hub is `-1` (the nucleus, not on a ring). */
  ringIndex: number;
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
 * WebGL. The hub is always present (nucleus at the origin); provider/gpu atoms
 * are placed by {@link computeAtomicLayout}.
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

  return snapshot.nodes.map((node) => {
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

    // Honest spin (OR-ATOM-002 item 2): the snapshot carries a request
    // *count*, not a tokens-per-second measurement. Feeding a count into
    // `spinRadiansPerSecond` would fabricate a TPS value. The domain has no
    // observed TPS in the snapshot → the honest encoding is `unavailable`.
    const spin = spinRadiansPerSecond(null, SPIN_REFERENCE_TPS);
    // M1 carries no queue telemetry; `null` → "unavailable" (never fabricated).
    const vibration = queueVibration(null);
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
      visualState,
      activeRequests: node.activeRequests?.value ?? null,
      ringIndex,
      modelColors,
    };
  });
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
  const ringPositions = descriptors.filter((d) => d.kind !== "hub");
  const fitRadius = computeFitRadiusFromPositions(
    ringPositions.map((d) => d.position),
    ATOM_FIT_MARGIN
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
  const capturedAt = snapshot.capturedAt;
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
        <AtomicTooltip descriptor={focusedDescriptor} />
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
  };

  let disposed = false;

  // The renderer owns the bounded request-lifecycle event pool (M4): a stable
  // ref handed to the host, populated from each snapshot's `lifecycle` stream
  // on `update`, and cleared on `dispose`. The scene reads it per-frame
  // (inside `useFrame`) for transient discharges — never React state.
  const pool = createAtomicEventPool();

  const ingestSnapshot = (snapshot: TopologySceneSnapshot): void => {
    if (disposed) return;
    const nowMs = Date.now();
    for (const e of mapLifecycleToAtomicEvents(snapshot)) pool.ingest(e, nowMs);
  };

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
