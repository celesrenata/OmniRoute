#!/usr/bin/env node
/**
 * OR-ATOM-010 — iteration-e capture, part 2 (error closeup + reduced + motion).
 *
 * The default + primary closeup captures already completed (see
 * `after_iterE_default.png` / `after_iterE_closeup.png`). This tail re-captures
 * the error closeup with page-side error logging (so a real scene crash shows
 * up instead of a bare settle-timeout), then the reduced-motion frame and the
 * N-frame motion strip, and finally measures iter-e vs the iteration-d
 * baseline with `measure-pixels.mjs`.
 *
 * Usage: node scripts/ad-hoc/pw-atomic-iteration-e-tail.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:21128";
const OUT = "OR_ATOM_010/screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl"],
});

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    // Force the dark host + default (high) quality for stable captures.
    localStorage.setItem("omniroute-theme", "dark");
  });
  return page;
}

// --- 2b. Error closeup with console diagnostics -----------------------------
{
  const page = await newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      console.log(`[console ${msg.type()}] ${msg.text().slice(0, 400)}`);
    }
  });
  page.on("pageerror", (err) => console.log(`[pageerror] ${String(err).slice(0, 400)}`));
  await page.goto(`${BASE}/dev/atomic-bench?paused=0&node=provider:bench-error`, {
    waitUntil: "domcontentloaded",
  });
  try {
    await page.waitForSelector("main[data-ready=true]", { timeout: 60_000 });
    console.log("error view: ready");
  } catch (e) {
    console.log(`error view: NOT ready — ${String(e).slice(0, 200)}`);
  }
  await page.waitForTimeout(3000);
  const ready = await page.evaluate(
    () => document.querySelector("main[data-atomic-bench]")?.getAttribute("data-ready") ?? null
  );
  const canvasSize = await page.evaluate(() => {
    const c = document.querySelector("main[data-atomic-bench] canvas");
    return c ? `${c.width}x${c.height}` : "no-canvas";
  });
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
  console.log(`data-ready=${ready} canvas=${canvasSize}`);
  console.log(`body: ${bodyText.replace(/\n+/g, " | ")}`);
  await page.screenshot({ path: `${OUT}/after_iterE_error.png` });
  console.log("saved after_iterE_error.png");
  await page.close();
}

// --- 1'. Motion: consecutive live frames (fresh default page) ----------------
{
  const page = await newPage();
  await page.goto(`${BASE}/dev/atomic-bench?paused=0`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main[data-ready=true]", { timeout: 60_000 });
  await page.waitForTimeout(2500);
  const host = page.locator("main[data-atomic-bench]");
  const N = 6;
  for (let i = 0; i < N; i += 1) {
    await host.screenshot({ path: `${OUT}/motion_iterE_${i}.png` });
    await page.waitForTimeout(150);
  }
  console.log(`saved motion_iterE_0..${N - 1}.png`);
  await page.close();
}

// --- 3'. Reduced-motion static frame -----------------------------------------
{
  const page = await newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, "matchMedia", {
      value: (q) => ({
        matches: q === "(prefers-reduced-motion: reduce)",
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  });
  await page.goto(`${BASE}/dev/atomic-bench?paused=0`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main[data-ready=true]", { timeout: 60_000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/after_iterE_reduced.png` });
  console.log("saved after_iterE_reduced.png");
  await page.close();
}

await browser.close();

// --- 5. Measure — iter-e vs the iteration-d baseline -------------------------
const { execSync } = await import("node:child_process");
const N = 6;
const files = [
  "after_iterd_default.png",
  "after_iterd_closeup.png",
  "after_iterd_reduced.png",
  "after_iterE_default.png",
  "after_iterE_closeup.png",
  "after_iterE_error.png",
  "after_iterE_reduced.png",
  ...Array.from({ length: N }, (_, i) => `motion_iterE_${i}.png`),
].map((f) => `${OUT}/${f}`);
try {
  console.log(
    execSync(`node scripts/ad-hoc/measure-pixels.mjs ${files.join(" ")}`, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    })
  );
} catch {
  console.log("measure failed (non-fatal)");
}
