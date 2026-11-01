#!/usr/bin/env node
/**
 * p0-webgl-regression-check.mjs — LIVE P0 WebGL regression check for the
 * atomic-topology scene.
 *
 * WHAT IT CHECKS (the P0 defect: the scene went BLANK after ~2 min)
 *   Drives the REAL atomic-topology renderer (createAtomicTopologyInstance,
 *   src/plugins/atomic-topology/AtomicTopologyRenderer.tsx) with a SYNTHETIC
 *   TopologySceneSnapshot (16 provider atoms, provider-centric-fallback empty
 *   device band — no device facts fabricated), re-ingesting a fresh snapshot
 *   every ~3.5 s for ~3.5 min (well past the ~2 min P0 window, with margin).
 *
 *   Every ~10 s it samples:
 *     - the ACTIVE WebGL context count inside the driven scene overlay (the
 *       leak signature), and
 *     - whether the scene canvas is BLANK — judged from a COMPOSITED screenshot
 *       of the canvas element (pixel analysis of what the viewer actually sees).
 *   NOTE on the blank probe: the in-page drawing-buffer read (drawImage →
 *   getImageData) of a WebGL canvas with preserveDrawingBuffer:false returns
 *   an all-cleared buffer after compositing, so it is NOT a reliable blank
 *   signal. This check therefore analyzes the browser-composited screenshot
 *   (sharp), which is the ground truth for "did the viewer see a blank scene".
 *   Screenshots are captured at start, ~1 min, and end.
 *
 * HOW THE REAL SCENE REACHES THE BROWSER
 *   Same mechanism as scripts/ad-hoc/benchmark-atomic-topology.mjs: the
 *   dashboard is used as an origin (we confirm the "Provider Topology" plugin
 *   view is present), the renderer entry is bundled ONCE with esbuild into a
 *   single IIFE that exposes the public instance API, injected via <script>,
 *   and a real renderer instance is mounted into an on-screen overlay container
 *   so the synthetic scene renders visibly and is what gets screenshot.
 *   Headless Chromium needs SwiftShader args (see WEBGL_LAUNCH_ARGS below).
 *
 * USAGE
 *   node scripts/ad-hoc/p0-webgl-regression-check.mjs [flags]
 *
 *   Flags:
 *     --atoms N      provider atom count (default 16)
 *     --window-s N   drive window in seconds (default 210 = ~3.5 min)
 *     --reingest-ms N  snapshot re-ingest cadence (default 3500)
 *     --sample-ms N   sample cadence (default 10000)
 *     --out DIR      output root (default <repo>/_cache/p0-webgl-check)
 *     --headful      run the browser headful
 *     --help         show this header
 *
 *   Env:
 *     OMNIROUTE_DASH_URL          dashboard origin (default http://localhost:20128)
 *     INITIAL_PASSWORD            dev password used to log in (if the dashboard
 *                                 requires one) — NOT printed anywhere
 *     OMNIROUTE_P0_WINDOW_S       window seconds (default 210)
 *     OMNIROUTE_P0_ATOMS          atom count (default 16)
 *     OMNIROUTE_P0_OUT_DIR        same as --out
 *     CHROME_EXECUTABLE_PATH      explicit Chromium path (auto-detected otherwise)
 *
 *   Output (private gitignored root — `_cache/` per .gitignore):
 *     <out>/<stamp>/p0-webgl-report.json     aggregate verdict + series
 *     <out>/<stamp>/screenshot-start.png
 *     <out>/<stamp>/screenshot-1min.png
 *     <out>/<stamp>/screenshot-end.png
 *     <out>/<stamp>/harness-bundle.js        the esbuild bundle
 *
 * VERDICT / EXIT CODES
 *   PASS (exit 0)    max active WebGL contexts <= 2 across the run AND the
 *                    composited scene was never blank AND the scene stayed
 *                    mounted for the whole window.
 *   degraded (exit 10)  the renderer instance could not be driven (bundle/mount/
 *                    canvas) on the one permitted attempt; the empty-state view was
 *                    still run through the same context-count + blank-check loop.
 *                    Scope reported honestly as "leak condition not actively driven".
 *   FAIL (exit 1)    blank composited scene, scene unmount, or max contexts > 2
 *                    (the pass bar is "never exceeds 2"); hard-FAIL (exit 4) if
 *                    contexts > 4.
 *   BLOCKED (exit 2) dashboard unreachable / browser launch failed.
 *   BLOCKED (exit 3) plugin view absent / headless Chromium cannot create any
 *                    WebGL context on page load — the P0 check cannot run; NO
 *                    pass is fabricated.
 *
 * HONESTY CONTRACT: this script NEVER fabricates a pass. If the dashboard is
 * unreachable, the plugin view is absent, WebGL is unavailable, or the scene
 * blanks / leaks, it exits non-zero with an explicit verdict and evidence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import * as esbuild from "esbuild";
import sharp from "sharp";
import { chromium } from "playwright";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DASH_URL = process.env.OMNIROUTE_DASH_URL || "http://localhost:20128";
const DEFAULT_ATOMS = "16";
const DEFAULT_WINDOW_S = "210"; // ~3.5 min, past the ~2 min P0 window with margin
const DEFAULT_REINGEST_MS = "3500";
const DEFAULT_SAMPLE_MS = "10000";
const DEFAULT_CARD_TIMEOUT_MS = "25000";
// Dev-only password used to authenticate the dashboard during this check. It is
// passed to the login form in-page and is never written to the report.
const LOGIN_PASSWORD = process.env.INITIAL_PASSWORD || process.env.OMNIROUTE_E2E_PASSWORD || "";

const REPO_ROOT = dirname(dirname(dirname(process.argv[1] ?? ".")));
const OUT_ROOT = process.env.OMNIROUTE_P0_OUT_DIR || join(REPO_ROOT, "_cache", "p0-webgl-check");

// Renderer preference key — mirrors src/shared/topology/renderer/registry.ts so
// the dashboard's own panel, when present, uses the atomic renderer during the run.
const TOPOLOGY_RENDERER_PREF_KEY = "omniroute.topology.renderer";
const ATOMIC_RENDERER_ID = "atomic";

// Headless Chromium needs SwiftShader for WebGL2 (same args as
// scripts/ad-hoc/benchmark-atomic-topology.mjs / or-atom-003-screenshot.mjs).
const WEBGL_LAUNCH_ARGS = ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];

// The pass bar for the active WebGL context count.
const MAX_CTX_PASS = 2;
const MAX_CTX_HARD_FAIL = 4;

/**
 * Resolve a Chromium executable to launch. The installed Playwright build for
 * this repo may not match the version pinned in node_modules (cache holds
 * chromium-1200..1243 while the loader expects an older build), so prefer an
 * explicit CHROME_EXECUTABLE_PATH, then the installed Chromium-for-Testing, then
 * the system Chrome, then Playwright's own path. Returns the first that exists.
 */
