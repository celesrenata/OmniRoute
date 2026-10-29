"use client";

/**
 * ProviderTopology — renderer host (OR-ATOM-001 v2, T004 / M1).
 *
 * This component is the plugin boundary for the home-page topology panel. It
 * OWNS THE DATA: it normalizes the props it receives (provider entries,
 * live active requests, last/error providers) into a renderer-neutral
 * `TopologySceneSnapshot` (see `src/shared/topology/domain/normalizeTopology`)
 * and hands that snapshot to a renderer plugin selected from the registry
 * (see `src/shared/topology/renderer/registry`). It OWNS NO RENDERING: there
 * is no ReactFlow, no layout math and no node styling here — the 2D ReactFlow
 * implementation lives in `ProviderTopology2D.tsx` behind the
 * `reactflow-2d` plugin contract.
 *
 * Renderer selection (AC3 / AC4):
 * - The preferred renderer id is read from browser-local storage via
 *   `readTopologyRendererPreference` — strictly client-side
 *   (`getBrowserStorage` returns `null` when `window` is undefined, so there is
 *   no module-top-level `window` access; this component is also mounted via
 *   `dynamic(..., { ssr: false })` so it is client-only in practice).
 * - Unknown / unregistered ids resolve to the default 2D renderer.
 * - A renderer that throws on `mount` or `update` is disposed and the panel
 *   automatically falls back to 2D with a non-blocking notice.
 *
 * The props interface is unchanged from the previous implementation, so
 * `HomeProviderTopologySection` / `HomePageClient` need no modifications.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  DEFAULT_TOPOLOGY_RENDERER_ID,
  getTopologyRenderer,
  readTopologyRendererPreference,
  writeTopologyRendererPreference,
} from "@/shared/topology/renderer/registry";
import type {
  TopologyRendererInstance,
  TopologyRendererOptions,
} from "@/shared/topology/renderer/types";
// Side effect: importing the built-in self-registers it under "reactflow-2d",
// which the host depends on as its default + fallback renderer.
import "@/shared/topology/renderer/BuiltinReactFlowRenderer";
// Registers the optional WebGL2 "Atomic" 3D renderer under "atomic" (M3).
// SSR-safe to import: the three/R3F scene sits behind a client-only dynamic
// import inside the plugin, so this costs only the pure contract on the
// server. 2D remains the default; 3D is strictly opt-in (see the toggle in
// the returned JSX). A WebGL2-less browser simply falls back (AC4).
import { registerAtomicTopologyRenderer } from "@/plugins/atomic-topology";

// Register the optional Atomic renderer at module load, mirroring how the
// built-in self-registers on import. Doing it here (not in a `useEffect`)
// means the renderer is guaranteed present by the time the host's mount
// effect runs in the first commit — registering inside an effect would race
// the mount effect (declared earlier) and leave the 3D view blank.
registerAtomicTopologyRenderer();
import {
  normalizeTopology,
  type TopologyLifecycleInput,
  type TopologyProviderEntry,
} from "@/shared/topology/domain/normalizeTopology";
import { useFleetTelemetry } from "@/shared/topology/telemetry/useFleetTelemetry";
import { buildAtomSignals, mergeDemoSignals } from "@/shared/topology/telemetry/atomSignals";
import {
  applyDemoFromQueryParam,
  useDemoScenario,
} from "@/plugins/atomic-topology/dev/demoController";
import {
  AtomicTelemetryDiagnostics,
  buildDiagnosticsAtoms,
  buildDiagnosticsRouteLinks,
} from "@/plugins/atomic-topology/overlays/AtomicTelemetryDiagnostics";

/** Shown (non-blocking) when a non-default renderer fails and we fall back to 2D. */
const FALLBACK_NOTICE = "Topology renderer unavailable — showing the 2D view.";

