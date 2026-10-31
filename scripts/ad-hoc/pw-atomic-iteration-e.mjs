#!/usr/bin/env node
/**
 * OR-ATOM-010 — iteration-e capture harness (real pixels only).
 *
 * Captures the atomic bench at /dev/atomic-bench in the same four evidence
 * views as iteration-d, now WITH the quality-gated GPU bloom (T10.5e), and
 * runs `measure-pixels.mjs` on each so luminance / saturation numbers sit next
 * to the images for a direct iterd → itere comparison:
 *   - default  : fit framing, traffic live (paused=0)
 *   - closeup  : camera focused on one provider (the bench's `node=` deep-zoom)
 *   - reduced  : prefers-reduced-motion static frame (accessibility contract)
 *   - motion   : N consecutive live frames (packet travel visible as motion)
 *
 * Usage: node scripts/ad-hoc/pw-atomic-iteration-e.mjs
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

async function settle(page) {
  await page.waitForSelector("main[data-ready=true]", { timeout: 30_000 });
  await page.waitForTimeout(2500); // camera fit + scene settle
  const host = page.locator("main[data-atomic-bench]");
  return host;
}

// --- 1. Default fit framing (live traffic) ---------------------------------
const page = await newPage();
await page.goto(`${BASE}/dev/atomic-bench?paused=0`, { waitUntil: "domcontentloaded" });
const host = await settle(page);
await page.screenshot({ path: `${OUT}/after_iterE_default.png` });
console.log("saved after_iterE_default.png");

// --- 2. Closeup: deep-zoom on one provider ----------------------------------
const page2 = await newPage();
await page2.goto(`${BASE}/dev/atomic-bench?paused=0&node=provider:bench-primary`, {
  waitUntil: "domcontentloaded",
});
const host2 = await settle(page2);
await page2.screenshot({ path: `${OUT}/after_iterE_closeup.png` });
console.log("saved after_iterE_closeup.png");

// --- 2b. Error closeup: color-truth (failure core must stay pure red) -------
const pageErr = await newPage();
await pageErr.goto(`${BASE}/dev/atomic-bench?paused=0&node=provider:bench-error`, {
  waitUntil: "domcontentloaded",
});
const hostErr = await settle(pageErr);
await pageErr.screenshot({ path: `${OUT}/after_iterE_error.png` });
console.log("saved after_iterE_error.png");

// --- 3. Reduced-motion static frame ------------------------------------------
const page3 = await newPage();
await page3.addInitScript(() => {
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
await page3.goto(`${BASE}/dev/atomic-bench?paused=0`, { waitUntil: "domcontentloaded" });
await page3.waitForSelector("main[data-ready=true]", { timeout: 30_000 });
await page3.waitForTimeout(2000);
await page3.screenshot({ path: `${OUT}/after_iterE_reduced.png` });
console.log("saved after_iterE_reduced.png");

// --- 4. Motion: consecutive live frames -------------------------------------
const N = 6;
for (let i = 0; i < N; i += 1) {
  await host.screenshot({ path: `${OUT}/motion_iterE_${i}.png` });
  await page.waitForTimeout(150);
}
console.log(`saved motion_iterE_0..${N - 1}.png`);

await browser.close();

// --- 5. Measure — iter-e vs the iteration-d baseline ------------------------
const { execSync } = await import("node:child_process");
const files = [
  "after_iterd_default.png",
  "after_iterd_closeup.png",
  "after_iterd_reduced.png",
  "after_iterE_default.png",
  "after_iterE_closeup.png",
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
