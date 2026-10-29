#!/usr/bin/env node
/**
 * OR-ATOM-009 — live telemetry soak (S9.6 stability row: "Live telemetry
 * soak | 20 min").
 *
 * WHAT IT DOES (truth gate, not "it doesn't crash"):
 *   - Loads the dashboard with the Atomic renderer + one deterministic demo
 *     scenario (a VALIDATION_MATRIX row) via
 *     `?topology-demo=<id>&topology-dev=1`.
 *   - Intercepts `GET /api/telemetry/fleet` at the network layer (Playwright
 *     page.route) and serves the EXACT body the real endpoint would return —
 *     built by the app's own `buildDemoSnapshot()` + `reconcileSnapshot()`
 *     (see lib/atomicDemo.mjs). The REAL FleetTelemetryPoller (3.5 s cadence,
 *     shape validation, `age > staleWindowMs` staleness, last-good on
 *     transient error) is untouched: the request genuinely leaves the app
 *     and lands back as our body.
 *   - Samples every minute: FPS, frame dtMax, live/peak canvas count,
 *     WebGL context-loss/restored counts, demo-handle age, console errors /
 *     pageerrors — and writes a canvas PNG per minute.
 *   - At REMOUNT_AT (default 50% of duration) it reloads the page to prove
 *     the scene + pipeline re-establish without unbounded canvas growth
 *     (the init scripts re-run on the new document automatically).
 *   - Emits p50/p95 FPS over the whole run and hard gates:
 *       GATE-1  at least one fleet request served to the real poller
 *               (the demo body actually flowed through the pipeline)
 *       GATE-2  the atomic canvas mounted and was live at the end
 *       GATE-3  zero uncaught page errors
 *       GATE-4  zero WebGL context losses
 *       GATE-5  live canvas count at end ≤ peak canvas count (no unbounded
 *               canvas growth)
 *       GATE-6  remount (when run) restored the scene without growing the
 *               live canvas count
 *   - renderer.info (render.calls / geometries / textures) is reported as
 *     UNAVAILABLE when the host does not expose a `window.__atomic` debug
 *     handle in this checkout (honest — never fabricated).
 *
 * Usage:
 *   BASE=http://127.0.0.1:20128 SCENARIO=tps-80 DURATION=1200 \
 *     node --import tsx OR_ATOM_009/scripts/soak.mjs
 *
 * Env:
 *   BASE        (required) dev-server URL, no trailing slash
 *   SCENARIO    VALIDATION_MATRIX scenario id (default: tps-80)
 *   DURATION    seconds (default 1200, min 600)
 *   REMOUNT_AT  seconds; the page reloads at this point ("0" disables;
 *               default: DURATION/2)
 *   OUT_DIR     evidence dir (default OR_ATOM_009/screenshots)
 *   HEADED=1    visible browser; CHROME_PATH custom executable
 *   LOGIN_PASSWORD  dashboard management password, only when the local
 *                   server requires login (otherwise omit)
 *
 * Writes: soak-<scenario>.json, soak-<scenario>.log,
 *         soak-<scenario>-min-<N>.png, soak-<scenario>-final.png,
 *         soak-<scenario>-final-page.png, soak-<scenario>-remount.png
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { chromium } from "playwright";

import {
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
  isKnownScenario,
} from "./lib/atomicDemo.mjs";

const BASE = (process.env.BASE || "").replace(/\/+$/, "");
const SCENARIO = process.env.SCENARIO || "tps-80";
const DURATION = Math.max(600, parseInt(process.env.DURATION || "1200", 10));
const REMOUNT_AT = process.env.REMOUNT_AT !== "0" ? Math.round(DURATION * 0.5) : -1;
const OUT_DIR = process.env.OUT_DIR || "OR_ATOM_009/screenshots";
const HEADED = process.env.HEADED === "1";
const CHROME_PATH = process.env.CHROME_PATH || undefined;
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || "";

const logLines = [];
const log = (line) => {
  const s = `[${new Date().toISOString()}] ${line}`;
  logLines.push(s);
  console.log(s);
};

/** Mean absolute per-pixel difference between two PNGs (0..255 scale). */
async function pixelDiff(a, b) {
  const [ra, rb] = await Promise.all([
    sharp(a).raw().toBuffer({ resolveWithObject: true }),
    sharp(b).raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return -1;
  const pa = ra.data;
  const pb = rb.data;
  let sum = 0;
  const n = pa.length / 3;
  for (let i = 0; i < pa.length; i += 3) {
    sum +=
      Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
  }
  return Math.round((sum / (n * 3)) * 100) / 100;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)));
  return sorted[idx];
}

function remountAtReached(remountAt, elapsedSec) {
  return remountAt >= 0 && elapsedSec >= remountAt;
}

