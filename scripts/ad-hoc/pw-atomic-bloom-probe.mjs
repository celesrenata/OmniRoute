#!/usr/bin/env node
/**
 * OR-ATOM-010 — bloom parameter probe (iteration-e tuning).
 *
 * Captures the default fit framing at `?quality=high` with a pass-config
 * sweep selected via `?bloom=`:
 *   - off        : BloomComposer disabled (isolates the OutputPass / color
 *                  pipeline from the bloom itself)
 *   - current    : the shipped T10.5e values (1.05 / 0.55 / 0.75)
 *   - strict     : candidate retune (0.35 / 0.40 / 0.90)
 *   - tight      : (0.55 / 0.35 / 0.92)
 *   - med        : (0.60 / 0.40 / 1.00)
 *   - hot        : (0.80 / 0.35 / 1.30)
 *   - hotter     : (1.00 / 0.30 / 1.60)
 *
 * Each capture is run through `measure-bloom.mjs` (blow-out distribution) and
 * `measure-pixels.mjs` (mean luminance + saturated-color coverage) so the
 * numbers decide the retune.
 *
 * Usage: node scripts/ad-hoc/pw-atomic-bloom-probe.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:21128";
const OUT = "OR_ATOM_010/screenshots";
mkdirSync(OUT, { recursive: true });

const CONFIGS = [
  { name: "off", params: "bloom=off" },
  { name: "strict", params: "bloom=strict" },
  { name: "s160", params: "bloom=s160" },
  { name: "t20", params: "bloom=t20" },
  { name: "t25", params: "bloom=t25" },
  { name: "t30", params: "bloom=t30" },
  { name: "soft16", params: "bloom=soft16" },
];

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl"],
});

for (const cfg of CONFIGS) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("omniroute-theme", "dark");
  });
  await page.goto(`${BASE}/dev/atomic-bench?paused=0&quality=high&${cfg.params}`, {
    waitUntil: "domcontentloaded",
  });
  try {
    await page.waitForSelector("main[data-ready=true]", { timeout: 60_000 });
  } catch (e) {
    console.log(`${cfg.name}: NOT ready — ${String(e).slice(0, 150)}`);
  }
  await page.waitForTimeout(3000);
  const path = `${OUT}/probe_bloom_${cfg.name}.png`;
  await page.screenshot({ path });
  console.log(`saved ${path}`);
  await context.close();
}

await browser.close();

const { execSync } = await import("node:child_process");
const files = CONFIGS.map((c) => `${OUT}/probe_bloom_${c.name}.png`).join(" ");
console.log(
  execSync(`node scripts/ad-hoc/measure-bloom.mjs ${files}`, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  })
);
console.log(
  execSync(`node scripts/ad-hoc/measure-pixels.mjs ${files}`, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  })
);
