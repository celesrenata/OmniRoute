#!/usr/bin/env node
/**
 * benchmark-atomic-topology.mjs — S6 atom-scaling performance harness.
 *
 * WHAT IT MEASURES
 *   Drives the REAL Atomic topology renderer (createAtomicTopologyInstance,
 *   src/plugins/atomic-topology/AtomicTopologyRenderer.tsx) with SYNTHETIC
 *   TopologySceneSnapshot payloads of 8/16/32/50 provider atoms
 *   (shape: src/shared/topology/domain/types.ts) and samples, per size,
 *   requestAnimationFrame frame deltas and the active WebGL2 context count
 *   (in-page canvas probe) over a fixed window.
 *
 * HOW THE REAL SCENE REACHES THE BROWSER
 *   The dashboard is only used as an origin (so we know the atomic-topology
 *   plugin view is present: the "Provider Topology" heading,
 *   src/app/(dashboard)/dashboard/HomeProviderTopologySection.tsx). The
 *   measured scene is a synthetic container on the same page: the renderer
 *   entry is bundled ONCE with esbuild (no code splitting — the dynamic
 *   `import("./scene/AtomicScene")` at AtomicTopologyRenderer.tsx inlines
 *   into one IIFE that exposes the public instance API) and injected via
 *   <script>. The scene renders only when a WebGL2 canvas exists
 *   (`.atomic-scene-canvas canvas`), so the harness waits for that before
 *   measuring. Headless Chromium needs SwiftShader args (same as
 *   scripts/ad-hoc/or-atom-003-screenshot.mjs).
 *
 *   Synthetic snapshot shape (every field traced, none invented):
 *     TopologySceneSnapshot { schemaVersion: 1, capturedAt, nodes, links,
 *       fleetTelemetry? } — src/shared/topology/domain/types.ts
 *     TopologySceneNode { id, kind, label, providerId?, health, traffic }
 *     TopologySceneLink { id, source, target, kind: "route", health, traffic }
 *     ids follow src/shared/topology/domain/layoutIdentity.ts
 *       (HUB_NODE_ID = "hub", providerNodeId -> "provider:<id>",
 *        providerRouteLinkId -> "route:<id>").
 *     `fleetTelemetry` carries the empty ReconciliationResult shape
 *     (gpuNodes/runtimeNodes/providerNodes/edges, providerCentricFallback)
 *     from src/shared/topology/telemetry/reconcile.ts so the device-band
 *     path is exercised without fabricating any device fact.
 *
 * USAGE
 *   node scripts/ad-hoc/benchmark-atomic-topology.mjs [flags]
 *
 *   Flags:
 *     --size N          repeat a single atom size (default: 8 16 32 50)
 *     --window-s N     measurement window per size in seconds (default: 30)
 *     --warmup-s N     warm-up after each update() before sampling (default: 3)
 *     --card-timeout-ms N  timeout for the dashboard "Provider Topology"
 *                          card (default: 20000)
 *     --out DIR        output root (default: <repo>/_cache/atomic-bench)
 *     --headful        run the browser headful
 *     --help           show this header
 *
 *   Env:
 *     OMNIROUTE_DASH_URL          dashboard origin to read (default
 *                                 http://localhost:20128)
 *     OMNIROUTE_ATOM_SIZES        comma list of sizes (default "8,16,32,50")
 *     OMNIROUTE_ATOM_WINDOW_S     window seconds (default 30)
 *     OMNIROUTE_ATOM_WARMUP_S     warm-up seconds (default 3)
 *     OMNIROUTE_BENCH_OUT_DIR    same as --out
 *
 *   Output (private gitignored root — `_cache/` per .gitignore):
 *     <out>/<YYYYMMDD-HHMMSS>/benchmark.json       aggregate report
 *     <out>/<YYYYMMDD-HHMMSS>/bench-<n>atoms.json  per-size stats
 *     <out>/<YYYYMMDD-HHMMSS>/bench-<n>atoms.csv   per-size time series
 *     <out>/<YYYYMMDD-HHMMSS>/harness-bundle.js   the esbuild bundle
 *
 *   Per-size metrics: p50/p95/p99 frame time, dropped-frame ratio
 *   (delta > 100 ms; fixed threshold — no per-size tuning), active
 *   WebGL2 context count time series (sampled every 100 ms).
 *
 * EXIT CODES
 *   0  all sizes measured, reports written
 *   1  invalid arguments / esbuild bundle failed
 *   2  dashboard unreachable (OMNIROUTE_DASH_URL) — nothing measured
 *   3  atomic-topology plugin view absent (no "Provider Topology" heading)
 *   4  WebGL2 canvas never appeared for a measured size (scene not active)
 *   5  renderer instance failed to mount
 *
 * HONESTY CONTRACT: this script NEVER fabricates numbers. If the dashboard
 * is unreachable, the plugin view is absent, WebGL2 never activates, or the
 * bundle fails, it exits non-zero with an explicit verdict. Live verification
 * is currently a documented EXTERNAL BLOCKER (no reachable fleet backend;
 * the local process at 127.0.0.1:20128 predates the fleet route) — this
 * script is authored and syntax-validated only; do not treat a missing
 * dashboard as a measurement.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { chromium } from "playwright";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DASH_URL = process.env.OMNIROUTE_DASH_URL || "http://localhost:20128";
const DEFAULT_SIZES = "8,16,32,50";
const DEFAULT_WINDOW_S = "30";
const DEFAULT_WARMUP_S = "3";
const DEFAULT_CARD_TIMEOUT_MS = 20_000;
const DEFAULT_CTX_SAMPLE_MS = 100; // WebGL context probe cadence
const DROPPED_FRAME_MS = 100; // delta above this counts as a dropped frame

const REPO_ROOT = dirname(dirname(dirname(process.argv[1] ?? ".")));
const OUT_ROOT = process.env.OMNIROUTE_BENCH_OUT_DIR || join(REPO_ROOT, "_cache", "atomic-bench");

// Renderer preference key — mirrors src/shared/topology/renderer/registry.ts
// (TOPOLOGY_RENDERER_PREF_KEY) so the dashboard's own panel, when present,
// uses the atomic renderer during the run.
const TOPOLOGY_RENDERER_PREF_KEY = "omniroute.topology.renderer";
const ATOMIC_RENDERER_ID = "atomic";

// Headless Chromium needs SwiftShader for WebGL2 (same args as
// scripts/ad-hoc/or-atom-003-screenshot.mjs).
const WEBGL_LAUNCH_ARGS = ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];

function fail(code, verdict, detail = "") {
  console.error(`[bench] EXIT ${code}: ${verdict}`);
  if (detail) console.error(`[bench]   ${detail}`);
  process.exit(code);
}

function parseArgs(argv) {
  const a = {
    sizes: [],
    windowS: Number(process.env.OMNIROUTE_ATOM_WINDOW_S || DEFAULT_WINDOW_S),
    warmupS: Number(process.env.OMNIROUTE_ATOM_WARMUP_S || DEFAULT_WARMUP_S),
    cardTimeoutMs: Number(process.env.OMNIROUTE_ATOM_CARD_TIMEOUT_MS || DEFAULT_CARD_TIMEOUT_MS),
    out: process.env.OMNIROUTE_BENCH_OUT_DIR || OUT_ROOT,
    headful: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log("see the usage header block at the top of this file");
      process.exit(0);
    } else if (arg === "--size") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) fail(1, "invalid --size", `got ${argv[i]}`);
      a.sizes.push(v);
    } else if (arg === "--window-s") {
      a.windowS = Number(argv[++i]);
    } else if (arg === "--warmup-s") {
      a.warmupS = Number(argv[++i]);
    } else if (arg === "--card-timeout-ms") {
      a.cardTimeoutMs = Number(argv[++i]);
    } else if (arg === "--out") {
      a.out = argv[++i];
    } else if (arg === "--headful") {
      a.headful = true;
    } else {
      fail(1, `unknown argument: ${arg}`);
    }
  }
  if (a.sizes.length === 0) {
    a.sizes = String(process.env.OMNIROUTE_ATOM_SIZES || DEFAULT_SIZES)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1);
  }
  if (!Number.isFinite(a.windowS) || a.windowS <= 0) fail(1, "invalid window seconds");
  if (!Number.isFinite(a.warmupS) || a.warmupS < 0) fail(1, "invalid warmup seconds");
  if (a.sizes.length === 0) fail(1, "no valid atom sizes");
  return a;
}

// ---------------------------------------------------------------------------
// Synthetic snapshot (real types only — see header for citations)
// ---------------------------------------------------------------------------

/**
 * Build a renderer-neutral TopologySceneSnapshot with N provider atoms.
 * Field names come from src/shared/topology/domain/types.ts and
 * src/shared/topology/telemetry/reconcile.ts; nothing here is invented.
 */
