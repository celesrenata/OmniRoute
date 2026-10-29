#!/usr/bin/env node
/**
 * OR-ATOM-009 — pulse + multi-runtime diagnostics (S9.4 / S9.5 / S9.6).
 *
 * WHAT IT DOES:
 *   Loads the dashboard topology with the Atomic renderer + `?topology-dev=1`,
 *   intercepts `GET /api/telemetry/fleet` (serving the EXACT body the real
 *   endpoint would return — app's own `buildDemoSnapshot()` +
 *   `reconcileSnapshot()`), seeds `demo-provider` via the `/api/providers`
 *   merge route, then verifies on the REAL rendered scene:
 *
 *     P-1  pulse gate: `__atomicPulse("demo-provider")` ADMITTED once, then
 *          a repeat within the 150 ms dedupe window is COLLAPSED (deduped) —
 *          the persistent-gate contract (a fresh gate per call could never
 *          fire this).
 *     P-2  pulse kinds: `request-completed` and `request-failed` are ADMITTED
 *          after the dedupe window elapses (the gate's per-link admission
 *          history is the ONLY gate — kind never bypasses provenance).
 *     P-3  unproven provider is REJECTED (bad-input / unproven, never a guess).
 *     D-1  multi-runtime: `multi-runtime-gpu` shows BOTH runtime atoms
 *          (`rt-demo-a`, `rt-demo-b`) in the diagnostics per-atom rows.
 *     D-2  provider-centric: `mixed-lanes` (carries `demo-provider`) shows the
 *          PROVEN route link with the fleet-strengthened basis
 *          ("call-log route + fleet-metrics") — the strongest provenance.
 *     D-3  stale feed: `unknown-stale` badge shows "stale" (the REAL poller
 *          aged the 15 s-old body past its 10 s window).
 *
 *   Evidence: pulseDiagnostics.json (+ per-scenario PNGs).
 *
 * ENV:
 *   BASE            (required) e.g. http://127.0.0.1:21011
 *   LOGIN_PASSWORD  (required) dashboard password
 *   CHROME_PATH     (optional) headless shell binary
 *   CHROME_ARGS     set "none" to avoid extra flags
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import {
  buildFleetBody,
  capturedAtFor,
  installFleetRoute,
  installDemoProviderSeedRoute,
  atomicRendererPrefInitScript,
  demoHandleSeedInitScript,
  perfSamplerInitScript,
  topologyUrl,
  waitForAtomicCanvas,
  ensureAuthenticated,
  samplePerf,
  captureCanvas,
} from "./lib/atomicDemo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE || "").replace(/\/+$/, "");
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || "";
const CHROME_PATH = process.env.CHROME_PATH || undefined;
const OUT_DIR = process.env.OUT_DIR || path.join(HERE, "..", "screenshots");
const SETTLE_MS = 9000; // > 2 poller cycles (3.5 s)

if (!BASE) throw new Error("BASE env is required");
if (!LOGIN_PASSWORD) throw new Error("LOGIN_PASSWORD env is required");

const logLines = [];
const log = (line) => {
  const s = `[${new Date().toISOString()}] ${line}`;
  logLines.push(s);
  console.log(s);
};

/** Expand the diagnostics panel if collapsed (rows only render expanded). */
async function ensurePanelExpanded(page) {
  const panel = page.locator(".atomic-telemetry-diagnostics");
  const btn = panel.locator("button").first();
  const aria = await btn.getAttribute("aria-expanded");
  if (aria === "false") {
    await btn.click();
    await page.waitForTimeout(200);
  }
}

/** Read all per-atom rows: {id, source}. */
async function readAtomRows(page) {
  return page.locator("[data-atomic-diag-atom]").evaluateAll((rows) =>
    rows.map((r) => ({
      id: r.getAttribute("data-atomic-diag-atom"),
      source: r.getAttribute("data-atomic-diag-source"),
    }))
  );
}

/** Read all route-link rows: {id, proven, text}. */
async function readLinkRows(page) {
  return page.locator("[data-atomic-diag-link]").evaluateAll((rows) =>
    rows.map((r) => ({
      id: r.getAttribute("data-atomic-diag-link"),
      proven: r.getAttribute("data-atomic-link-proven") === "true",
      text: r.textContent.trim(),
    }))
  );
}

/** The telemetry badge state (fresh/stale). */
async function badgeState(page) {
  const loc = page.locator("[data-atomic-telemetry-status]").first();
  if ((await loc.count()) === 0) return null;
  return loc.getAttribute("data-atomic-telemetry-status");
}

