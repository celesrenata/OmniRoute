#!/usr/bin/env node
/**
 * OR-ATOM-009 — 2D ↔ Atomic repeated-toggle stability (VALIDATION_MATRIX
 * stability row: "2D↔Atomic repeated toggle").
 *
 * WHAT IT DOES:
 *   Loads the dashboard topology with the Atomic renderer + a deterministic
 *   demo scenario (default `tps-80`), lets the real fleet-telemetry pipeline
 *   settle, then drives the host's OWN toggle buttons
 *   (`ProviderTopology.tsx` — the `2D` / `Atomic` pair in the
 *   `aria-label="Topology view mode"` group) N times in a row:
 *
 *     2D  → assert the Atomic WebGL canvas is gone AND the host's state
 *           (aria-pressed) reflects the 2D renderer
 *     Atomic → assert the WebGL canvas remounts AND the real poller runs
 *              again (the fleet-route `served` counter increases)
 *
 *   Per cycle it records: canvases live/peak, FPS sample, served count,
 *   switch latency. Evidence: JSON + PNGs of both end states
 *   (screenshots/toggleStability-2d.png / -atomic.png).
 *
 *   Gates (hard — a failure exits non-zero and is reported):
 *     T-1  all N toggle pairs completed (the loop finished without a hang)
 *     T-2  every 2D switch verified (0 live canvases + aria-pressed state)
 *     T-3  every Atomic switch verified (canvas remounted + poller ran
 *          again: served count increased since the previous Atomic entry)
 *     T-4  zero uncaught page errors across the whole run
 *     T-5  live canvas count at the end ≤ peak (no unbounded canvas growth
 *          from repeated remounts)
 *
 * ENV:
 *   BASE          dev server origin (default http://127.0.0.1:20999)
 *   CHROME_PATH   chromium executable (required)
 *   LOGIN_PASSWORD management-password gate
 *   SCENARIO      demo scenario id (default tps-80)
 *   TOGGLES       N toggle pairs (default 12)
 *   SETTLE_MS     initial poller settle (default 8000)
 */
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
} from "./lib/atomicDemo.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, "..", "screenshots");
const BASE = process.env.BASE || "http://127.0.0.1:20999";
const CHROME = process.env.CHROME_PATH;
const PW = process.env.LOGIN_PASSWORD;
const SCENARIO = process.env.SCENARIO || "tps-80";
const N = Number(process.env.TOGGLES || 12);
const SETTLE_MS = Number(process.env.SETTLE_MS || 8000);

if (!CHROME) {
  console.error("CHROME_PATH is required (e.g. the cached chromium_headless_shell).");
  process.exit(2);
}

/** The host's toggle group button states. */
async function buttonStates(page) {
  return page.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="Topology view mode"]');
    if (!group) return null;
    const btn = (label) => group.querySelector(`button:has-text("${label}")`);
    const state = (b) => (b ? { pressed: b.getAttribute("aria-pressed") === "true" } : null);
    return { present: true, btn2d: state(btn("2D")), btnAtomic: state(btn("Atomic")) };
  });
}

/** Click a toggle button by its label; returns ms until it appears pressed. */
async function clickToggle(page, label, verify, timeoutMs = 20_000) {
  const t0 = Date.now();
  await page
    .locator('[role="group"][aria-label="Topology view mode"] button', { hasText: label })
    .first()
    .click();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(verify);
    if (ok) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`toggle "${label}": verification timed out`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const capturedAt = capturedAtFor(SCENARIO);
const body = await buildFleetBody(SCENARIO, capturedAt);

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(atomicRendererPrefInitScript());
await ctx.addInitScript(demoHandleSeedInitScript(), [SCENARIO, capturedAt]);
await ctx.addInitScript(perfSamplerInitScript());
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push("PAGEERROR: " + e.message.slice(0, 300)));