type Props = {
  providers?: TopologyProviderEntry[];
  activeRequests?: Array<{ provider?: string; model?: string }>;
  /**
   * Bounded live-request lifecycle events (M4), derived from the existing
   * gated live-requests feed. Folded into the snapshot's `lifecycle` field;
   * the 2D renderer ignores it. Absent → no lifecycle on the snapshot.
   */
  lifecycleEvents?: TopologyLifecycleInput[] | null;
  lastProvider?: string;
  errorProvider?: string;
  /**
   * Whether the panel is actually shown (OR-ATOM-005 / Step 5, T5.3). Gates the
   * fleet-telemetry poller: hidden panel → no poller, no requests. The
   * lifecycle feed is gated one level up (the section's `enabled` prop); this
   * gate applies to the fleet polling path, which is Atomic-scene work.
   */
  enabled?: boolean;
};

/**
 * Browser-local storage, SSR-safe: `null` during server rendering (and when
 * storage access throws, e.g. some privacy modes). The panel renders with the
 * default renderer in that case.
 */
function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The renderer id to mount: the persisted preference when it resolves to a
 * registered renderer, otherwise the default 2D renderer. SSR-safe (no storage
 * on the server → default).
 */
function resolveInitialRendererId(): string {
  const preferred = readTopologyRendererPreference(getBrowserStorage());
  return getTopologyRenderer(preferred) ? preferred : DEFAULT_TOPOLOGY_RENDERER_ID;
}