/** One scenario: mount, settle, collect diagnostics, return the row. */
async function captureScenario(browser, id, checks) {
  const capturedAt = capturedAtFor(id);
  const body = await buildFleetBody(id, capturedAt);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(atomicRendererPrefInitScript());
  await ctx.addInitScript(perfSamplerInitScript());
  await ctx.addInitScript(demoHandleSeedInitScript(), [id, capturedAt]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push("PAGEERROR: " + e.message.slice(0, 300)));

  const route = installFleetRoute(page, body);
  const seedRoute = installDemoProviderSeedRoute(page);
  const target = topologyUrl(id, { dev: true, demo: false, base: BASE });
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await ensureAuthenticated(page, LOGIN_PASSWORD, target);
  await waitForAtomicCanvas(page, 30_000);
  await page.waitForTimeout(SETTLE_MS);
  await ensurePanelExpanded(page);

  const row = {
    scenario: id,
    at: new Date().toISOString(),
    base: BASE,
    bodyCapturedAt: capturedAt,
    served: route.servedCount(),
    pageErrors,
  };

  const fleetCorroborates = body.reconciliation.providerNodes.some(
    (pn) => pn?.providerId === "demo-provider"
  );

  try {
    switch (id) {
      case "tps-80": {
        // P-1: admit once, dedupe within the window.
        const first = await page.evaluate(() => window.__atomicPulse("demo-provider"));
        const deduped = await page.evaluate(() => window.__atomicPulse("demo-provider"));
        checks["P-1 admit_then_deduped"] =
          Boolean(first?.ok && first?.reason === "admitted") &&
          Boolean(deduped?.ok === false && deduped?.reason === "deduped");
        // P-2: after the window, completion + failure are admitted.
        await page.waitForTimeout(300); // > 150 ms dedupe window
        const completion = await page.evaluate(() =>
          window.__atomicPulse("demo-provider", "request-completed")
        );
        await page.waitForTimeout(200);
        const failure = await page.evaluate(() =>
          window.__atomicPulse("demo-provider", "request-failed")
        );
        checks["P-2 kinds_admitted_after_window"] = completion?.ok === true && failure?.ok === true;
        // P-3: unproven provider rejected.
        const unproven = await page.evaluate(() =>
          window.__atomicPulse("definitely-not-a-provider")
        );
        checks["P-3 unproven_rejected"] = unproven?.ok === false;
        row.pulseResults = { first, deduped, completion, failure, unproven };
        log(`P-1 admit/dedup: first=${JSON.stringify(first)} deduped=${JSON.stringify(deduped)}`);
        log(
          `P-2 kinds: completion=${JSON.stringify(completion)} failure=${JSON.stringify(failure)}`
        );
        log(`P-3 unproven: ${JSON.stringify(unproven)}`);
        break;
      }
      case "multi-runtime-gpu": {
        const atomRows = await readAtomRows(page);
        const hasA = atomRows.some((a) => a.id?.includes("rt-demo-a"));
        const hasB = atomRows.some((a) => a.id?.includes("rt-demo-b"));
        const gpuA = atomRows.some((a) => a.id?.includes("dev-uuid-a"));
        const gpuB = atomRows.some((a) => a.id?.includes("dev-uuid-b"));
        checks["D-1 multi_runtime_atoms"] = hasA && hasB && gpuA && gpuB;
        row.atomRows = atomRows;
        log(
          `D-1 multi-runtime atoms: rt-a=${hasA} rt-b=${hasB} gpu-a=${gpuA} gpu-b=${gpuB} (rows=${atomRows.length})`
        );
        break;
      }
      case "mixed-lanes": {
        const linkRows = await readLinkRows(page);
        const provenRow = linkRows.find((l) => l.id === "route:demo-provider");
        // Provider-centric scenario → fleet corroboration → the STRONGEST basis.
        const expected = fleetCorroborates ? /call-log route \+ fleet-metrics/ : /call-log route/;
        checks["D-2 fleet_basis_proven"] = Boolean(
          provenRow &&
          provenRow.proven &&
          /PROVEN/.test(provenRow.text) &&
          expected.test(provenRow.text)
        );
        row.linkRows = linkRows;
        log(
          `D-2 fleet-basis proven row (fleetCorroborates=${fleetCorroborates}): ${checks["D-2 fleet_basis_proven"] ? "PASS" : "FAIL"} rows=${JSON.stringify(linkRows)}`
        );
        break;
      }
      case "unknown-stale": {
        const state = await badgeState(page);
        checks["D-3 stale_badge"] = state === "stale";
        row.badge = state;
        log(`D-3 stale badge: ${state === "stale" ? "PASS" : "FAIL"} (state=${state})`);
        break;
      }
      default:
        break;
    }
    row.verdict = true; // set below
  } catch (err) {
    row.error = String(err?.message ?? err).slice(0, 300);
    row.verdict = false;
    log(`scenario=${id} ERROR: ${row.error}`);
  } finally {
    await captureCanvas(page, path.join(OUT_DIR, `pulse-${id}.png`)).catch(() => {});
    await page.screenshot({ path: path.join(OUT_DIR, `pulse-${id}-full.png`) }).catch(() => {});
    await Promise.all([route.stop(), seedRoute.stop()]);
    await ctx.close();
  }
  return row;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
  });
  try {
    const checks = {};
    const rows = [];
    for (const id of ["tps-80", "multi-runtime-gpu", "mixed-lanes", "unknown-stale"]) {
      const row = await captureScenario(browser, id, checks);
      rows.push(row);
    }
    const verdict = Object.values(checks).every(Boolean) && rows.every((r) => r.verdict);
    const summary = {
      at: new Date().toISOString(),
      base: BASE,
      checks,
      rows: rows.map((r) => ({
        scenario: r.scenario,
        served: r.served,
        pageErrors: r.pageErrors,
        error: r.error,
        verdict: r.verdict,
      })),
      verdict,
    };
    fs.writeFileSync(path.join(OUT_DIR, "pulseDiagnostics.json"), JSON.stringify(summary, null, 2));
    log(`VERDICT pulseDiagnostics: ${verdict ? "PASS" : "FAIL"} checks=${JSON.stringify(checks)}`);
    process.exitCode = verdict ? 0 : 1;
  } finally {
    await browser.close();
  }
}

await main();
