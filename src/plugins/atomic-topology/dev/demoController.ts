/**
 * Developer-only demo telemetry controller (OR-ATOM-009 / Phase 2, W3).
 *
 * CLIENT-SIDE ONLY. Detects the demo mode from a URL query param
 * (`?topology-demo=<scenarioId>`, a read-only check of `location.search`) and,
 * when a known scenario is requested, injects that scenario's deterministic
 * snapshot into the REAL fleet-telemetry data path — it never fabricates a
 * visual prop, and the normal UI (no query param) is byte-identical in
 * behavior (the module is side-effect-free at import; nothing runs unless the
 * integrator calls `detectDemoScenario()` / `injectDemoTelemetry()` or the
 * Playwright harness drives `window.__atomicDemo`).
 *
 * HOW THE INJECTION FLOWS THROUGH THE REAL PIPELINE
 * -------------------------------------------------
 * The renderer polls `GET /api/telemetry/fleet` through
 * `FleetTelemetryPoller` (`src/shared/topology/telemetry/fleetTelemetryPoller.ts`),
 * whose default fetcher is a bare `fetch(url, { signal })`. The endpoint returns
 * exactly `{ snapshot, reconciliation }` (see
 * `src/app/api/telemetry/fleet/route.ts:55` — `reconcileSnapshot(snapshot)` is
 * computed on the server). So the cleanest injection that still flows through
 * the REAL poller + REAL staleness rules (`staleWindowMs`, last-good on
 * transient error) is to wrap `window.fetch` and answer the fleet endpoint
 * with a JSON body built from the scenario:
 *
 *   1. `injectDemoTelemetry()` snapshots `window.fetch` and wraps it. A request
 *      whose URL ends with `/api/telemetry/fleet` (optional query) is answered
 *      with a synthesized 200 Response whose body is
 *      `{ snapshot: buildDemoSnapshot(scenario, capturedAt), reconciliation }`.
 *      The poller then treats it EXACTLY like a live response: it validates the
 *      shape, computes `stale = age(capturedAt) > staleWindowMs`, and carries it
 *      as last-good. Because the body is built ONCE with a fixed `capturedAt`,
 *      the poller's own clock ages it → the demo data STALES through the REAL
 *      3×windowMs rule instead of a fake prop.
 *   2. `reconcileSnapshot` is the same pure function the server uses, so the
 *      injected `reconciliation` is byte-for-byte what the real endpoint would
 *      return for that snapshot (edges, `providerCentricFallback`, node facts).
 *
 *   The DEMO badge is surfaced by the diagnostics panel
 *   (`AtomicTelemetryDiagnostics.tsx`), NOT by a hidden flag: the harness and
 *   the diagnostics both key off `window.__atomicDemo.id`, so the "DEMO" marker
 *   is always visible whenever demo data is in flight.
 *
 * PROPOSED INTEGRATION HOOK (for the Phase 3 integrator — the renderer is
 * NOT modified by this task). Wire in
 * `src/app/(dashboard)/home/ProviderTopology.tsx` (the host that calls
 * `useFleetTelemetry` and owns `snapshot.fleetTelemetry`):
 *
 *     import { detectDemoScenario } from "@/plugins/atomic-topology/dev/demoController";
 *     const demoScenario = detectDemoScenario(); // null unless ?topology-demo=<id>
 *     ...
 *     <AtomicTelemetryDiagnostics
 *       reconciliation={fleetReconciliation}
 *       telemetryState={telemetryState}
 *       capturedAt={capturedAt}
 *       demoScenarioId={demoScenario?.id ?? null}
 *     />
 *
 *   and, for the demo to actually drive the live pipeline, either (a) have the
 *   harness seed `window.__atomicDemo` + call `injectDemoTelemetry()` from an
 *   `addInitScript` (see `OR_ATOM_009/scripts/lib/atomicDemo.mjs`), or (b) call
 *   `injectDemoTelemetry(demoScenario, capturedAt)` once from the host's mount
 *   effect when `demoScenario` is non-null. Both are the exact call shapes the
 *   Playwright scripts use — see the completion summary / scripts README.
 */
"use client";

import { getDemoScenario, buildDemoSnapshot, type DemoScenario } from "./demoHarness";
import { reconcileSnapshot } from "@/shared/topology/telemetry/reconcile";

/** Global handle the Playwright harness reads/writes (dev-only surface). */
export interface AtomicDemoHandle {
  /** The active scenario id ("" = no demo active). */
  id: string;
  /** The epoch-ms `capturedAt` the demo body carries (fixed once injected). */
  capturedAt: number;
  /** `true` while the fetch wrapper is installed (demo data in flight). */
  active: boolean;
}