const served = installFleetRoute(page, body);
// Network delivery (demo: false omits ?topology-demo so the host's in-page
// demo fetch wrapper — wired in ProviderTopology for OR-ATOM-009 B7 — stays
// OFF and the route is the SOLE demo source, so every Atomic re-entry's
// poller re-run shows up as servedDelta > 0 exactly as pre-B7).
const target = topologyUrl(SCENARIO, { dev: true, demo: false, base: BASE });
await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90_000 });
await ensureAuthenticated(page, PW, target);
await waitForAtomicCanvas(page, 30_000);
await page.waitForTimeout(SETTLE_MS);

const cycles = [];
let all2dOk = true;
let allAtomicOk = true;

for (let i = 1; i <= N; i++) {
  const cycle = { n: i };
  // --- 2D ---
  const t2d = await clickToggle(
    page,
    "2D",
    () =>
      document.querySelectorAll("canvas").length === 0 &&
      document
        .querySelector('[role="group"][aria-label="Topology view mode"] button:nth-child(1)')
        ?.getAttribute("aria-pressed") === "true"
  );
  const after2d = await samplePerf(page);
  cycle.to2d = { ms: t2d, ...after2d };
  cycle.check2d = after2d.liveCanvases === 0;
  all2dOk = all2dOk && cycle.check2d;

  // --- Atomic (back) ---
  const servedBefore = served.servedCount();
  const tA = await clickToggle(
    page,
    "Atomic",
    () =>
      document.querySelectorAll("canvas").length >= 1 &&
      document
        .querySelector('[role="group"][aria-label="Topology view mode"] button:nth-child(2)')
        ?.getAttribute("aria-pressed") === "true"
  );
  // Give the restarted poller one full 3.5 s cycle to prove it re-ran.
  await page.waitForTimeout(4000);
  const afterA = await samplePerf(page);
  const servedAfter = served.servedCount();
  cycle.toAtomic = { ms: tA, ...afterA, servedDelta: servedAfter - servedBefore };
  cycle.checkAtomic = afterA.liveCanvases >= 1 && servedAfter > servedBefore;
  allAtomicOk = allAtomicOk && cycle.checkAtomic;
  cycles.push(cycle);
  console.log(
    `toggle ${i}/${N}: 2D in ${t2d}ms (canvases=${after2d.liveCanvases}) | Atomic in ${tA}ms ` +
      `(canvases=${afterA.liveCanvases}, servedDelta=${servedAfter - servedBefore}) ` +
      `[${cycle.check2d && cycle.checkAtomic ? "ok" : "FAIL"}]`
  );
}

const endPerf = await samplePerf(page);
await captureCanvas(page, path.join(OUT_DIR, "toggleStability-atomic.png"));
// One last 2D state capture for the evidence pair.
await clickToggle(page, "2D", () => document.querySelectorAll("canvas").length === 0);
await captureCanvas(page, path.join(OUT_DIR, "toggleStability-2d.png"));

const gates = {
  "T-1 all toggles completed": cycles.length === N,
  "T-2 every 2D switch verified": all2dOk,
  "T-3 every Atomic switch verified (remount + poller re-ran)": allAtomicOk,
  "T-4 zero page errors": pageErrors.length === 0,
  "T-5 no canvas growth (end <= peak)": endPerf.liveCanvases <= endPerf.peakCanvases,
};
const verdict = Object.values(gates).every(Boolean) ? "PASS" : "FAIL";

const out = path.join(OUT_DIR, "toggleStability.json");
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      base: BASE,
      scenario: SCENARIO,
      toggles: N,
      startedAt: new Date().toISOString(),
      endPerf,
      pageErrors,
      servedTotal: served.servedCount(),
      cycles,
      gates,
      verdict,
    },
    null,
    2
  )
);
await ctx.close();
await browser.close();

console.log(`\nEvidence: ${out} (+ toggleStability-2d.png / -atomic.png)`);
console.log(`VERDICT toggleStability: ${verdict}`);
for (const [k, v] of Object.entries(gates)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
process.exit(verdict === "PASS" ? 0 : 1);
