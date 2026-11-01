#!/usr/bin/env node
/**
 * OR-ATOM-009 — B7 in-page demo telemetry injection validation.
 *
 * B7 (ProviderTopology.tsx, wired in THIS integration) adds an in-page
 * delivery path: when the URL carries `?topology-demo=<id>`, the host calls
 * `applyDemoFromQueryParam()` in a useLayoutEffect BEFORE the
 * FleetTelemetryPoller's first fetch. That installs an in-page `window.fetch`
 * wrapper (demoController.injectDemoTelemetry) which answers
 * `/api/telemetry/fleet` with the scenario's deterministic body
 * (buildDemoSnapshot + reconcileSnapshot, wire capturedAt = mount time) —
 * so the REAL poller consumes demo telemetry without any network request,
 * and the AtomicTelemetryDiagnostics panel (new in this integration)
 * surfaces `data-demo-scenario`.
 *
 * This script drives that in-page path for every VALIDATION_MATRIX scenario:
 *   B-1 the in-page fetch wrapper is installed (`__atomicDemoFetchOriginal`)
 *   B-2 the real poller consumed a shape-validated body (the telemetry badge
 *       reached a genuine freshness state — B7's body is fresh at mount, so
 *       "available")
 *   B-3 the dev-only demo handle is live and matches the scenario
 *   B-4 the diagnostics panel renders with the correct data-demo-scenario
 *       (NEW in this integration; pre-integration the panel was not wired)
 *   B-5 the body did NOT cross the network (served === 0) — the
 *       discriminator that the in-page wrapper, not the network intercept,
 *       answered the poller
 *
 * The network-delivery contract (wire `capturedAt` age drives the badge,
 * incl. "unknown-stale" → "stale") is validated by captureScenarios.mjs /
 * soak.mjs / contextLoss.mjs / toggleStability.mjs with `demo: false`.
 *
 * ENV:
 *   BASE          dev server origin (default http://127.0.0.1:20999)
 *   CHROME_PATH   chromium executable (required)
 *   LOGIN_PASSWORD management-password gate (no-op on open-bootstrap servers)
 *   SETTLE_MS     settle after canvas mount (default 5000)
 *   SCENARIO      run only one scenario id (debugging)
 */
import { chromium } from "playwright";
import {
  DEMO_SCENARIO_IDS,
  atomicRendererPrefInitScript,
  perfSamplerInitScript,
  installFleetRoute,
  buildFleetBody,
  capturedAtFor,
  topologyUrl,
  waitForAtomicCanvas,
  ensureAuthenticated,
  samplePerf,
  captureCanvas,
} from "./lib/atomicDemo.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, "..", "screenshots");
const BASE = (process.env.BASE || "http://127.0.0.1:20999").replace(/\/+$/, "");
const CHROME = process.env.CHROME_PATH;
const PW = process.env.LOGIN_PASSWORD;
const SETTLE_MS = Number(process.env.SETTLE_MS || 5000);
const ONLY = process.env.SCENARIO || null;

if (!CHROME) {
  console.error("CHROME_PATH is required (e.g. the cached chromium_headless_shell).");
  process.exit(2);
}

/** Poll for the telemetry badge and return {state, aria} (or null). */
async function waitBadgeState(page, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const el = document.querySelector("[data-atomic-telemetry-status]");
      return el
        ? {
            state: el.getAttribute("data-atomic-telemetry-status"),
            aria: el.getAttribute("aria-label"),
          }
        : null;
    });
    if (last && last.state === expected) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const results = [];
let failures = 0;

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

// Warm the dev server once so the first scenario does not absorb the
// one-off cold-compile cost (the badge freezes at first observation).
{
  const warm = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const warmPage = await warm.newPage();
  await warmPage
    .goto(BASE + "/home", { waitUntil: "domcontentloaded", timeout: 90_000 })
    .catch(() => {});
  await warmPage.waitForTimeout(4000);
  await warm.close();
  console.log("(server warmed)");
}

