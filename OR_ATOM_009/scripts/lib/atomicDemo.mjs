/**
 * OR-ATOM-009 — demo telemetry harness: shared Playwright helpers.
 *
 * ARCHITECTURE (why this module is split Node-side / browser-side)
 * -----------------------------------------------------------------
 * The demo data MUST flow through the REAL fleet-telemetry pipeline:
 * `FleetTelemetryPoller` (3.5 s cadence, shape-validates the body, marks it
 * stale once `age(reconciliation.capturedAt) > staleWindowMs` (10 s), keeps
 * last-good on transient error) → `snapshot.fleetTelemetry` on
 * `TopologySceneSnapshot` → `resolveAtomDescriptors()`.
 *
 * The poller's fetch is a bare `fetch(url, { signal })` against
 * `GET /api/telemetry/fleet`. The cleanest injection that keeps the REAL
 * validation + staleness + last-good logic untouched is a Playwright
 * `page.route()` interception: the app code is not modified, the request
 * genuinely leaves the app, and the response body we serve is the EXACT
 * body the real endpoint would compute for that snapshot
 * (`buildDemoSnapshot(scenario, capturedAt)` + `reconcileSnapshot(snapshot)`
 * — the same two calls `src/app/api/telemetry/fleet/route.ts` makes).
 *
 * The body is built NODE-side by `buildFleetBody()` (this module) which
 * imports the app's real, unit-tested modules — the browser never re-implements
 * the fixtures (that is how the Phase 2 harness in
 * `src/plugins/atomic-topology/dev/demoHarness.ts` stays the single source
 * of truth). The browser half of this module only (a) pre-selects the
 * Atomic renderer in localStorage, (b) seeds the dev-only
 * `window.__atomicDemo` handle (same shape `demoController.ensureDemoHandle`
 * exposes, so capture labels read DEMO vs UNAVAILABLE), and (c) samples
 * FPS / live canvas count / WebGL context-loss events for the soak gates.
 *
 * RUNTIME: everything runs under `node --import tsx` (tsconfig path
 * aliases resolve; verified by `fixtures/gen-fixture-bodies.mjs --verify`).
 */

/** The URL path the fleet poller hits (mirrors demoController.FLEET_ENDPOINT). */
export const FLEET_ENDPOINT = "/api/telemetry/fleet";

/** The query param that enables demo mode (mirrors demoController.DEMO_QUERY_PARAM). */
export const DEMO_QUERY_PARAM = "topology-demo";

/** The query param that enables the developer diagnostics panel. */
export const DEV_QUERY_PARAM = "topology-dev";

/** localStorage key the renderer host reads for the atomic/2d preference. */
export const RENDERER_PREF_KEY = "omniroute.topology.renderer";

/** The 9 scenario ids, in VALIDATION_MATRIX row order (mirrors demoHarness.DEMO_SCENARIO_IDS). */
export const DEMO_SCENARIO_IDS = [
  "idle",
  "unknown-stale",
  "tps-20",
  "tps-80",
  "queued-jobs",
  "mixed-lanes",
  "completion",
  "failed-request",
  "multi-runtime-gpu",
];

/** True for a valid scenario id. */
export function isKnownScenario(scenarioId) {
  return DEMO_SCENARIO_IDS.includes(scenarioId);
}

/**
 * The `capturedAt` the demo body carries for a scenario at wall time `t`.
 * Every scenario is FRESH at its own `capturedAt` except `unknown-stale`,
 * which is pinned 15 s in the past — older than the poller's 10 s
 * `staleWindowMs`, so the REAL poller marks the feed stale from its first
 * poll (15 s > 3 × windowMs (10 s) → the per-sample rule also decays values
 * to unknown, which the scenario's own fixture encodes with `stale: true`).
 */
export function capturedAtFor(scenarioId, t = Date.now()) {
  if (scenarioId === "unknown-stale") return t - 15_000;
  return t;
}

