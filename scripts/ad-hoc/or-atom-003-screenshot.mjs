#!/usr/bin/env node
/**
 * OR-ATOM-003 — before/after visual baseline capture (G6).
 *
 * Captures the home-page "Provider Topology" card from the local dev server at
 * fixed viewports so before/after shots share viewport + initial camera:
 *   - desktop 1596x1050
 *   - desktop 1280x720
 *   - compact 800x900 (the spec's ~420px-card regime)
 *   - mobile  390x844
 *
 * Plus an optional animation frame sequence (N frames at a fixed interval)
 * on each viewport — camera is untouched (no user input between frames).
 * Every viewport also gets a ~420px-tall crop of the card (`*-card-420.png`)
 * so electron density is judgeable at the spec's compact card size.
 *
 * Usage:
 *   node scripts/ad-hoc/or-atom-003-screenshot.mjs --tag before
 *   node scripts/ad-hoc/or-atom-003-screenshot.mjs --tag after --frames 6 --interval 250
 *
 * Output: <out>/<tag>/... (--out, default /tmp/or-atom-003).
 *
 * Auth: logs in via the /login form using --password (default CHANGEME, the
 * .env.example default for the local dev server).
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

// Mirrors `TOPOLOGY_RENDERER_PREF_KEY` in src/shared/topology/renderer/registry.ts —
// seeding it to "atomic" makes the home-page host mount the 3D Atomic renderer
// instead of the default 2D ReactFlow (resolveInitialRendererId in ProviderTopology).
const TOPOLOGY_RENDERER_PREF_KEY = "omniroute.topology.renderer";
const ATOMIC_RENDERER_ID = "atomic";

function parseArgs(argv) {
  const args = {
    tag: "before",
    frames: 0,
    interval: 200,
    password: "CHANGEME",
    base: "http://localhost:20128",
    out: "/tmp/or-atom-003",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--tag") args.tag = argv[++i];
    else if (a === "--frames") args.frames = Number(argv[++i]);
    else if (a === "--interval") args.interval = Number(argv[++i]);
    else if (a === "--password") args.password = argv[++i];
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node or-atom-003-screenshot.mjs --tag <before|after> [--frames N] [--interval ms] [--password P] [--base URL] [--out DIR]"
      );
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const outDir = join(args.out, args.tag);
mkdirSync(outDir, { recursive: true });

const VIEWPORTS = [
  { name: "desktop-1596x1050", width: 1596, height: 1050 },
  { name: "desktop-1280x720", width: 1280, height: 720 },
  // OR-ATOM-003 compact check: the spec's "420px topology card" regime — the
  // card must still show readable electron density at this width.
  { name: "compact-800x900", width: 800, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

const consoleErrors = [];

async function readRendererPref(page) {
  // NOTE: `page.evaluate` serializes the function into the browser — closure
  // variables (TOPOLOGY_RENDERER_PREF_KEY, ATOMIC_RENDERER_ID) do NOT exist
  // there and must be passed as arguments, or the evaluate throws a
  // ReferenceError that a try/catch would silently swallow.
  return page
    .evaluate((key) => {
      let pref = null;
      try {
        pref = localStorage.getItem(key);
      } catch {
        /* storage unavailable */
      }
      return pref;
    }, TOPOLOGY_RENDERER_PREF_KEY)
    .catch(() => null);
}

async function setRendererPref(page) {
  await page
    .evaluate(
      ([key, id]) => {
        try {
          localStorage.setItem(key, id);
        } catch {
          /* storage unavailable — capture will log the 0-canvas diagnostic */
        }
      },
      [TOPOLOGY_RENDERER_PREF_KEY, ATOMIC_RENDERER_ID]
    )
    .catch(() => {});
}