for (const id of DEMO_SCENARIO_IDS) {
  if (ONLY && id !== ONLY) continue;
  const t0 = Date.now();
  // The body the route WOULD serve if B7 were absent — built by the app's
  // own modules (same two calls the real endpoint makes). Only used as the
  // route's answer, so B-5's served === 0 is meaningful (a served body is
  // shape-valid either way).
  const body = await buildFleetBody(id, capturedAtFor(id));

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(atomicRendererPrefInitScript());
  // NOTE: deliberately NO demoHandleSeedInitScript here — window.__atomicDemo
  // must come from B7's own ensureDemoHandle so the handle is unambiguous
  // evidence of the in-page injection (the seed would shadow that proof).
  await ctx.addInitScript(perfSamplerInitScript());
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push("PAGEERROR: " + e.message.slice(0, 300)));

  // Network route installed as the DISCRIMINATOR: if the in-page wrapper is
  // absent, the poller's request reaches the network and this counter moves.
  const served = installFleetRoute(page, body);
  // Demo param ON → B7 active; dev flag ON → diagnostics panel visible.
  const target = topologyUrl(id, { dev: true, base: BASE });
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await ensureAuthenticated(page, PW, target);
  await waitForAtomicCanvas(page, 30_000);
  await page.waitForTimeout(SETTLE_MS);

  // B-2: wait for the real poller's verdict on B7's in-page body.
  const badge = await waitBadgeState(page, "available", 30_000);
  const perf = await page.evaluate(() => (window.__sample ? window.__sample() : null));
  const inPage = await page.evaluate(() => ({
    wrapperInstalled: typeof window.__atomicDemoFetchOriginal === "function",
    demo: window.__atomicDemo
      ? {
          id: window.__atomicDemo.id,
          active: window.__atomicDemo.active,
          capturedAt: window.__atomicDemo.capturedAt,
        }
      : null,
    panelScenario:
      document.querySelector(".atomic-telemetry-diagnostics")?.getAttribute("data-demo-scenario") ??
      null,
  }));
  const png = path.join(OUT_DIR, `capture-b7-${id}.png`);
  await captureCanvas(page, png);

  const servedCount = served.servedCount();
  const checks = {
    "B-1 in_page_wrapper_installed": inPage.wrapperInstalled === true,
    "B-2 poller_consumed_body_badge_available": badge?.state === "available",
    "B-3 demo_handle_live_and_matching": inPage.demo?.id === id && inPage.demo?.active === true,
    "B-4 diagnostics_panel_renders_scenario": inPage.panelScenario === id,
    "B-5 body_not_served_over_network": servedCount === 0,
  };
  const row = {
    scenario: id,
    at: new Date().toISOString(),
    durationMs: Date.now() - t0,
    badge,
    badgeExpected: "available",
    bodyCapturedAt: inPage.demo?.capturedAt ?? null,
    bodyAgeAtSample: inPage.demo?.capturedAt ? Date.now() - inPage.demo.capturedAt : null,
    perf,
    servedNetwork: servedCount,
    errors: { pageErrors },
    png: path.relative(path.resolve(HERE, ".."), png),
    checks,
  };
  row.verdict = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
  if (row.verdict === "FAIL") failures++;
  results.push(row);
  console.log(
    `[${row.verdict}] ${id}: badge=${badge?.state ?? "missing"} wrapper=${inPage.wrapperInstalled} ` +
      `panel=${inPage.panelScenario} servedNetwork=${servedCount} canvases=${perf?.liveCanvases} ` +
      `fps=${perf?.fps} pageErr=${pageErrors.length}`
  );
  await ctx.close();
}

await browser.close();

const out = path.join(OUT_DIR, "b7Injection.json");
fs.writeFileSync(
  out,
  JSON.stringify({ base: BASE, startedAt: new Date().toISOString(), results }, null, 2)
);
console.log(`\nEvidence: ${out} (+ per-scenario capture-b7-<id>.png)`);
console.log(
  failures === 0
    ? "VERDICT b7Injection: PASS"
    : `VERDICT b7Injection: FAIL (${failures}/${results.length} scenarios)`
);
process.exit(failures === 0 ? 0 : 1);
