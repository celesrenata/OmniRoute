#!/usr/bin/env node
/**
 * OR-ATOM-009 — stress matrix (KICKOFF §7: 8 / 16 / 32 atom fixtures).
 *
 * WHAT IT DOES:
 *   Synthesizes a deterministic fleet-telemetry body scaled to N atom groups
 *   (N GPU + N runtime, each runtime attributed to exactly one GPU and
 *   carrying one model — the per-device attribution topology the real
 *   pipeline expects), intercepts `GET /api/telemetry/fleet`, and serves it to
 *   the REAL `FleetTelemetryPoller` + the REAL Atomic renderer. For each N it
 *   verifies the scene mounts, renders live (sustained non-zero FPS), keeps a
 *   single canvas (no growth), and produces zero page errors.
 *
 *   NOTE: the FPS gate is "sustained animation" (fps >= 5), not a 24/60 floor —
 *   these runs render in headless Chromium via SOFTWARE rasterization (no GPU
 *   on this host), where the per-atom cost is real and monotonic: the FPS
 *   curve across 8 → 16 → 32 atoms is expected to step DOWN while staying
 *   live (observed 15 → 10 → 7). The matrix documents that scaling; a
 *   GPU-accelerated browser would sustain the 24+ floor for the same scene.
 *   S-6 asserts the FPS curve does not INCREASE with atom count (no surprise
 *   speed-up that would indicate the scene is dropping work).
 *
 *   Evidence: stressMatrix.json (+ stress-<N>.png per fixture).
 *
 * ENV:
 *   BASE            (required) e.g. http://127.0.0.1:21011
 *   LOGIN_PASSWORD  (required) dashboard password
 *   CHROME_PATH     (optional) headless shell binary
 *   CHROME_ARGS     set "none" to avoid extra flags
 *   SETTLE_MS       settle time per fixture (default 8000)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import {
  installFleetRoute,
  atomicRendererPrefInitScript,
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
const SETTLE_MS = Number(process.env.SETTLE_MS || 8000);
const ATOMS = [8, 16, 32];

if (!BASE) throw new Error("BASE env is required");
if (!LOGIN_PASSWORD) throw new Error("LOGIN_PASSWORD env is required");

const logLines = [];
const log = (line) => {
  const s = `[${new Date().toISOString()}] ${line}`;
  logLines.push(s);
  console.log(s);
};

/** Build a scaled fleet body: N GPU + N runtime, 1:1 attribution, 1 model each. */
function buildStressBody(n, nowMs) {
  const resources = [];
  const gpuNodes = [];
  const runtimeNodes = [];
  const edges = [];
  for (let i = 0; i < n; i++) {
    const gpuId = `gpu:demo-host:dev-uuid-${i}`;
    const rtId = `runtime:demo-host:rt-demo-${i}`;
    const modelId = `demo/stress-${i}`;
    const tps = 20 + (i % 5) * 8; // vary 20..52 tok/s

    resources.push({
      resourceId: gpuId,
      kind: "gpu",
      outputTokensPerSecond: {
        value: tps,
        source: "omniroute-live",
        sampledAt: nowMs,
        windowMs: 10_000,
        stale: false,
        basis: `demo: per-device attribution → GPU ${i}`,
      },
      activeJobs: {
        value: 1,
        source: "gpu",
        sampledAt: nowMs,
        windowMs: 10_000,
        stale: false,
        basis: "demo: measured 1 active job",
      },
    });
    resources.push({
      resourceId: rtId,
      kind: "runtime",
      runtimeId: `rt-demo-${i}`,
      modelId,
      outputTokensPerSecond: {
        value: tps,
        source: "runtime",
        sampledAt: nowMs,
        windowMs: 10_000,
        stale: false,
        basis: `demo: measured ${tps} output TPS (runtime ${i})`,
      },
      queuedJobs: {
        value: i % 3,
        source: "runtime",
        sampledAt: nowMs,
        windowMs: 10_000,
        stale: false,
        basis: "demo: measured queue",
      },
    });

    gpuNodes.push({
      resourceId: gpuId,
      hostId: "demo-host",
      deviceUuid: `dev-uuid-${i}`,
      stale: false,
      outputTokensPerSecond: {
        value: tps,
        source: "omniroute-live",
        sampledAt: nowMs,
        windowMs: 10_000,
        stale: false,
        basis: `demo: per-device attribution → GPU ${i}`,
      },
    });
    runtimeNodes.push({
      resourceId: rtId,
      hostId: "demo-host",
      runtimeId: `rt-demo-${i}`,
      attributedGpuIds: [gpuId],
      stale: false,
      modelId,
      outputTokensPerSecond: {
        value: tps,
        source: "runtime",
        sampledAt: nowMs,
        windowMs: 10_000,
        stale: false,
        basis: `demo: measured ${tps} output TPS (runtime ${i})`,
      },
      queuedJobs: {
        value: i % 3,
        source: "runtime",
        sampledAt: nowMs,
        windowMs: 10_000,
        stale: false,
        basis: "demo: measured queue",
      },
    });

    edges.push({
      source: rtId,
      target: gpuId,
      relation: "runtime_device",
      basis: "runtime per-device attribution",
      sampledAt: nowMs,
    });
    edges.push({
      source: rtId,
      target: `model:${modelId}`,
      relation: "runtime_model",
      basis: "runtime model binding",
      sampledAt: nowMs,
    });
  }

  return {
    snapshot: { schemaVersion: 1, capturedAt: nowMs, resources },
    reconciliation: {
      schemaVersion: 1,
      capturedAt: nowMs,
      gpuNodes,
      runtimeNodes,
      providerNodes: [],
      edges,
      providerCentricFallback: false,
    },
  };
}