function syntheticSnapshot(atomCount) {
  const now = Date.now();
  const nodes = [
    {
      id: "hub",
      kind: "hub",
      label: "OmniRoute",
      health: "unknown",
      traffic: "idle",
    },
  ];
  const links = [];
  for (let i = 1; i <= atomCount; i += 1) {
    const pid = `bench-provider-${i}`;
    nodes.push({
      id: `provider:${pid}`,
      kind: "provider",
      label: pid,
      providerId: pid,
      health: "healthy",
      traffic: "idle",
    });
    links.push({
      id: `route:${pid}`,
      source: "hub",
      target: `provider:${pid}`,
      kind: "route",
      health: "healthy",
      traffic: "idle",
    });
  }
  return {
    schemaVersion: 1,
    capturedAt: now,
    nodes,
    links,
    // Empty device band: no GPU/runtime/provider device facts are fabricated;
    // the renderer must treat this as "provider-centric fallback".
    fleetTelemetry: {
      schemaVersion: 1,
      capturedAt: now,
      gpuNodes: [],
      runtimeNodes: [],
      providerNodes: [],
      edges: [],
      providerCentricFallback: true,
    },
  };
}

// ---------------------------------------------------------------------------
// esbuild harness bundle (real renderer entry, single IIFE, no splitting)
// ---------------------------------------------------------------------------

