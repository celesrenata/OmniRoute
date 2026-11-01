#!/usr/bin/env node
/**
 * OR-ATOM-010 — iteration-e regression-fix capture harness (real pixels only).
 *
 * Captures the atomic bench at /dev/atomic-bench into the iteration-e folder
 * (`OR_ATOM_010/screenshots/iteration-e/`) in five evidence views:
 *   - default  : fit framing, traffic live (paused=0)
 *   - closeup  : camera focused on one provider (deep-zoom via node=)
 *   - error    : failure state color-truth (node=provider:bench-error)
 *   - reduced  : prefers-reduced-motion static frame
 *   - motion   : 6 consecutive live frames (packet travel visible as motion)
 *
 * Contexts are opened sequentially and closed before the next one opens
 * (SwiftShader is single-context heavy on CPU), and each page retries once on
 * the ready-gate timeout. One browser process for the whole run.
 *
 * Also runs `measure-pixels.mjs` on the key frames for luminance/saturation
 * numbers so the scorecard has measurable evidence.
 *
 * Usage:
 *   node scripts/ad-hoc/pw-atomic-iteration-e.mjs [before|after]
 *
 * The positional argument selects the prefix: `before_*` or `after_*`.
 * Defaults to `after`.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const prefix = process.argv[2] ?? "after";
const BASE = "http://127.0.0.1:21128";
const OUT = "OR_ATOM_010/screenshots/iteration-e";
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl"],
});

async function openBench(query, reduced = false) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  if (reduced) {
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
  } else {
    await page.addInitScript(() => {
      localStorage.setItem("omniroute-theme", "dark");
    });
  }
  await page.goto(`${BASE}/dev/atomic-bench?paused=0${query}`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.waitForSelector("main[data-ready=true]", { timeout: 45_000 });
      break;
    } catch (err) {
      if (attempt === 1) throw err;
      await sleep(2500);
    }
  }
  await sleep(2500); // camera fit + scene settle
  const host = page.locator("main[data-atomic-bench]");
  return { context, host };
}

const captured = [];

// --- 1. Default fit framing (live traffic) + motion strip -------------------
{
  const { context, host } = await openBench("");
  const f = `${OUT}/${prefix}_default.png`;
  await host.screenshot({ path: f });
  captured.push(f);
  console.log(`saved ${prefix}_default.png`);
  const N = 6;
  for (let i = 0; i < N; i += 1) {
    const mf = `${OUT}/motion_${prefix}_${i}.png`;
    await host.screenshot({ path: mf });
    captured.push(mf);
    await sleep(150);
  }
  console.log(`saved motion_${prefix}_0..${N - 1}.png`);
  await context.close();
}

// --- 2. Closeup: deep-zoom on one provider ----------------------------------
{
  const { context, host } = await openBench("&node=provider:bench-primary");
  const f = `${OUT}/${prefix}_closeup.png`;
  await host.screenshot({ path: f });
  captured.push(f);
  console.log(`saved ${prefix}_closeup.png`);
  await context.close();
}

// --- 3. Error closeup: color-truth (failure core must stay pure red) -------
{
  const { context, host } = await openBench("&node=provider:bench-error");
  const f = `${OUT}/${prefix}_error.png`;
  await host.screenshot({ path: f });
  captured.push(f);
  console.log(`saved ${prefix}_error.png`);
  await context.close();
}

// --- 4. Reduced-motion static frame -----------------------------------------
{
  const { context, host } = await openBench("", true);
  const f = `${OUT}/${prefix}_reduced.png`;
  await host.screenshot({ path: f });
  captured.push(f);
  console.log(`saved ${prefix}_reduced.png`);
  await context.close();
}

await browser.close();

try {
  console.log(
    execSync(`node scripts/ad-hoc/measure-pixels.mjs ${captured.join(" ")}`, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    })
  );
} catch {
  console.log("measure failed (non-fatal)");
}