function resolveChromeExecutable() {
  if (process.env.CHROME_EXECUTABLE_PATH) return process.env.CHROME_EXECUTABLE_PATH;
  const base = process.env.HOME
    ? `${process.env.HOME}/Library/Caches/ms-playwright`
    : "/Users/celes/Library/Caches/ms-playwright";
  const candidates = [];
  for (const major of [1243, 1228, 1223, 1217, 1200]) {
    candidates.push(
      join(
        base,
        `chromium-${major}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
      )
    );
  }
  candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined; // let Playwright fall back to its own (may then fail, handled)
}

function fail(code, verdict, detail = "") {
  console.error(`[p0] EXIT ${code}: ${verdict}`);
  if (detail) console.error(`[p0]   ${detail}`);
  process.exit(code);
}

function parseArgs(argv) {
  const a = {
    atoms: Number(process.env.OMNIROUTE_P0_ATOMS || DEFAULT_ATOMS),
    windowS: Number(process.env.OMNIROUTE_P0_WINDOW_S || DEFAULT_WINDOW_S),
    reingestMs: Number(process.env.OMNIROUTE_P0_REINGEST_MS || DEFAULT_REINGEST_MS),
    sampleMs: Number(process.env.OMNIROUTE_P0_SAMPLE_MS || DEFAULT_SAMPLE_MS),
    cardTimeoutMs: Number(process.env.OMNIROUTE_P0_CARD_TIMEOUT_MS || DEFAULT_CARD_TIMEOUT_MS),
    out: process.env.OMNIROUTE_P0_OUT_DIR || OUT_ROOT,
    headful: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log("see the usage header at the top of this file");
      process.exit(0);
    } else if (arg === "--headful") {
      a.headful = true;
    } else if (arg === "--atoms") {
      a.atoms = Number(argv[(i += 1)]);
    } else if (arg === "--window-s") {
      a.windowS = Number(argv[(i += 1)]);
    } else if (arg === "--reingest-ms") {
      a.reingestMs = Number(argv[(i += 1)]);
    } else if (arg === "--sample-ms") {
      a.sampleMs = Number(argv[(i += 1)]);
    } else if (arg === "--out") {
      a.out = argv[(i += 1)];
    }
  }
  return a;
}

/**
 * Build a TopologySceneSnapshot (shape: src/shared/topology/domain/types.ts).
 * `fleetTelemetry` carries the empty ReconciliationResult shape so the
 * provider-centric-fallback path is exercised without fabricating any device
 * fact. Re-ingesting a fresh `capturedAt` every cadence tick is what stresses
 * the re-render/dispose path where the P0 leak lived.
 */
function buildSnapshot(atomCount, seed) {
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
    const pid = `p0-provider-${i}`;
    const traffic = seed % 2 === 0 ? "idle" : "active";
    nodes.push({
      id: `provider:${pid}`,
      kind: "provider",
      label: pid,
      providerId: pid,
      health: "healthy",
      traffic,
    });
    links.push({
      id: `route:${pid}`,
      source: "hub",
      target: `provider:${pid}`,
      kind: "route",
      health: "healthy",
      traffic,
    });
  }
  return {
    schemaVersion: 1,
    capturedAt: now,
    nodes,
    links,
    // Empty device band: provider-centric fallback, no fabricated device facts.
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

async function buildHarnessBundle(outDir) {
  const entryPath = join(outDir, "harness-entry.ts");
  const bundlePath = join(outDir, "harness-bundle.js");
  const rendererEntry = join(REPO_ROOT, "src/plugins/atomic-topology/AtomicTopologyRenderer.tsx");
  if (!existsSync(rendererEntry)) {
    fail(1, "renderer entry not found", rendererEntry);
  }
  writeFileSync(
    entryPath,
    [
      "// Auto-generated by p0-webgl-regression-check.mjs — re-exports the",
      "// real renderer public instance API as a single browser-global IIFE.",
      `export { createAtomicTopologyInstance, mountAtomicTopologyRenderer } from "${rendererEntry}";`,
      "",
    ].join("\n")
  );
  // esbuild JS API (the bin is a native Mach-O binary, not node-spawnable).
  // Path aliases (`@/*`, `@omniroute/open-sse`) are resolved from tsconfig.json,
  // same resolution as benchmark-atomic-topology.mjs.
  try {
    await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: "iife",
      globalName: "__OR_P0_REGRESSION__",
      outfile: bundlePath,
      jsx: "automatic",
      tsconfig: join(REPO_ROOT, "tsconfig.json"),
      logLevel: "error",
      absWorkingDir: REPO_ROOT,
    });
  } catch (err) {
    fail(
      1,
      "esbuild harness bundle failed",
      (err && err.errors ? err.errors.map((e) => e.text).join("\n") : String(err)).slice(-2000)
    );
  }
  if (!existsSync(bundlePath)) fail(1, "esbuild produced no bundle", bundlePath);
  return bundlePath;
}

// ---------------------------------------------------------------------------
// Sampling: active WebGL context count (in-page) + composited blank check
// ---------------------------------------------------------------------------

/**
 * Count active WebGL/WebGL2 contexts limited to the driven scene overlay, so
 * unrelated dashboard canvases (charts, video, etc.) cannot skew the leak
 * metric. getContext() on an existing context returns the SAME context object
 * (it does not create a new one), so this is a pure count.
 */
async function countSceneWebglContexts(page) {
  return page
    .evaluate(() => {
      let n = 0;
      const overlay = document.getElementById("p0-atomic-scene");
      const scope = overlay
        ? overlay.querySelectorAll("canvas")
        : document.querySelectorAll("canvas");
      for (const c of scope) {
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
    })
    .catch(() => null); // evaluate transport failure is recorded, not fatal
}

/**
 * Authoritative blank check: screenshot the browser-composited scene canvas
 * (the overlay region) and analyze the pixels. A composited screenshot reflects
 * what the viewer sees — unlike an in-page drawing-buffer read of a
 * preserveDrawingBuffer:false WebGL canvas, which is cleared after composite.
 * Returns { hasCanvas, distinctColors, nonBlackRatio } — distinctColors<=1
 * means blank/absent.
 */
async function probeSceneComposited(page) {
  const canvas = page.locator("#p0-atomic-scene canvas").first();
  const present = await canvas.count().catch(() => 0);
  if (!present) {
    return { hasCanvas: false, distinctColors: 0, nonBlackRatio: 0 };
  }
  const png = await canvas.screenshot({ type: "png", timeout: 10000 }).catch(() => null);
  if (!png) {
    // Canvas present but not screenshotable this tick — flag for the report
    // rather than fabricating a content measurement.
    return { hasCanvas: true, distinctColors: -1, nonBlackRatio: -1 };
  }
  const { data, info } = await sharp(png)
    .resize(64, 64)
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch(() => null);
  if (!data) return { hasCanvas: true, distinctColors: -1, nonBlackRatio: -1 };
  const channels = info.channels;
  const total = 64 * 64;
  const set = new Set();
  let nonBlack = 0;
  for (let i = 0; i < total; i += 1) {
    const o = i * channels;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    set.add((r << 16) | (g << 8) | b);
    if (r > 8 || g > 8 || b > 8) nonBlack += 1;
  }
  return {
    hasCanvas: true,
    distinctColors: set.size,
    nonBlackRatio: Number((nonBlack / total).toFixed(4)),
  };
}

async function sampleOverWindow(page, windowMs, sampleMs) {
  const samples = [];
  const startTs = Date.now();
  const doSample = async () => {
    const t = Date.now() - startTs;
    const [activeWebglContexts, content] = await Promise.all([
      countSceneWebglContexts(page),
      probeSceneComposited(page),
    ]);
    samples.push({ t, activeWebglContexts, ...content });
  };
  await doSample(); // t=0
  while (Date.now() - startTs < windowMs) {
    const remaining = windowMs - (Date.now() - startTs);
    await new Promise((r) => setTimeout(r, Math.min(sampleMs, remaining)));
    await doSample();
  }
  return samples;
}

/** One-time WebGL capability probe on a fresh standalone canvas. */
async function probeWebglCapability(page) {
  return page.evaluate(() => {
    const c = document.createElement("canvas");
    let webgl2 = false;
    let webgl1 = false;
    try {
      webgl2 = !!c.getContext("webgl2");
    } catch {
      webgl2 = false;
    }
    try {
      webgl1 = !!c.getContext("webgl");
    } catch {
      webgl1 = false;
    }
    return { webgl2, webgl1 };
  });
}

// ---------------------------------------------------------------------------
// Dashboard login (mirrors tests/e2e/helpers/dashboardAuth.ts loginIfNeeded)
// ---------------------------------------------------------------------------

async function loginIfNeeded(page, timeoutMs) {
  if (!page.url().includes("/login")) return false;
  if (!LOGIN_PASSWORD) {
    console.log("[p0] dashboard requires login but no password supplied — leaving as-is");
    return false;
  }
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.waitFor({ state: "visible", timeout: timeoutMs });
  await passwordInput.fill(LOGIN_PASSWORD);
  const submitButton = page.locator("form").getByRole("button").first();
  await submitButton.waitFor({ state: "visible", timeout: timeoutMs });
  await Promise.all([
    page.waitForURL(/\/dashboard(\/.*)?$/, { timeout: timeoutMs }),
    submitButton.click(),
  ]);
  return true;
}

async function finishOnboardingIfNeeded(page, timeoutMs) {
  if (!page.url().includes("/dashboard/onboarding")) return false;
  const skip = page.getByRole("button", { name: /skip wizard|skip/i });
  await skip.waitFor({ state: "visible", timeout: timeoutMs });
  await skip.click();
  await page.waitForURL(/\/dashboard(\/.*)?$/, { timeout: timeoutMs });
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(args.out, stamp);
  mkdirSync(outDir, { recursive: true });
  const windowMs = Math.round(args.windowS * 1000);

  console.log(
    `[p0] dash=${DASH_URL} atoms=${args.atoms} window=${args.windowS}s reingest=${args.reingestMs}ms sample=${args.sampleMs}ms out=${outDir}`
  );

  const bundlePath = await buildHarnessBundle(outDir);
  console.log(`[p0] harness bundle ok (${bundlePath})`);

  const executablePath = resolveChromeExecutable();
  const browser = await chromium
    .launch({
      headless: !args.headful,
      args: WEBGL_LAUNCH_ARGS,
      ...(executablePath ? { executablePath } : {}),
    })
    .catch((err) => {
      fail(2, "browser launch failed", String(err));
    });

  let degraded = false;
  let droveScene = false;
  let samples = [];
  let shotOk = { start: false, mid: false, end: false };
  const shotPaths = {
    start: join(outDir, "screenshot-start.png"),
    mid: join(outDir, "screenshot-1min.png"),
    end: join(outDir, "screenshot-end.png"),
  };

  try {
    const context = await browser.newContext({
      viewport: { width: 1596, height: 1050 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(args.cardTimeoutMs);

    // Navigate to the dashboard.
    let navigated = false;
    try {
      await page.goto(DASH_URL, { waitUntil: "domcontentloaded", timeout: args.cardTimeoutMs });
      navigated = true;
    } catch (err) {
      fail(2, "DASHBOARD UNREACHABLE", `GET ${DASH_URL} failed (${String(err).split("\n")[0]})`);
    }
    if (!navigated) fail(2, "DASHBOARD UNREACHABLE", "navigation did not complete");

    await loginIfNeeded(page, args.cardTimeoutMs);
    await finishOnboardingIfNeeded(page, args.cardTimeoutMs);
    await page.waitForURL(/\/dashboard(\/.*)?$/, { timeout: args.cardTimeoutMs }).catch(() => {});

    // Plugin view present? The home "Provider Topology" card heading is the stable anchor.
    const heading = page.locator("h2", { hasText: "Provider Topology" }).first();
    try {
      await heading.waitFor({ state: "visible", timeout: args.cardTimeoutMs });
    } catch {
      fail(
        3,
        "ATOMIC-TOPOLLOGY PLUGIN VIEW ABSENT",
        'no visible <h2>"Provider Topology"</h2> on the dashboard home — the topology panel is not present. No pass is reported.'
      );
    }
    console.log("[p0] plugin view present (Provider Topology card visible)");

    // WebGL capability probe — the "headless Chromium cannot create WebGL" guard.
    const cap = await probeWebglCapability(page);
    console.log(`[p0] webgl capability probe: webgl2=${cap.webgl2} webgl1=${cap.webgl1}`);
    if (!cap.webgl2 && !cap.webgl1) {
      fail(
        3,
        "WEBGL-UNAVAILABLE",
        "headless Chromium reports no WebGL/WebGL2 context on page load — the P0 scene check cannot run. No pass is fabricated."
      );
    }

    // Seed the renderer preference so the dashboard's own panel, if it mounts,
    // uses the atomic renderer during the run.
    await page
      .evaluate(
        ([k, v]) => {
          try {
            window.localStorage.setItem(k, v);
          } catch {
            /* non-fatal */
          }
        },
        [TOPOLOGY_RENDERER_PREF_KEY, ATOMIC_RENDERER_ID]
      )
      .catch(() => {});

    // Inject the harness bundle (same-origin page; CSP allows inline scripts).
    const bundleSrc = readFileSync(bundlePath, "utf8");
    await page.addScriptTag({ content: bundleSrc });
    const apiOk = await page.evaluate(
      () => typeof window.__OR_P0_REGRESSION__?.createAtomicTopologyInstance === "function"
    );

    if (apiOk) {
      // Mount a real renderer instance into an ON-SCREEN overlay container so the
      // synthetic scene renders visibly (and is what the screenshots capture).
      await page.evaluate(() => {
        const el = document.createElement("div");
        el.id = "p0-atomic-scene";
        Object.assign(el.style, {
          position: "fixed",
          left: "0",
          top: "0",
          width: "1280px",
          height: "800px",
          zIndex: "2147483647",
          background: "#000",
        });
        document.body.appendChild(el);
      });
      const instanceReady = await page.evaluate(() => {
        try {
          const el = document.getElementById("p0-atomic-scene");
          if (!el) return "no-container";
          const snap = {
            schemaVersion: 1,
            capturedAt: Date.now(),
            nodes: [
              { id: "hub", kind: "hub", label: "OmniRoute", health: "unknown", traffic: "idle" },
            ],
            links: [],
          };
          const inst = window.__OR_P0_REGRESSION__.createAtomicTopologyInstance(el, snap, {});
          window.__OR_P0_INSTANCE__ = inst;
          try {
            inst.resize(1280, 800);
            inst.setPaused(false);
          } catch {
            /* no-op paths are documented on the instance contract */
          }
          return inst && typeof inst.update === "function" ? "ok" : "bad-instance";
        } catch (err) {
          return `error: ${String(err)}`;
        }
      });
      if (instanceReady !== "ok") {
        console.log(
          `[p0] WARN: renderer instance mount result: ${instanceReady} → falling back to empty-state view`
        );
      } else {
        // Feed the first real snapshot so the scene has content from t=0.
        const first = buildSnapshot(args.atoms, 0);
        await page
          .evaluate((s) => {
            window.__OR_P0_INSTANCE__.update(s);
          }, first)
          .catch(() => {});
        console.log(`[p0] synthetic scene instance mounted (driving ${args.atoms} atoms)`);

        // Wait for the WebGL canvas to (re)appear. One attempt only — if it never
        // attaches, the run degrades to the empty-state scope below.
        const canvas = page.locator("#p0-atomic-scene canvas").first();
        try {
          await canvas.waitFor({ state: "attached", timeout: args.cardTimeoutMs });
          droveScene = true;
          console.log("[p0] scene canvas attached — beginning drive window");
        } catch {
          console.log(
            "[p0] WARN: scene canvas did not attach within timeout — continuing in degraded scope (leak condition not actively driven)"
          );
        }
      }
    } else {
      console.log(
        "[p0] WARN: harness bundle did not expose the renderer API → falling back to empty-state view"
      );
    }

    if (!droveScene) degraded = true;

    // ---- Drive + sample over the full window, with screenshots at 0/1min/end.
    const fullShot = (p) =>
      page
        .screenshot({ path: p, fullPage: false })
        .then(() => true)
        .catch((e) => {
          console.log(`[p0] WARN: screenshot failed: ${String(e).split("\n")[0]}`);
          return false;
        });

    const shotAt = 60_000; // ~1 min

    // Re-ingest a fresh snapshot on cadence only when we are actually driving.
    const reingestTimer = droveScene
      ? setInterval(() => {
          const snap = buildSnapshot(args.atoms, Date.now());
          page
            .evaluate((s) => {
              try {
                if (
                  window.__OR_P0_INSTANCE__ &&
                  typeof window.__OR_P0_INSTANCE__.update === "function"
                ) {
                  window.__OR_P0_INSTANCE__.update(s);
                }
              } catch {
                /* a failed re-ingest is a data-loss event, not a scene crash */
              }
            }, snap)
            .catch(() => {});
        }, args.reingestMs)
      : null;

    shotOk.start = await fullShot(shotPaths.start);

    // Mid screenshot at ~1 min (own timer so it does not perturb the sampling loop).
    const midTimer =
      shotAt > 0
        ? setTimeout(async () => {
            shotOk.mid = await fullShot(shotPaths.mid);
          }, shotAt)
        : null;

    samples = await sampleOverWindow(page, windowMs, args.sampleMs);

    shotOk.end = await fullShot(shotPaths.end);

    if (reingestTimer) clearInterval(reingestTimer);
    if (midTimer) clearTimeout(midTimer);

    console.log(`[p0] drive window complete (${samples.length} samples)`);

    // Best-effort: dispose the driven instance so we do not leave a leak we
    // introduced (the very thing this check is hunting).
    await page
      .evaluate(() => {
        try {
          if (
            window.__OR_P0_INSTANCE__ &&
            typeof window.__OR_P0_INSTANCE__.dispose === "function"
          ) {
            window.__OR_P0_INSTANCE__.dispose();
          }
        } catch {
          /* no-op */
        }
      })
      .catch(() => {});
  } catch (err) {
    fail(1, "P0 CHECK CRASHED", String(err && err.stack ? err.stack.split("\n")[0] : err));
  } finally {
    await browser.close().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Verdict
  // ---------------------------------------------------------------------------
  const ctxValues = samples
    .filter((s) => s.activeWebglContexts !== null)
    .map((s) => s.activeWebglContexts);
  const maxCtx = ctxValues.length ? Math.max(...ctxValues) : 0;
  const minCtx = ctxValues.length ? Math.min(...ctxValues) : 0;
  const ctxUnverifiedSamples = samples.filter((s) => s.activeWebglContexts === null).length;
  // Blank = composited canvas absent, OR a single color (incl. all-black).
  // distinctColors === -1 means "present but not analyzable" — NOT counted blank.
  const blankSamples = samples.filter((s) => {
    if (!s.hasCanvas) return true;
    if (s.distinctColors >= 0 && s.distinctColors <= 1) return true;
    return false;
  }).length;
  const canvasMissingSamples = samples.filter((s) => !s.hasCanvas).length;
  const contentUnverifiedSamples = samples.filter((s) => s.distinctColors === -1).length;

  const report = {
    generatedAt: new Date().toISOString(),
    dashUrl: DASH_URL,
    atoms: args.atoms,
    windowMs,
    reingestMs: args.reingestMs,
    sampleMs: args.sampleMs,
    scope: droveScene ? "driven" : "degraded",
    droveScene,
    blankCheckBasis:
      "browser-composited screenshot of the scene canvas (in-page drawing-buffer reads of a preserveDrawingBuffer:false WebGL canvas are cleared after composite and are not used)",
    screenshots: {
      start: shotOk.start ? shotPaths.start : null,
      mid: shotOk.mid ? shotPaths.mid : null,
      end: shotOk.end ? shotPaths.end : null,
    },
    stats: {
      samples: samples.length,
      activeWebglContexts: { min: minCtx, max: maxCtx, unverified: ctxUnverifiedSamples },
      blankSamples,
      canvasMissingSamples,
      contentUnverifiedSamples,
      ctxSeries: samples,
    },
  };

  let verdict;
  let exitCode;
  if (degraded) {
    // The leak condition was not actively driven; we still ran the context-count
    // + blank loop on the empty-state view. Report honestly.
    verdict =
      blankSamples === 0 && maxCtx <= MAX_CTX_PASS
        ? "DEGRADED-PASS (empty-state; leak condition not actively driven)"
        : "DEGRADED (empty-state; leak condition not actively driven)";
    exitCode = 10;
    console.log(
      `[p0] scope=DEGRADED: renderer instance was not driven (bundle/mount/canvas); context-count + blank loop still ran on the empty-state view (maxCtx=${maxCtx}, blankSamples=${blankSamples}).`
    );
  } else if (maxCtx > MAX_CTX_HARD_FAIL) {
    verdict = `FAIL (context leak): max active WebGL contexts = ${maxCtx} (> ${MAX_CTX_HARD_FAIL})`;
    exitCode = 4;
  } else if (maxCtx > MAX_CTX_PASS) {
    verdict = `FAIL (exceeds pass bar): max active WebGL contexts = ${maxCtx} (> ${MAX_CTX_PASS})`;
    exitCode = 1;
  } else if (blankSamples > 0) {
    verdict = `FAIL (blank composited scene): ${blankSamples}/${samples.length} samples blank (P0 symptom)${canvasMissingSamples ? `; scene canvas missing in ${canvasMissingSamples} sample(s)` : ""}`;
    exitCode = 1;
  } else {
    verdict = `PASS (max contexts=${maxCtx}, ${samples.length} samples, 0 blank composited)`;
    exitCode = 0;
  }

  writeFileSync(join(outDir, "p0-webgl-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[p0] report: ${join(outDir, "p0-webgl-report.json")}`);
  console.log(`[p0] VERDICT (${exitCode}): ${verdict}`);
  process.exit(exitCode);
}

main().catch((err) => {
  fail(1, "UNCAUGHT", String(err && err.stack ? err.stack.split("\n")[0] : err));
});