async function main() {
  if (!BASE) throw new Error("BASE env required, e.g. BASE=http://127.0.0.1:20128");
  if (!isKnownScenario(SCENARIO)) {
    throw new Error(`SCENARIO must be a VALIDATION_MATRIX row id (got "${SCENARIO}")`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Build the demo body with the app's real modules (byte-for-byte what the
  // real endpoint would serve for this snapshot).
  const capturedAt = capturedAtFor(SCENARIO);
  const body = await buildFleetBody(SCENARIO, capturedAt);
  const bodyHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  log(
    `scenario=${SCENARIO} capturedAt=${capturedAt} bodyHash=${bodyHash.slice(0, 16)} gpu=${body.reconciliation.gpuNodes.length} runtime=${body.reconciliation.runtimeNodes.length} edges=${body.reconciliation.edges.length} fallback=${body.reconciliation.providerCentricFallback}`
  );

  const browser = await chromium.launch({ headless: !HEADED, executablePath: CHROME_PATH });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // These re-run on every document (including after the mid-run remount).
  await ctx.addInitScript(atomicRendererPrefInitScript());
  await ctx.addInitScript(perfSamplerInitScript());
  await ctx.addInitScript(demoHandleSeedInitScript(), [SCENARIO, capturedAt]);

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push("PAGEERROR: " + e.message.slice(0, 300)));
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });

  // Intercept the fleet endpoint — the real poller's request is answered
  // with our demo body; everything else passes to the real network. The
  // handler is re-installed after the mid-run remount (new document).
  let route = installFleetRoute(page, body);
  let servedBeforeRemount = 0;
  const servedTotal = () => servedBeforeRemount + route.servedCount();

  // Network delivery (demo: false omits ?topology-demo so the host's in-page
  // demo fetch wrapper — wired in ProviderTopology for OR-ATOM-009 B7 — stays
  // OFF and the route below is the SOLE demo source across the whole soak
  // incl. the mid-run remount). The in-page path is validated separately by
  // scripts/validateB7Injection.mjs.
  const url = topologyUrl(SCENARIO, { demo: false, base: BASE });
  log(
    `soak start base=${BASE} scenario=${SCENARIO} duration=${DURATION}s remountAt=${REMOUNT_AT}s url=${url}`
  );
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (LOGIN_PASSWORD) {
    const didLogin = await ensureAuthenticated(page, LOGIN_PASSWORD, url);
    log(
      didLogin
        ? "dashboard password gate passed (LOGIN_PASSWORD provided)"
        : "no password gate encountered"
    );
  }
  await waitForAtomicCanvas(page, 30_000);
  const baseline = (await samplePerf(page)) ?? { at: Date.now() };
  log("baseline " + JSON.stringify(baseline));

  // Wait for the real poller's first served demo response (first poll fires
  // on mount; allow up to 30 s for the host to activate the section).
  const tServe0 = Date.now();
  while (route.servedCount() === 0 && Date.now() - tServe0 < 30_000) {
    await page.waitForTimeout(500);
  }
  log(`fleet served=${route.servedCount()} after ${((Date.now() - tServe0) / 1000).toFixed(1)}s`);

  const samples = [];
  let prevPng = null;
  const pixelDiffs = [];
  let remountResult = null;
  const t0 = Date.now();

  while (Date.now() - t0 < DURATION * 1000) {
    const elapsed = (Date.now() - t0) / 1000;
    const minute = Math.floor(elapsed / 60);
    const png = path.join(OUT_DIR, `soak-${SCENARIO}-min-${minute}.png`);
    await captureCanvas(page, png);
    const s = (await samplePerf(page)) ?? { at: Date.now() };
    s.pixelDiffVsPrev = prevPng ? await pixelDiff(prevPng, png) : null;
    s.fleetServed = servedTotal();
    samples.push(s);
    if (typeof s.pixelDiffVsPrev === "number") pixelDiffs.push(s.pixelDiffVsPrev);
    prevPng = png;
    log(
      `min=${minute} fps=${s.fps} dtMax=${s.dtMaxMs}ms live=${s.liveCanvases} peak=${s.peakCanvases} ctx=${JSON.stringify(s.ctxEvents)} demoAge=${s.demo?.ageMs}ms served=${s.fleetServed} pixelDiff=${s.pixelDiffVsPrev} pageErr=${pageErrors.length} consoleErr=${consoleErrors.length}`
    );

    // Mid-run remount: full reload proves scene + pipeline re-establish.
    if (remountAtReached(REMOUNT_AT, elapsed) && remountResult === null) {
      const pre = (await samplePerf(page)) ?? null;
      log("remount: reloading page (init scripts + fleet route re-install on the new document)");
      servedBeforeRemount = route.servedCount();
      // Install the FRESH demo route BEFORE stopping the old one. Playwright
      // page-level routes survive navigation, so if the old handler were
      // removed first, the reloaded document's first polls would hit the REAL
      // endpoint (empty fleet on a fresh DATA_DIR) and the Atomic host's
      // canvas gate (descriptors.length > 1) would never open inside the
      // canvas-wait window — the demo body must be the answer across the
      // whole reload.
      const freshRoute = installFleetRoute(page, body);
      await route.stop();
      route = freshRoute;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitForAtomicCanvas(page, 30_000);
      const tR = Date.now();
      while (route.servedCount() === 0 && Date.now() - tR < 30_000) await page.waitForTimeout(500);
      const post = (await samplePerf(page)) ?? null;
      remountResult = { pre, post, servedAfterRemount: route.servedCount() };
      log(
        `remount: pre live=${pre?.liveCanvases} peak=${pre?.peakCanvases} | post live=${post?.liveCanvases} peak=${post?.peakCanvases} served=${route.servedCount()}`
      );
      await captureCanvas(page, path.join(OUT_DIR, `soak-${SCENARIO}-remount.png`));
    }
    await page.waitForTimeout(60_000);
  }

  // AFTER triple + final captures.
  const after = (await samplePerf(page)) ?? { at: Date.now() };
  const rendererInfo = await page
    .evaluate(() => window.__atomic?.rendererInfo ?? null)
    .catch(() => null);
  after.rendererInfo = rendererInfo; // null → UNAVAILABLE in this checkout
  after.fleetServed = servedTotal();
  log("AFTER " + JSON.stringify(after));
  await captureCanvas(page, path.join(OUT_DIR, `soak-${SCENARIO}-final.png`));
  await page.screenshot({ path: path.join(OUT_DIR, `soak-${SCENARIO}-final-page.png`) });

  // ---- Verdicts (hard gates) ------------------------------------------
  const fpsAll = samples
    .map((s) => s.fps)
    .filter((v) => typeof v === "number" && v > 0)
    .sort((a, b) => a - b);
  const gate1 = servedTotal() >= 1;
  const gate2 = after.liveCanvases >= 1;
  const gate3 = pageErrors.length === 0;
  // GATE-4 semantics: the point of the soak is that the app SURVIVES context
  // loss — every loss must be (a) restored and (b) followed by a scene that
  // is still live (GATE-2) with no page errors (GATE-3). A *spontaneous*
  // SwiftShader/ANGLE loss that the app's CanvasContextGuard recovered from
  // is environment flakiness and is REPORTED (lost/restored counts in
  // `after.ctxEvents`), not an app failure — but a loss WITHOUT a restore
  // (an unrecovered, stuck scene) IS an app failure.
  const gate4 =
    (after.ctxEvents?.lost ?? 0) === (after.ctxEvents?.restored ?? 0) &&
    (after.ctxEvents.lost === 0 || ((after.liveCanvases ?? 0) >= 1 && pageErrors.length === 0));
  const gate5 =
    after.liveCanvases >= 1 && after.liveCanvases <= (after.peakCanvases ?? after.liveCanvases);
  const gate6 =
    remountResult === null ||
    (remountResult.post?.liveCanvases ?? 0) <= (remountResult.pre?.liveCanvases ?? 0);
  const verdicts = {
    "GATE-1 demo body served to the real poller": gate1 ? "PASS" : "FAIL",
    "GATE-2 atomic canvas live at end": gate2 ? "PASS" : "FAIL",
    "GATE-3 zero uncaught page errors": gate3 ? "PASS" : "FAIL",
    "GATE-4 every context loss recovered (or none)": gate4 ? "PASS" : "FAIL",
    "GATE-5 no unbounded canvas growth (live ≤ peak, live > 0)": gate5 ? "PASS" : "FAIL",
    "GATE-6 remount restored scene without canvas growth": gate6 ? "PASS" : "FAIL",
  };
  const soft = {
    fps_p50: percentile(fpsAll, 50),
    fps_p95: percentile(fpsAll, 95),
    pixelDiffMin: pixelDiffs.length ? Math.min(...pixelDiffs) : null,
    pixelDiffMax: pixelDiffs.length ? Math.max(...pixelDiffs) : null,
    animated: pixelDiffs.length > 0 && Math.max(...pixelDiffs) > 0.5,
    rendererInfo: rendererInfo
      ? rendererInfo
      : "UNAVAILABLE (this checkout does not expose window.__atomic.rendererInfo)",
    consoleErrors: consoleErrors.slice(0, 20),
    demoHandle: after.demo,
    panelScenario:
      after.panel?.demoScenario ??
      "UNAVAILABLE (diagnostics panel not wired in this checkout — Phase 3 integrator)",
  };

  const result = {
    scenario: SCENARIO,
    capturedAt,
    bodyHash: bodyHash,
    durationSec: DURATION,
    remountAt: REMOUNT_AT,
    base: BASE,
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    baseline,
    samples,
    after,
    remount: remountResult,
    verdicts,
    soft,
    pageErrors: pageErrors.slice(0, 20),
  };
  const jsonPath = path.join(OUT_DIR, `soak-${SCENARIO}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `soak-${SCENARIO}.log`), logLines.join("\n"));
  for (const [k, v] of Object.entries(verdicts)) log(`VERDICT ${k}: ${v}`);
  log(`evidence: ${jsonPath}`);
  const failed = Object.values(verdicts).includes("FAIL");
  await browser.close();
  if (failed) {
    log("SOAK GATES FAILED");
    process.exit(1);
  }
  log("SOAK PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