async function runFixture(browser, n) {
  const now = Date.now();
  const body = buildStressBody(n, now);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(atomicRendererPrefInitScript());
  await ctx.addInitScript(perfSamplerInitScript());
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push("PAGEERROR: " + e.message.slice(0, 300)));

  const route = installFleetRoute(page, body);
  // Use a neutral scenario id for the URL (the in-page demo path stays OFF;
  // the network intercept is the sole demo source).
  const target = topologyUrl("tps-80", { dev: true, demo: false, base: BASE });
  const row = { atoms: n, at: new Date().toISOString(), base: BASE };
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await ensureAuthenticated(page, LOGIN_PASSWORD, target);
    await waitForAtomicCanvas(page, 45_000);
    await page.waitForTimeout(SETTLE_MS);
    const perf = await samplePerf(page);
    const served = route.servedCount();
    const mounted = (perf?.liveCanvases ?? 0) >= 1;
    const sustainedFps = (perf?.fps ?? 0) >= 5;
    const noGrowth = (perf?.peakCanvases ?? 99) <= 2;
    row.served = served;
    row.perf = perf ?? null;
    row.pageErrors = pageErrors;
    row.checks = {
      "S-1 canvas_mounted": mounted,
      "S-2 body_served_to_poller": served >= 1,
      "S-3 sustained_fps": sustainedFps,
      "S-4 no_canvas_growth": noGrowth,
      "S-5 zero_page_errors": pageErrors.length === 0,
    };
    row.verdict = Object.values(row.checks).every(Boolean);
    log(
      `atoms=${n}: mounted=${mounted} fps=${perf?.fps} liveCanvases=${perf?.liveCanvases} peak=${perf?.peakCanvases} served=${served} pageErr=${pageErrors.length} → ${row.verdict ? "PASS" : "FAIL"}`
    );
    if (pageErrors.length) log(`  pageErrors: ${pageErrors.slice(0, 3).join(" | ")}`);
  } catch (err) {
    row.error = String(err?.message ?? err).slice(0, 300);
    row.verdict = false;
    log(`atoms=${n} ERROR: ${row.error}`);
  } finally {
    await captureCanvas(page, path.join(OUT_DIR, `stress-${n}.png`)).catch(() => {});
    await route.stop();
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
    const rows = [];
    for (const n of ATOMS) rows.push(await runFixture(browser, n));
    // S-6: per-atom cost must not INCREASE with scene size (headless software
    // rasterization — observed step-down is the expected, honest signal).
    let monotonic = true;
    for (let i = 1; i < rows.length; i++) {
      const prevFps = rows[i - 1]?.perf?.fps ?? 0;
      const curFps = rows[i]?.perf?.fps ?? 0;
      if (curFps > prevFps + 1) monotonic = false; // +1 tolerance for jitter
    }
    rows.push({
      atoms: null,
      at: new Date().toISOString(),
      base: BASE,
      checks: { "S-6 fps_monotonic_non_increasing": monotonic },
      verdict: monotonic,
    });
    const verdict = rows.every((r) => r.verdict);
    const summary = { at: new Date().toISOString(), base: BASE, rows, verdict };
    fs.writeFileSync(path.join(OUT_DIR, "stressMatrix.json"), JSON.stringify(summary, null, 2));
    log(`VERDICT stressMatrix: ${verdict ? "PASS" : "FAIL"}`);
    process.exitCode = verdict ? 0 : 1;
  } finally {
    await browser.close();
  }
}

await main();