function buildHarnessBundle(outDir) {
  const entryPath = join(outDir, "harness-entry.ts");
  const bundlePath = join(outDir, "harness-bundle.js");
  const rendererEntry = join(REPO_ROOT, "src/plugins/atomic-topology/AtomicTopologyRenderer.tsx");
  if (!existsSync(rendererEntry)) {
    fail(1, "renderer entry not found", rendererEntry);
  }
  writeFileSync(
    entryPath,
    [
      "// Auto-generated by benchmark-atomic-topology.mjs — re-exports the",
      "// real renderer public instance API as a single IIFE global.",
      `export { createAtomicTopologyInstance, mountAtomicTopologyRenderer } from "${rendererEntry}";`,
      "",
    ].join("\n")
  );
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, "node_modules", "esbuild", "bin", "esbuild"),
        entryPath,
        "--bundle",
        "--format=iife",
        "--global-name=__OR_ATOM_BENCH__",
        `--outfile=${bundlePath}`,
        "--jsx=automatic",
        `--tsconfig=${join(REPO_ROOT, "tsconfig.json")}`,
        "--log-level=error",
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err) {
    fail(
      1,
      "esbuild harness bundle failed",
      err && err.stderr ? String(err.stderr).slice(-2000) : String(err)
    );
  }
  if (!existsSync(bundlePath)) fail(1, "esbuild produced no bundle", bundlePath);
  return bundlePath;
}

// ---------------------------------------------------------------------------
// In-page measurement helpers (stringified into the browser page)
// ---------------------------------------------------------------------------

/**
 * Measure frame deltas + active-context time series over windowMs.
 * Runs entirely in-page: rAF deltas, context probe every ~100 ms.
 * (The whole closure is serialized by Playwright; only plain values may be
 * passed as the second argument.)
 */
function measureInPage(page, windowMs, ctxSampleMs) {
  return page.evaluate(
    async ({ windowMs, ctxSampleMs }) => {
      const ctxCount = () => {
        let n = 0;
        for (const c of document.querySelectorAll("canvas")) {
          for (const t of ["webgl2", "webgl"]) {
            let ctx = null;
            try {
              ctx = c.getContext(t);
            } catch {
              ctx = null;
            }
            if (ctx) {
              n += 1;
              break;
            }
          }
        }
        return n;
      };
      const deltas = [];
      const ctxSeries = [];
      const first = performance.now();
      let prev = first;
      let nextCtx = first;
      await new Promise((resolve) => {
        const onFrame = (t) => {
          deltas.push(t - prev);
          prev = t;
          if (t >= nextCtx) {
            ctxSeries.push({ t: Math.round(t - first), activeWebglContexts: ctxCount() });
            nextCtx = t + ctxSampleMs;
          }
          if (t - first >= windowMs) {
            resolve();
            return;
          }
          requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);
      });
      return { deltas, ctxSeries };
    },
    { windowMs, ctxSampleMs }
  );
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1)))
  );
  return sorted[rank];
}