/**
 * Node-side: build the exact wire body the real endpoint would return for
 * the scenario — `{ snapshot, reconciliation }`. Uses the app's real
 * modules so the served body is byte-for-byte what the server would emit.
 *
 * @param {string} scenarioId one of DEMO_SCENARIO_IDS.
 * @param {number} [capturedAt] fixed epoch-ms capture time (the poller's
 *   own clock ages it → the REAL staleness rules fire exactly as for a
 *   live feed). Defaults to `capturedAtFor(scenarioId, Date.now())`.
 * @returns {Promise<{snapshot: object, reconciliation: object}>}
 */
export async function buildFleetBody(scenarioId, capturedAt) {
  const t = capturedAt ?? capturedAtFor(scenarioId);
  const { buildDemoSnapshot, getDemoScenario } =
    await import("../../../src/plugins/atomic-topology/dev/demoHarness.ts");
  const { reconcileSnapshot } = await import("../../../src/shared/topology/telemetry/reconcile.ts");
  const scenario = getDemoScenario(scenarioId);
  if (!scenario) throw new Error(`buildFleetBody: unknown demo scenario "${scenarioId}"`);
  const snapshot = buildDemoSnapshot(scenario, t);
  const reconciliation = reconcileSnapshot(snapshot);
  // Structural check mirrors the poller's isFleetTelemetryResponse
  // (fleetTelemetryPoller.ts:266) — never serve a body the REAL poller
  // would reject.
  if (
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.capturedAt !== "number" ||
    !Array.isArray(snapshot.resources) ||
    reconciliation.schemaVersion !== 1 ||
    typeof reconciliation.capturedAt !== "number" ||
    !Array.isArray(reconciliation.gpuNodes) ||
    !Array.isArray(reconciliation.edges)
  ) {
    throw new Error(`buildFleetBody: body for "${scenarioId}" failed the poller shape check`);
  }
  return { snapshot, reconciliation };
}

/**
 * Install a Playwright page.route() interception on the fleet endpoint:
 * every request to the fleet path (any query) is answered with the given
 * demo body (200, application/json). The poller's fetch is untouched — its
 * REAL shape validation, staleness derivation and last-good logic run
 * against our body.
 *
 * @param {import("playwright").Page} page
 * @param {object} body the `{ snapshot, reconciliation }` wire body.
 * @returns {{servedCount: () => number, servedAt: () => number[], stop: () => void}}
 */
export function installFleetRoute(page, body) {
  const servedAt = [];
  const handler = async (route) => {
    servedAt.push(Date.now());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  };
  const routePromise = page.route(`**${FLEET_ENDPOINT}**`, handler);
  void routePromise;
  return {
    servedCount: () => servedAt.length,
    servedAt: () => servedAt.slice(),
    // Awaited: an unhandled `unroute` rejection after `browser.close()` would
    // crash the process with `page.unroute: Target page, context or browser
    // has been closed`.
    stop: async () => {
      try {
        await page.unroute(`**${FLEET_ENDPOINT}**`, handler);
      } catch {
        // Page/context/browser already closed at teardown — nothing to do.
      }
    },
  };
}

/**
 * Install a Playwright page.route() interception on `/api/providers` that
 * MERGES one active `demo-provider` connection into the REAL response
 * (falling back to `{ connections: [], total: 0 }` when the real endpoint is
 * unavailable). The real app path then picks it up:
 * `providerConnections → addProvider(conn.provider)`
 * (HomePageClient.tsx) → `topologyProviders` → `normalizeTopology` →
 * `provider:demo-provider` node + `route:demo-provider` link → the pulse
 * gate proves the link. Real provider atoms are preserved — the demo
 * connection is ADDITIVE, so the smoke exercises the real provider path plus
 * one synthetic fleet-strengthened atom (the G-3 proven row).
 *
 * @param {import("playwright").Page} page
 * @param {string} providerId
 * @returns {{servedCount: () => number, stop: () => void}}
 */
