#!/usr/bin/env node
/**
 * OR-ATOM-009 — per-scenario live capture (VALIDATION_MATRIX rows).
 *
 * WHAT IT DOES:
 *   For EVERY VALIDATION_MATRIX scenario (9 rows) this loads the dashboard
 *   topology with the Atomic renderer + that deterministic demo scenario,
 *   intercepts `GET /api/telemetry/fleet` at the network layer and serves
 *   the EXACT body the real endpoint would return (built by the app's own
 *   `buildDemoSnapshot()` + `reconcileSnapshot()` — see lib/atomicDemo.mjs),
 *   then lets the REAL FleetTelemetryPoller run for SETTLE_MS so its own
 *   shape validation / staleness rules produce the state the UI shows.
 *
 *   Evidence per scenario:
 *     - a canvas PNG (screenshots/capture-<scenario>.png)
 *     - the telemetry badge's `data-atomic-telemetry-status` + aria-label
 *       (the badge the operator sees; "available" = fresh, "stale" = the
 *       real poller aged the body past staleWindowMs)
 *     - a full perf sample (FPS, live/peak canvases, ctx events, demo-handle
 *       age — the age the POLLER's clock sees for the served body)
 *     - fleet requests served to the real poller + console/page errors
 *
 *   Gates (hard — a failure exits non-zero and is reported, never hidden):
 *     C-1  the atomic canvas mounted (liveCanvases >= 1)
 *     C-2  the demo body was actually served to the real poller (>= 1)
 *     C-3  the demo label is present in the page (window.__atomicDemo)
 *     C-4  the badge shows the EXPECTED freshness state for the scenario
 *          (every scenario "available" EXCEPT "unknown-stale" → "stale")
 *
 * ENV:
 *   BASE          dev server origin (default http://127.0.0.1:20999)
 *   CHROME_PATH   chromium executable (required — cached build mismatch)
 *   LOGIN_PASSWORD management-password gate (the 20999 smoke server has it)
 *   SETTLE_MS     poller settle time after canvas mount (default 8000)
 *   SCENARIO      run only one scenario id (debugging)
 */
import { chromium } from "playwright";
import {
  DEMO_SCENARIO_IDS,
  buildFleetBody,
  capturedAtFor,
  installFleetRoute,
  atomicRendererPrefInitScript,
  demoHandleSeedInitScript,
  perfSamplerInitScript,
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
const BASE = process.env.BASE || "http://127.0.0.1:20999";
const CHROME = process.env.CHROME_PATH;
const PW = process.env.LOGIN_PASSWORD;
const SETTLE_MS = Number(process.env.SETTLE_MS || 8000);
const ONLY = process.env.SCENARIO || null;

if (!CHROME) {
  console.error("CHROME_PATH is required (e.g. the cached chromium_headless_shell).");
  process.exit(2);
}

// Every scenario's body is FRESH at its capturedAt EXCEPT "unknown-stale"
// (pinned 15 s in the past → older than the poller's 10 s staleWindowMs →
// the REAL poller marks the feed stale from its first poll). So the badge
// state the operator sees is fully predicted by the scenario id.
const EXPECTED_BADGE = { "unknown-stale": "stale" };

/** Poll for the telemetry badge and return {state, aria} (or null). */
async function waitBadge(page, timeoutMs = 20_000) {
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
    if (last && last.state) return last;
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

// Warm the dev server ONCE before the loop. The badge in the real app
// (AtomicTopologyRenderer.tsx) freezes at first observation: it computes
// age = Date.now() - capturedAt the first time a fleet sample lands and
// never re-ages (useEffect deps = [capturedAt], and the demo body carries a
// constant capturedAt). A fresh scenario therefore shows "available" ONLY if
// its first fleet observation happens within the poller's 10 s freshness
// window. The FIRST scenario otherwise absorbs the page's one-off cold-compile
// cost between body-build and first poll and would be falsely marked stale.
// This warm-up spends that cost on a throwaway page so every scenario starts
// warm; it changes no app code and is not itself captured.
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
  const capturedAt = capturedAtFor(id);
  const body = await buildFleetBody(id, capturedAt);
  const expectedBadge = EXPECTED_BADGE[id] ?? "available";

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(atomicRendererPrefInitScript());
  await ctx.addInitScript(demoHandleSeedInitScript(), [id, capturedAt]);
  await ctx.addInitScript(perfSamplerInitScript());
  const page = await ctx.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push("PAGEERROR: " + e.message.slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });

  const served = installFleetRoute(page, body);
  // Network delivery (demo: false omits ?topology-demo so the host's in-page
  // demo fetch wrapper — wired in ProviderTopology for OR-ATOM-009 B7 — stays
  // OFF and this route is the SOLE demo source; the wire capturedAt age then
  // drives the badge staleness exactly as pre-B7). The in-page path is
  // validated separately by scripts/validateB7Injection.mjs.
  const target = topologyUrl(id, { dev: true, demo: false, base: BASE });
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await ensureAuthenticated(page, PW, target);
  await waitForAtomicCanvas(page, 30_000);
  // Let the real poller complete at least two 3.5 s cycles on the served
  // body so staleness/freshness is the poller's own verdict, not a first
  // paint.
  await page.waitForTimeout(SETTLE_MS);

  const badge = await waitBadge(page);
  const perf = await samplePerf(page);
  const png = path.join(OUT_DIR, `capture-${id}.png`);
  await captureCanvas(page, png);

  const row = {
    scenario: id,
    at: new Date().toISOString(),
    durationMs: Date.now() - t0,
    bodyCapturedAt: capturedAt,
    bodyAgeAtSample: perf.demo ? perf.demo.ageMs : null,
    badge,
    expectedBadge,
    perf,
    served: served.servedCount(),
    servedAtOffsetsMs: served.servedAt().map((t) => t - capturedAt),
    errors: { pageErrors, consoleErrors },
    png: path.relative(path.resolve(HERE, ".."), png),
    checks: {
      "C-1 canvas_mounted": perf.liveCanvases >= 1,
      "C-2 demo_served": served.servedCount() >= 1,
      "C-3 demo_labeled": Boolean(perf.demo && perf.demo.id === id && perf.demo.active === true),
      "C-4 badge_expected": badge?.state === expectedBadge,
    },
  };
  row.verdict = Object.values(row.checks).every(Boolean) ? "PASS" : "FAIL";
  if (row.verdict === "FAIL") failures++;
  results.push(row);
  console.log(
    `[${row.verdict}] ${id}: badge=${row.badge?.state ?? "missing"} (expected ${expectedBadge}) ` +
      `served=${row.served} age=${row.bodyAgeAtSample}ms canvases=${perf.liveCanvases}/${perf.peakCanvases} ` +
      `fps=${perf.fps} pageErr=${pageErrors.length}`
  );
  await ctx.close();
}

await browser.close();

const out = path.join(OUT_DIR, "captureScenarios.json");
fs.writeFileSync(
  out,
  JSON.stringify({ base: BASE, startedAt: new Date().toISOString(), results }, null, 2)
);
console.log(`\nEvidence: ${out} (+ per-scenario PNGs in ${path.basename(OUT_DIR)}/)`);
console.log(
  failures === 0
    ? "VERDICT captureScenarios: PASS"
    : `VERDICT captureScenarios: FAIL (${failures}/${results.length} scenarios)`
);
process.exit(failures === 0 ? 0 : 1);