async function seedRendererPref(page, base) {
  // localStorage is origin-scoped: the seed only sticks on a page at the app
  // origin (about:blank throws on localStorage). `networkidle` is unusable
  // here (LiveWS keeps one connection permanently open), so use
  // domcontentloaded + a read-back verification with one retry at /home.
  await page.goto(base + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await setRendererPref(page);
  let pref = await readRendererPref(page);
  if (pref !== ATOMIC_RENDERER_ID) {
    console.log("[info] seed on / did not stick; retrying at /home");
    await page.goto(base + "/home", { waitUntil: "domcontentloaded" }).catch(() => {});
    await setRendererPref(page);
    pref = await readRendererPref(page);
  }
  console.log(`[info] renderer pref after seed: ${pref}`);
}

async function ensureLoggedIn(page, base, password) {
  // The local dev server may have requireLogin disabled — /login then
  // redirects straight to the dashboard. Try the login form first and fall
  // back to direct navigation when no password field appears.
  await seedRendererPref(page, base);
  await page.goto(base + "/login", { waitUntil: "domcontentloaded" });
  const input = page.locator('input[type="password"]').first();
  try {
    await input.waitFor({ timeout: 3000 });
    await input.fill(password);
    await Promise.all([
      page.waitForURL(/\/(dashboard|home)/, { timeout: 30000 }),
      input.press("Enter"),
    ]);
  } catch {
    // No login form — already authenticated (or login not required).
    await page.goto(base + "/home", { waitUntil: "domcontentloaded" });
  }
  await page.waitForTimeout(500);
  // Some app flows clear/rewrite storage on auth redirects; verify the pref
  // survived and re-seed + reload if it did not, so the 3D renderer mounts.
  const pref = await readRendererPref(page);
  if (pref !== ATOMIC_RENDERER_ID) {
    console.log(`[info] renderer pref lost after login (pref=${pref}); re-seeding`);
    await setRendererPref(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    const pref2 = await readRendererPref(page);
    console.log(`[info] renderer pref after re-seed + reload: ${pref2}`);
  }
}

async function captureCard(page, name) {
  const heading = page.locator('h2:has-text("Provider Topology")').first();
  await heading.waitFor({ timeout: 20000 });
  await heading.scrollIntoViewIfNeeded();
  // Give the WebGL scene time to mount + first camera fit + a few animation cycles.
  await page.waitForTimeout(5000);

  // Diagnostic: the 3D renderer mounts a <canvas>; 0 canvases means the host
  // fell back to the 2D renderer (WebGL2 unavailable or pref not seeded).
  const [canvasCount, rendererPref] = await page.evaluate((key) => {
    let pref = null;
    try {
      pref = localStorage.getItem(key);
    } catch {
      /* ignore */
    }
    return [document.querySelectorAll("canvas").length, pref];
  }, TOPOLOGY_RENDERER_PREF_KEY);
  console.log(`[diag] ${name} canvases=${canvasCount} rendererPref=${rendererPref}`);
  if (canvasCount === 0) {
    console.log(`[warn] ${name} no canvas found — 3D renderer likely fell back to 2D`);
  }

  await page.screenshot({ path: join(outDir, `${name}-fullpage.png`), fullPage: true });

  // Card element shot: walk UP from the heading until we find an ancestor
  // that ALSO contains the topology canvas (the 3D renderer surface). The
  // nearest 2-level parent is only the ~40px card header row — the canvas
  // lives in a sibling section, so the header-only box would crop to a
  // sliver and hide every atom.
  async function findCardWithCanvas() {
    const levels = [2, 3, 4, 5, 6, 7, 8];
    for (const lvl of levels) {
      const cand = heading.locator(`xpath=ancestor::div[${lvl}]`).first();
      const [h2, canvasN] = await Promise.all([
        cand.locator("h2").count(),
        cand.locator("canvas").count(),
      ]);
      if (h2 > 0 && canvasN > 0) {
        const box = await cand.boundingBox().catch(() => null);
        if (box && box.height > 160) return cand;
      }
    }
    return null;
  }
  const cardEl = (await findCardWithCanvas()) || heading.locator("..").locator("..").first();
  const cardBox = await cardEl.boundingBox().catch(() => null);
  console.log(
    `[diag] ${name} card box=${cardBox ? `${Math.round(cardBox.width)}x${Math.round(cardBox.height)}` : "none"}`
  );
  try {
    await cardEl.screenshot({ path: join(outDir, `${name}-card.png`), timeout: 10000 });
    console.log(`[ok] ${name} card shot`);
  } catch {
    // Fallback: viewport screenshot with the card header pinned near the top.
    await heading.evaluate((el) => {
      const top = el.getBoundingClientRect().top + window.scrollY - 24;
      window.scrollTo(0, top);
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, `${name}-card.png`) });
    console.log(`[ok] ${name} card shot (viewport fallback)`);
  }

  // OR-ATOM-003: a ~420px-tall crop of the card so electron density can be
  // judged at the spec's compact-card size (the full card is usually taller,
  // and full-card shots blur the per-atom detail).
  const box = cardBox;
  if (box && box.width > 0) {
    const cropH = Math.min(box.height, 420);
    try {
      await cardEl.screenshot({
        path: join(outDir, `${name}-card-420.png`),
        clip: { x: 0, y: 0, width: box.width, height: cropH },
        timeout: 10000,
      });
      console.log(
        `[ok] ${name} card-420 crop (${Math.round(box.width)}x${Math.round(cropH)} of ${Math.round(box.width)}x${Math.round(box.height)})`
      );
    } catch (cropErr) {
      console.log(`[warn] ${name} card-420 crop failed: ${cropErr.message}`);
    }
  }

  if (args.frames > 0) {
    for (let i = 0; i < args.frames; i += 1) {
      if (i > 0) await page.waitForTimeout(args.interval);
      await page.screenshot({
        path: join(outDir, `${name}-frame-${String(i).padStart(2, "0")}.png`),
      });
    }
    console.log(`[ok] ${name} frame sequence (${args.frames} @ ${args.interval}ms)`);
  }
}

// The installed playwright revision may not match the cached browser builds;
// fall back to the newest cached Chromium on this machine.
function resolveChromiumExecutable() {
  const base = join(process.env.HOME || "", "Library", "Caches", "ms-playwright");
  let versions = [];
  try {
    versions = readdirSync(base)
      .filter((d) => /^chromium-/.test(d))
      .sort()
      .reverse();
  } catch {
    return undefined;
  }
  for (const v of versions) {
    const bin = join(
      base,
      v,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing"
    );
    if (existsSync(bin)) return bin;
  }
  return undefined;
}
// Headless Chromium needs SwiftShader for WebGL2 (the Atomic renderer hard-
// requires it; without it detectWebgl2() fails and the host falls back to 2D).
const webglLaunchArgs = ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];
const browser = await chromium.launch({ args: webglLaunchArgs }).catch(async () => {
  const exec = resolveChromiumExecutable();
  console.log(`[info] falling back to cached chromium: ${exec}`);
  return chromium.launch({ executablePath: exec, args: webglLaunchArgs });
});

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    // The baseline capture was taken in dark mode; the app's "system" theme
    // follows prefers-color-scheme, so force the dark scheme for parity.
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
  });
  try {
    await ensureLoggedIn(page, args.base, args.password);
    await captureCard(page, vp.name);
  } catch (err) {
    console.error(`[FAIL] ${vp.name}: ${err.message}`);
    await page
      .screenshot({ path: join(outDir, `${vp.name}-failure.png`), fullPage: true })
      .catch(() => {});
  } finally {
    await context.close();
  }
}

await browser.close();
if (consoleErrors.length > 0) {
  console.log(`[warn] ${consoleErrors.length} console/page errors:`);
  for (const e of consoleErrors.slice(0, 10)) console.log("  -", e);
}
console.log(`[done] tag=${args.tag} → ${outDir}/`);