export function installDemoProviderSeedRoute(page, providerId = "demo-provider") {
  const servedAt = [];
  const handler = async (route) => {
    // Exact path only — sub-routes (/api/providers/validate, …) pass through.
    const pathname = new URL(route.request().url()).pathname;
    if (pathname !== "/api/providers") {
      await route.continue();
      return;
    }
    let json = { connections: [], total: 0 };
    try {
      const response = await route.fetch();
      if (response.ok()) json = await response.json();
    } catch {
      // Endpoint missing / failed → fall back to the empty shape; the demo
      // connection below still seeds the atom.
    }
    if (!Array.isArray(json.connections)) json = { connections: [], total: 0 };
    if (!json.connections.some((c) => c.provider === providerId)) {
      json.connections.push({
        id: `demo-${providerId}-conn`,
        provider: providerId,
        providerAlias: providerId,
        name: `Demo ${providerId}`,
        apiType: "api_key",
        isActive: true,
        testStatus: "active",
      });
    }
    json.total = (typeof json.total === "number" ? json.total : 0) + 1;
    servedAt.push(Date.now());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
  };
  const pattern = "**/api/providers**";
  const routePromise = page.route(pattern, handler);
  void routePromise;
  return {
    servedCount: () => servedAt.length,
    stop: async () => {
      try {
        await page.unroute(pattern, handler);
      } catch {
        // Page/context/browser already closed at teardown — nothing to do.
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Browser-side init scripts (Playwright addInitScript payloads)        */
/* ------------------------------------------------------------------ */

/**
 * `page.addInitScript()` payload: pre-select the Atomic (3D) renderer so
 * the host mounts the WebGL scene the demo pipeline feeds.
 */
export function atomicRendererPrefInitScript() {
  return () => {
    // NOTE: Playwright serializes this function to a string and evaluates it
    // in the page, so it must be fully self-contained — NO module-scope
    // identifiers (the pref key below is deliberately inlined as a literal;
    // referencing the module constant here throws a ReferenceError in the
    // page that the catch would silently swallow).
    try {
      window.localStorage.setItem("omniroute.topology.renderer", "atomic");
    } catch {
      /* storage unavailable — the page falls back; the gate reports it */
    }
  };
}

/**
 * `page.addInitScript(fn, [scenarioId, capturedAt])` payload: seed the
 * dev-only handle with the SAME shape `demoController.ensureDemoHandle()`
 * exposes, so the harness can label captures DEMO (id set) vs UNAVAILABLE
 * (absent) and report the body's age exactly as the poller sees it.
 * (Playwright's addInitScript accepts at most ONE argument — the pair must
 * travel as a single array.)
 */
export function demoHandleSeedInitScript() {
  return (args) => {
    const [scenarioId, capturedAt] = Array.isArray(args) ? args : [args];
    if (!scenarioId) return;
    window.__atomicDemo = {
      id: scenarioId,
      capturedAt: typeof capturedAt === "number" ? capturedAt : 0,
      active: true,
    };
  };
}

/**
 * `page.addInitScript()` payload: rAF FPS sampler + live canvas tracker +
 * WebGL context-loss event counters (document-level, so it catches the
 * canvas-level listeners' events too). This is the evidence source for the
 * soak gates; it adds no app code.
 */
export function perfSamplerInitScript() {
  return () => {
    window.__ft = { frames: 0, dtSum: 0, dtMax: 0, last: 0 };
    const tick = (ts) => {
      const ft = window.__ft;
      if (ft.last) {
        const dt = ts - ft.last;
        ft.frames++;
        ft.dtSum += dt;
        if (dt > ft.dtMax) ft.dtMax = dt;
      }
      ft.last = ts;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__ctxEvents = { lost: 0, restored: 0 };
    // `webglcontextlost` / `webglcontextrestored` do NOT bubble, so a
    // document listener in the bubbling phase would never observe canvas
    // events — the capture phase (window → document → target) is required
    // for these counters to see canvas-level loss/restore.
    document.addEventListener(
      "webglcontextlost",
      () => {
        window.__ctxEvents.lost++;
      },
      true
    );
    document.addEventListener(
      "webglcontextrestored",
      () => {
        window.__ctxEvents.restored++;
      },
      true
    );
    window.__peakCanvases = 0;
    window.__sample = () => {
      const canvases = [...document.querySelectorAll("canvas")];
      if (canvases.length > window.__peakCanvases) window.__peakCanvases = canvases.length;
      const ft = window.__ft;
      const frames = ft.frames;
      const dtSum = ft.dtSum;
      ft.frames = 0;
      ft.dtSum = 0;
      const dtMs = frames ? dtSum / frames : null;
      const panel = document.querySelector(".atomic-telemetry-diagnostics");
      const demo = window.__atomicDemo;
      return {
        at: Date.now(),
        fps: dtMs ? Math.round(1000 / dtMs) : null,
        dtMs: dtMs ? Math.round(dtMs * 10) / 10 : null,
        dtMaxMs: Math.round(ft.dtMax),
        liveCanvases: canvases.length,
        peakCanvases: window.__peakCanvases,
        ctxEvents: { ...window.__ctxEvents },
        demo: demo
          ? {
              id: demo.id,
              active: demo.active,
              capturedAt: demo.capturedAt,
              ageMs: demo.capturedAt ? Date.now() - demo.capturedAt : null,
            }
          : null,
        panel: panel ? { demoScenario: panel.getAttribute("data-demo-scenario") } : null,
      };
    };
  };
}

/* ------------------------------------------------------------------ */
/* Page helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * The dashboard topology URL with the demo (and optionally dev-panel)
 * query params. The `topology-dev=1` param is what the Phase 3 integrator
 * keys the diagnostics panel on; it is harmless when the panel is not yet
 * wired (a plain query param the page ignores).
 */
export function topologyUrl(scenarioId, { dev = true, base = "", demo = true } = {}) {
  const params = new URLSearchParams();
  // `demo: false` omits the ?topology-demo param so the host's in-page demo
  // fetch wrapper (demoController.injectDemoTelemetry, wired in
  // ProviderTopology since OR-ATOM-009 B7) stays INACTIVE and the harness's
  // network `page.route` intercept is the SOLE demo source — the original
  // S9.5/S9.6 contract (wire `capturedAt` age drives the badge, so
  // "unknown-stale" reaches a real "stale" state and `servedCount()` ≥ 1).
  if (demo && scenarioId) params.set(DEMO_QUERY_PARAM, scenarioId);
  if (dev) params.set(DEV_QUERY_PARAM, "1");
  const q = params.toString();
  return base + "/home" + (q ? "?" + q : "");
}

/**
 * Wait for the atomic renderer to mount (a canvas exists) and return the
 * first canvas element handle. Throws after `timeoutMs`.
 */
export async function waitForAtomicCanvas(page, timeoutMs = 30_000) {
  await page.waitForSelector("canvas", { timeout: timeoutMs });
  return page.locator("canvas").first();
}

/**
 * Pass the dashboard's management-password gate when a local server has
 * login enabled. Fills the single `input[type=password]` on `/login` with
 * `password`, submits, and (if the redirect lands on `/dashboard` rather
 * than the requested route) navigates back to `targetUrl` so the demo query
 * params re-apply. No-op when the server does not require login (the page
 * never lands on `/login`).
 *
 * The password comes from the harness operator's environment (LOGIN_PASSWORD
 * on soak.mjs / contextLoss.mjs) — it is never written into any artifact.
 */
export async function ensureAuthenticated(page, password, targetUrl, { timeoutMs = 45_000 } = {}) {
  if (!password || !page.url().includes("/login")) return false;
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.waitFor({ state: "visible", timeout: timeoutMs });
  await passwordInput.fill(password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: timeoutMs }),
    page.locator("form").getByRole("button").first().click(),
  ]);
  if (!page.url().includes(targetUrl)) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  return true;
}

/**
 * Sample the perf sampler state (`window.__sample()`). Returns null when the
 * sampler is not installed (e.g. a page without the init script).
 */
export async function samplePerf(page) {
  try {
    return await page.evaluate(() => (window.__sample ? window.__sample() : null));
  } catch {
    return null;
  }
}

/**
 * Capture the atomic canvas (or the whole page) to a PNG.
 * @returns {Promise<string>} the written path.
 */
export async function captureCanvas(page, outPath) {
  try {
    await page.locator("canvas").first().screenshot({ path: outPath });
  } catch {
    await page.screenshot({ path: outPath, fullPage: false });
  }
  return outPath;
}