export default function ProviderTopology({
  providers = [],
  activeRequests = [],
  lifecycleEvents = null,
  lastProvider = "",
  errorProvider = "",
  enabled = true,
}: Props) {
  const router = useRouter();
  const t = useTranslations("common");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<TopologyRendererInstance | null>(null);

  // The renderer actually mounted. Starts at the resolved preference (default
  // on the server / when unresolvable); a renderer failure resets it back to
  // the default.
  const [rendererId, setRendererId] = useState<string>(resolveInitialRendererId);
  const [notice, setNotice] = useState<string | null>(null);
  const fallbackArmedRef = useRef(false);

  /** Registry id of the optional Atomic (3D) renderer — mirrors `atomicManifest.id`. */
  const atomicRendererId = "atomic";

  // Developer-only demo telemetry (OR-ATOM-009): when the URL carries
  // ?topology-demo=<scenarioId>, `applyDemoFromQueryParam()` (below) injects
  // that scenario's deterministic body into the REAL fleet-telemetry data path
  // — a window.fetch wrapper that answers ONLY /api/telemetry/fleet.
  // `useDemoScenario()` yields the active scenario id so the diagnostics panel
  // can surface the DEMO badge. The normal UI (no query param) is untouched:
  // nothing is injected and the badge stays off.
  const demoScenario = useDemoScenario();
  const demoId = demoScenario?.id ?? null;

  // Developer-only provenance diagnostics, toggled by ?topology-dev=1 (never by
  // any normal UI control). Read once on mount (client-only component, stable
  // per mount). SSR-safe: false on the server.
  const showDevFlag = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("topology-dev") === "1";
  })[0];

  /** Persist the user's renderer choice and remount into the new plugin. */
  const switchRenderer = (id: string) => {
    if (id === rendererId) return;
    writeTopologyRendererPreference(getBrowserStorage(), id);
    setRendererId(id);
  };

  // Fleet telemetry (OR-ATOM-005 / Step 5, T5.3): one bounded,
  // provenance-carrying snapshot from the management-authenticated
  // `GET /api/telemetry/fleet`, polled on a modest cadence and ONLY while
  // the Atomic renderer is the mounted renderer and the panel is visible —
  // the 2D view never polls (its behaviour is byte-identical to before).
  // One in-flight fetch at a time (coalesced in the poller core); aborts on
  // hidden / unmount / mode switch. The carried reconciliation is threaded
  // into the snapshot below; the existing topology consumers keep seeing
  // `snapshot` alone (the block is additive on `snapshot.fleetTelemetry`).
  const atomicActive = rendererId === atomicRendererId;
  const fleetTelemetry = useFleetTelemetry({ enabled: enabled && atomicActive });
  const fleetReconciliation =
    fleetTelemetry.status === "available" ? fleetTelemetry.reconciliation : null;

  // Install the demo fetch wrapper BEFORE the poller's first fetch. A
  // useLayoutEffect runs before every useEffect, and the poller starts in a
  // useEffect — so the wrapper is guaranteed in place for the poller's
  // immediate first fetch. Idempotent + StrictMode-safe (the wrapper captures
  // the original fetch exactly once and reuses it on re-injection). The wrapper
  // persists for the page session (URL-driven demo); it is a no-op while the
  // poller is off, so it never disturbs the normal UI.
  useLayoutEffect(() => {
    applyDemoFromQueryParam();
  }, []);

  // Per-atom provenance rows for the diagnostics panel. Built ONLY while the
  // Atomic renderer is mounted and ?topology-dev=1 (no work otherwise). In demo
  // mode the live feed IS the demo feed (one wrapped fetch), so every source is
  // re-marked "demo" — exactly what mergeDemoSignals does.
  const diagnosticsSignals = useMemo(() => {
    if (!showDevFlag || !atomicActive || !fleetReconciliation) return null;
    const live = buildAtomSignals(fleetReconciliation);
    return demoId ? mergeDemoSignals(live, live) : live;
  }, [showDevFlag, atomicActive, fleetReconciliation, demoId]);

  const diagnosticsAtoms = useMemo(
    () => (diagnosticsSignals ? buildDiagnosticsAtoms(diagnosticsSignals) : []),
    [diagnosticsSignals]
  );

  // Core-owned data: renderer-neutral snapshot of the panel's inputs. The
  // bounded lifecycle stream (M4) is folded in here — it rides the same
  // gated socket as `activeRequests`, so the snapshot carries exactly the
  // live state the panel is observing (no second subscription). The fleet
  // reconciliation (when present) is carried verbatim on
  // `snapshot.fleetTelemetry` (absent → field stays absent — 2D unchanged).
  const snapshot = useMemo(
    () =>
      normalizeTopology({
        providers,
        activeRequests,
        lastProvider,
        errorProvider,
        lifecycleEvents,
        reconciliation: fleetReconciliation,
      }),
    [providers, activeRequests, lifecycleEvents, lastProvider, errorProvider, fleetReconciliation]
  );

  // Per-route-link provenance rows for the diagnostics panel (OR-ATOM-009 S9.5):
  // which visible links are proven and on what basis. Built ONLY while the
  // Atomic renderer is mounted and ?topology-dev=1 (no work otherwise) — the
  // call-log route is the primary proven segment, so this is meaningful even
  // without a reconciliation.
  const diagnosticsRouteLinks = useMemo(
    () => (showDevFlag && atomicActive ? buildDiagnosticsRouteLinks(snapshot) : []),
    [showDevFlag, atomicActive, snapshot]
  );

  // Renderer options (localized empty state + delegated navigation).
  const options = useMemo<TopologyRendererOptions>(
    () => ({
      emptyStateLabel: t("providerTopologyEmpty"),
      onProviderClick: (providerId: string) => {
        router.push(`/dashboard/providers/${providerId}`);
      },
    }),
    [router, t]
  );

  // Refs so the mount effect (driven by `rendererId` only) can read the
  // current snapshot/options without depending on them — depending on the
  // snapshot would remount the canvas (and re-run fitView) on every live tick.
  const snapshotRef = useRef(snapshot);
  const optionsRef = useRef(options);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  // Mount (or remount) the selected renderer into the container.
  //
  // When the renderer id changes, the previous instance is disposed via a
  // microtask (not synchronously) so that the old renderer's own React root
  // (R3F for 3D, ReactFlow for 2D) fully unmounts before the new renderer
  // mounts into the same container. Disposing synchronously during this
  // component's commit triggers React's "synchronously unmount a root while
  // rendering" warning and leaves the freshly-mounted container blank.
  useEffect(() => {
    const container = containerRef.current;
    const plugin = getTopologyRenderer(rendererId);
    if (!container || !plugin) return;

    let instance: TopologyRendererInstance | null = null;
    try {
      instance = plugin.mount(container, snapshotRef.current, optionsRef.current);
    } catch (error) {
      console.error("[topology] renderer mount failed; falling back to 2D", error);
      if (rendererId !== DEFAULT_TOPOLOGY_RENDERER_ID) {
        fallbackArmedRef.current = true;
        // setState from the mount effect is an error-recovery path (the
        // selected renderer threw on mount); flipping to the default 2D
        // plugin triggers a re-mount into a renderer that is known good.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- error recovery, not a render-time side effect
        setNotice(FALLBACK_NOTICE);
        setRendererId(DEFAULT_TOPOLOGY_RENDERER_ID);
      }
      return;
    }

    instanceRef.current = instance;

    setNotice(null);

    return () => {
      if (instanceRef.current === instance) instanceRef.current = null;
      if (instance) {
        // Defer the old renderer's disposal to a microtask so its nested
        // React root finishes unmounting before the next mount commits.
        queueMicrotask(() => {
          try {
            instance.dispose();
          } catch {
            // Dispose must never take the panel down with it.
          }
        });
      }
    };
  }, [rendererId]);

  // Push new snapshots to the mounted renderer.
  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    try {
      instance.update(snapshot);
    } catch (error) {
      console.error("[topology] renderer update failed; falling back to 2D", error);
      try {
        instance.dispose();
      } catch {
        // Ignore — fall through to the fallback below.
      }
      instanceRef.current = null;
      if (rendererId !== DEFAULT_TOPOLOGY_RENDERER_ID) {
        fallbackArmedRef.current = true;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- fallback recovery after a renderer update failure
        setNotice(FALLBACK_NOTICE);

        setRendererId(DEFAULT_TOPOLOGY_RENDERER_ID);
      }
    }
  }, [snapshot, rendererId]);

  return (
    <div className="relative h-[300px] w-full min-w-0 sm:h-[420px]">
      <div ref={containerRef} className="h-full w-full min-w-0" />
      <div className="absolute left-2 top-2 z-10">
        <div
          role="group"
          aria-label="Topology view mode"
          className="flex overflow-hidden rounded-md border border-white/10 bg-bg/90 text-[11px] shadow-sm"
        >
          <button
            type="button"
            aria-pressed={rendererId === DEFAULT_TOPOLOGY_RENDERER_ID}
            onClick={() => switchRenderer(DEFAULT_TOPOLOGY_RENDERER_ID)}
            className={
              rendererId === DEFAULT_TOPOLOGY_RENDERER_ID
                ? "bg-white/10 px-2 py-0.5 font-medium text-white"
                : "px-2 py-0.5 text-white/60 hover:text-white"
            }
          >
            2D
          </button>
          <button
            type="button"
            aria-pressed={rendererId === atomicRendererId}
            onClick={() => switchRenderer(atomicRendererId)}
            className={
              rendererId === atomicRendererId
                ? "bg-white/10 px-2 py-0.5 font-medium text-white"
                : "px-2 py-0.5 text-white/60 hover:text-white"
            }
          >
            Atomic
          </button>
        </div>
      </div>
      {notice && (
        <div
          role="status"
          className="pointer-events-none absolute right-2 top-2 z-10 max-w-[80%] truncate rounded-md border border-amber-500/40 bg-bg/90 px-2 py-1 text-[11px] text-amber-500 shadow-sm"
        >
          {notice}
        </div>
      )}
      {/* Developer-only telemetry provenance diagnostics (OR-ATOM-009). Hidden
       * unless ?topology-dev=1 AND the Atomic renderer is mounted; renders
       * nothing (no DOM) otherwise, so the normal UI is byte-identical. */}
      <AtomicTelemetryDiagnostics
        showDev={showDevFlag && atomicActive}
        reconciliation={fleetReconciliation}
        capturedAt={fleetTelemetry.capturedAt}
        demoScenarioId={demoId}
        atoms={diagnosticsAtoms}
        routeLinks={diagnosticsRouteLinks}
      />
    </div>
  );
}