function summarizeSize(n, deltas, ctxSeries) {
  const sorted = [...deltas].sort((x, y) => x - y);
  const dropped = deltas.filter((d) => d > DROPPED_FRAME_MS).length;
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
  return {
    atoms: n,
    framesSampled: sorted.length,
    measuredMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) : null,
    frameMs: {
      min: sorted.length ? sorted[0] : null,
      max: sorted.length ? sorted[sorted.length - 1] : null,
      mean,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    },
    droppedFrameRatio: sorted.length ? dropped / sorted.length : null,
    droppedFrames: dropped,
    droppedThresholdMs: DROPPED_FRAME_MS,
    webgl2Contexts: ctxSeries.length
      ? {
          min: Math.min(...ctxSeries.map((s) => s.activeWebglContexts)),
          max: Math.max(...ctxSeries.map((s) => s.activeWebglContexts)),
          samples: ctxSeries.length,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(args.out, stamp);
  mkdirSync(outDir, { recursive: true });
  console.log(
    `[bench] dash=${DASH_URL} sizes=[${args.sizes.join(",")}] window=${args.windowS}s out=${outDir}`
  );

  const bundlePath = buildHarnessBundle(outDir);
  console.log(`[bench] harness bundle ok (${bundlePath})`);

  const browser = await chromium
    .launch({ headless: !args.headful, args: WEBGL_LAUNCH_ARGS })
    .catch(async (err) => {
      fail(2, "browser launch failed", String(err));
    });

  const results = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1596, height: 1050 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(args.cardTimeoutMs);

    let navigated = false;
    try {
      await page.goto(DASH_URL, { waitUntil: "domcontentloaded", timeout: args.cardTimeoutMs });
      navigated = true;
    } catch (err) {
      fail(
        2,
        "DASHBOARD UNREACHABLE",
        `GET ${DASH_URL} failed (${String(err).split("\n")[0]}) — EXTERNAL BLOCKER: no reachable fleet backend. No numbers are reported.`
      );
    }
    if (!navigated) fail(2, "DASHBOARD UNREACHABLE", "navigation did not complete");

    // Plugin view present? The home page's "Provider Topology" card heading
    // (HomeProviderTopologySection.tsx) is the stable, locale-free enough
    // anchor used by the existing or-atom-003 screenshot script.
    const heading = page.locator("h2", { hasText: "Provider Topology" }).first();
    try {
      await heading.waitFor({ state: "visible", timeout: args.cardTimeoutMs });
    } catch {
      fail(
        3,
        "ATOMIC-TOPOLLOGY PLUGIN VIEW ABSENT",
        'no visible <h2>"Provider Topology"</h2> card on the dashboard home — the topology panel (and therefore the atomic renderer it hosts) is not present. No numbers are reported.'
      );
    }
    console.log("[bench] plugin view present (Provider Topology card visible)");

    // Seed the renderer preference so the dashboard's own panel, if it
    // mounts, uses the atomic renderer (registry.ts pref key).
    await page
      .evaluate(
        ([k, v]) => {
          try {
            window.localStorage.setItem(k, v);
          } catch {
            /* non-fatal: the synthetic scene below is independent */
          }
        },
        [TOPOLOGY_RENDERER_PREF_KEY, ATOMIC_RENDERER_ID]
      )
      .catch(() => {});

    // Inject the harness bundle (same-origin dashboard page, CSP allows
    // inline scripts per next.config.mjs script-src).
    const bundleSrc = readFileSync(bundlePath, "utf8");
    await page.addScriptTag({ content: bundleSrc });
    const apiOk = await page.evaluate(
      () =>
        typeof window.__OR_ATOM_BENCH__?.createAtomicTopologyInstance === "function" &&
        typeof window.__OR_ATOM_BENCH__?.mountAtomicTopologyRenderer === "function"
    );
    if (!apiOk) fail(1, "harness bundle did not expose the renderer API");
    console.log("[bench] renderer instance API available in page");

    // Synthetic scene container (offscreen so it does not disturb the UI).
    await page.evaluate(() => {
      const el = document.createElement("div");
      el.id = "or-bench-atomic-scene";
      Object.assign(el.style, {
        position: "fixed",
        left: "-3000px",
        top: "0",
        width: "1024px",
        height: "768px",
        zIndex: "-1",
        background: "#000",
      });
      document.body.appendChild(el);
    });

    const instanceReady = await page.evaluate(() => {
      try {
        const el = document.getElementById("or-bench-atomic-scene");
        if (!el) return "no-container";
        const snap = {
          schemaVersion: 1,
          capturedAt: Date.now(),
          nodes: [
            { id: "hub", kind: "hub", label: "OmniRoute", health: "unknown", traffic: "idle" },
          ],
          links: [],
        };
        const inst = window.__OR_ATOM_BENCH__.createAtomicTopologyInstance(el, snap, {});
        window.__OR_BENCH_INSTANCE__ = inst;
        try {
          inst.resize(1024, 768);
          inst.setPaused(false);
        } catch {
          /* no-op paths are documented on the instance contract */
        }
        return inst && typeof inst.update === "function" ? "ok" : "bad-instance";
      } catch (err) {
        return `error: ${String(err)}`;
      }
    });
    if (instanceReady !== "ok") fail(5, "renderer instance failed to mount", String(instanceReady));
    console.log("[bench] synthetic scene instance mounted");

    const windowMs = Math.round(args.windowS * 1000);
    const warmupMs = Math.round(args.warmupS * 1000);

    for (const n of args.sizes) {
      console.log(`[bench] measuring ${n} atoms over ${args.windowS}s ...`);
      // The snapshot is built in Node (single source of truth for the
      // payload shape) and serialized into the page as a plain value.
      const snap = syntheticSnapshot(n);
      await page.evaluate((s) => {
        window.__OR_BENCH_INSTANCE__.update(s);
      }, snap);

      // Wait for the WebGL2 canvas to (re)appear and be drawing.
      const canvas = page.locator(".atomic-scene-canvas canvas").first();
      let canvasUp = false;
      try {
        await canvas.waitFor({ state: "attached", timeout: args.cardTimeoutMs });
        await page.waitForFunction(
          () => {
            const c = document.querySelector(".atomic-scene-canvas canvas");
            if (!c) return false;
            const ctx = c.getContext("webgl2") || c.getContext("webgl");
            return Boolean(ctx);
          },
          { timeout: args.cardTimeoutMs }
        );
        canvasUp = true;
      } catch {
        fail(
          4,
          "WEBGL2 SCENE NEVER ACTIVATED",
          `no .atomic-scene-canvas canvas with a live WebGL context after mounting ${n} atoms — the 3D scene is not running (headless needs the SwiftShader args; the host silently falls back to the empty-state DOM). No numbers are reported for this size.`
        );
      }
      if (!canvasUp) fail(4, "WEBGL2 SCENE NEVER ACTIVATED", "canvas wait failed");

      await page.waitForTimeout(warmupMs);
      const { deltas, ctxSeries } = await measureInPage(page, windowMs, DEFAULT_CTX_SAMPLE_MS);
      if (!deltas.length)
        fail(4, "NO FRAMES SAMPLED", `rAF produced no deltas over ${args.windowS}s`);

      const stats = summarizeSize(n, deltas, ctxSeries);
      results.push(stats);
      writeFileSync(
        join(outDir, `bench-${n}atoms.json`),
        JSON.stringify({ atoms: n, deltas, ctxSeries, stats }, null, 2) + "\n"
      );
      const csvRows = ["seq,t_ms,frame_delta_ms,dropped,active_webgl2_contexts"];
      deltas.forEach((d, i) => {
        const c = ctxSeries.length
          ? ctxSeries[
              Math.min(ctxSeries.length - 1, Math.floor((i / deltas.length) * ctxSeries.length))
            ].activeWebglContexts
          : 0;
        csvRows.push(
          `${i},${(i * (windowMs / deltas.length)).toFixed(0)},${d.toFixed(2)},${d > DROPPED_FRAME_MS ? 1 : 0},${c}`
        );
      });
      writeFileSync(join(outDir, `bench-${n}atoms.csv`), csvRows.join("\n") + "\n");
      console.log(
        `[bench] ${n} atoms: p50=${stats.frameMs.p50?.toFixed(2)}ms p95=${stats.frameMs.p95?.toFixed(2)}ms p99=${stats.frameMs.p99?.toFixed(2)}ms dropped=${stats.droppedFrameRatio} ctx=[${stats.webgl2Contexts?.min}-${stats.webgl2Contexts?.max}]`
      );
    }

    await page
      .evaluate(() => {
        try {
          window.__OR_BENCH_INSTANCE__?.dispose();
          document.getElementById("or-bench-atomic-scene")?.remove();
        } catch {
          /* teardown best-effort */
        }
      })
      .catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dashboardUrl: DASH_URL,
    sizes: args.sizes,
    windowSeconds: args.windowS,
    warmupSeconds: args.warmupS,
    droppedFrameThresholdMs: DROPPED_FRAME_MS,
    results,
    notes: [
      "Frame deltas are rAF-to-rAF wall time on the benchmark host (SwiftShader in headless mode).",
      "Active WebGL context count probes every canvas for a live webgl2/webgl context.",
      "Synthetic snapshots carry empty reconciliation device bands — no GPU/runtime facts are fabricated.",
    ],
  };
  writeFileSync(join(outDir, "benchmark.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`[bench] done -> ${join(outDir, "benchmark.json")}`);
}

main().catch((err) => {
  fail(1, "unexpected error", String(err && err.stack ? err.stack : err));
});