/** The query param that enables demo mode (scenario id value). */
export const DEMO_QUERY_PARAM = "topology-demo";

/** The URL path the fleet poller hits (the injection intercepts this). */
export const FLEET_ENDPOINT = "/api/telemetry/fleet";

/**
 * Read-only check of `location.search`: returns the scenario id requested by
 * `?topology-demo=<id>`, or `null` when the param is absent or the scenario is
 * unknown. NEVER throws — an unknown id means "no demo", never an error that
 * could disturb the normal UI. Returns `null` under SSR (no `location`).
 */
export function detectDemoScenario(): string | null {
  if (typeof window === "undefined" || typeof window.location === "undefined") {
    return null;
  }
  const id = new URLSearchParams(window.location.search).get(DEMO_QUERY_PARAM);
  if (id === null || id.length === 0) return null;
  return getDemoScenario(id) !== null ? id : null;
}

/**
 * The React-friendly hook: the active demo scenario (by id) or `null`. The
 * integrator passes this to the diagnostics panel and (optionally) drives the
 * fetch injection from a mount effect.
 */
export function useDemoScenario(): { id: string } | null {
  const id = detectDemoScenario();
  return id === null ? null : { id };
}

/**
 * Expose the dev-only handle on `window` (idempotent). The Playwright harness
 * reads `window.__atomicDemo.id` to label captures DEMO vs UNAVAILABLE and
 * reads `.active` to confirm the injection is installed.
 */
export function ensureDemoHandle(handle: AtomicDemoHandle): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __atomicDemo?: AtomicDemoHandle };
  w.__atomicDemo = handle;
}

/**
 * Inject the scenario's snapshot into the real poller pipeline by wrapping
 * `window.fetch`. The wrapped fetcher answers ONLY
 * `/api/telemetry/fleet` (exact path, optional query) with a synthesized 200
 * JSON Response built from `buildDemoSnapshot` + `reconcileSnapshot` — the same
 * two calls the server endpoint makes. Every other request passes through to
 * the original fetcher untouched.
 *
 * Returns an `uninstall` function that restores the original `window.fetch`
 * (call it on demo teardown so the normal UI resumes its real feed).
 *
 * SAFETY:
 * - Re-entrant-safe: if a wrapper is already installed, the existing
 *   `original` is captured (not the prior wrapper), so repeated `inject`
 *   calls don't nest wrappers indefinitely.
 * - The response body is built ONCE with a fixed `capturedAt`; the poller's
 *   own clock then ages it → the demo STALES through the real rules.
 */
export function injectDemoTelemetry(scenario: DemoScenario, capturedAt: number): () => void {
  if (typeof window === "undefined") return () => {};

  const w = window as unknown as {
    __atomicDemo?: AtomicDemoHandle;
    __atomicDemoFetchOriginal?: typeof fetch;
  };

  // Capture the true original fetch exactly once (before any wrapper).
  if (typeof w.__atomicDemoFetchOriginal === "undefined") {
    w.__atomicDemoFetchOriginal = window.fetch.bind(window);
  }
  const originalFetch = w.__atomicDemoFetchOriginal;

  // Build the response body ONCE (fixed capturedAt → ages via the poller).
  const snapshot = buildDemoSnapshot(scenario, capturedAt);
  const reconciliation = reconcileSnapshot(snapshot);
  const body = JSON.stringify({ snapshot, reconciliation });

  const wrapped: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.split("?")[0] ?? "";
    if (path === FLEET_ENDPOINT || path.endsWith(FLEET_ENDPOINT)) {
      try {
        return Promise.resolve(
          new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })
        );
      } catch {
        // Fall through to the real fetcher if Response construction fails
        // (never break the normal pipeline because of the demo).
      }
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;

  window.fetch = wrapped;

  ensureDemoHandle({ id: scenario.id, capturedAt, active: true });

  return (): void => {
    // Restore the original fetcher and clear the active flag.
    if (w.__atomicDemoFetchOriginal) {
      window.fetch = w.__atomicDemoFetchOriginal;
    }
    if (w.__atomicDemo) w.__atomicDemo.active = false;
  };
}

/**
 * The one-liner the integrator (or harness) uses: detect the scenario from the
 * query param and, if present, inject it with a fresh `capturedAt`. Returns the
 * scenario id (so callers can assert / log), or `null` when no demo is active.
 */
export function applyDemoFromQueryParam(now: number = Date.now()): string | null {
  const id = detectDemoScenario();
  if (id === null) return null;
  const scenario = getDemoScenario(id);
  if (!scenario) return null;
  injectDemoTelemetry(scenario, now);
  return id;
}

export type { DemoScenario };
