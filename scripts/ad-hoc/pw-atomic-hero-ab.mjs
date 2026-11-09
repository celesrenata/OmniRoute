#!/usr/bin/env node
/**
 * Directive 44.2 evidence: identical-state A/B of the reduced-resolution hero translucency.
 * Each scene is loaded ONCE with `?herores=<scale>` and the clock frozen; the pass is switched
 * off / on live through the dev hook `window.__atomicHeroEnabled`, so both captures share the
 * exact camera, time and data. off.r1 vs off.r2 is the determinism floor of that same state.
 *
 *   node scripts/ad-hoc/pw-atomic-hero-ab.mjs <outDir> [scale=0.5]
 *   -> <outDir>/off/<scene>.r1.png, off/<scene>.r2.png, on/<scene>.r1.png
 * Then: node scripts/ad-hoc/atomic-perf-diff.mjs <outDir>/off <outDir>/on <outDir>/diff
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const out = process.argv[2];
const scale = process.argv[3] ?? "0.5";
if (!out) throw new Error("usage: pw-atomic-hero-ab.mjs <outDir> [scale]");
for (const d of ["off", "on"]) fs.mkdirSync(path.join(out, d), { recursive: true });

const SCENES = {
  "home-card-detail": { home: "card" },
  "home-fs-detail": { home: "fs" },
  "bench-detail": { q: "atoms=20&paused=1&badge=0&node=provider:bench-primary&detail=1" },
  "bench-detail-hub": { q: "atoms=20&paused=1&badge=0&node=hub&detail=1" },
  "bench-close": { q: "atoms=20&paused=1&badge=0", zoom: 8 },
  "bench-default": { q: "atoms=20&paused=1&badge=0" },
};
const only = process.env.SCENES ? new Set(process.env.SCENES.split(",")) : null;

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1700,1100",
    "--force-color-profile=srgb",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const log = {};

for (const [name, s] of Object.entries(SCENES)) {
  if (only && !only.has(name)) continue;
  let target;
  if (s.home) {
    await page.goto(
      `${BASE}/home?herores=${scale}${process.env.EXTRA ? "&" + process.env.EXTRA : ""}`
    );
    const group = page.locator('[role="group"][aria-label="Topology view mode"]');
    await group.waitFor({ timeout: 120000 });
    await group.getByRole("button", { name: "Atomic" }).click();
    await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
    await page.waitForTimeout(6000);
    if (s.home === "fs") {
      await page.bringToFront();
      await page.mouse.click(1000, 40);
      await page.locator('[data-atomic-control="fullscreen"]').click();
      await page.waitForTimeout(2500);
    }
    await page.evaluate(() => window.__atomicOpenDetail?.("provider:openai"));
    await page.waitForTimeout(6000);
    await page.locator('[data-atomic-control="pause"]').click();
    target = s.home === "fs" ? page : page.locator(".atomic-scene-canvas").first();
  } else {
    await page.goto(
      `${BASE}/dev/atomic-bench?${s.q}&herores=${scale}${process.env.EXTRA ? "&" + process.env.EXTRA : ""}`
    );
    await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
    if (s.zoom) {
      const c = page.locator("canvas").first();
      const box = await c.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < s.zoom; i += 1) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(900);
      }
    }
    await page.waitForTimeout(6000);
    target = page.locator('[data-ready="true"]').first();
  }
  // Stop the detail view's cinematic drift (a press without movement hands the camera to the
  // viewer and leaves it where it is), then let any damping settle.
  {
    const c = page.locator("canvas").first();
    const box = await c.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(2500);
  }
  // Frozen clock from here: off, off again (floor), on.
  await page.evaluate(() => (window.__atomicHeroEnabled = false));
  await page.waitForTimeout(2500);
  await target.screenshot({ path: path.join(out, "off", `${name}.r1.png`) });
  await page.waitForTimeout(1500);
  await target.screenshot({ path: path.join(out, "off", `${name}.r2.png`) });
  await page.evaluate(() => (window.__atomicHeroEnabled = true));
  await page.waitForTimeout(2500);
  const heroIdx = await page.evaluate(() => window.__atomicHeroIdx ?? null);
  await target.screenshot({ path: path.join(out, "on", `${name}.r1.png`) });
  log[name] = { heroIdx };
  console.log(name, JSON.stringify(log[name]));
  if (s.home === "fs") await page.keyboard.press("Escape");
}
fs.writeFileSync(path.join(out, "hero-ab.json"), JSON.stringify({ scale, scenes: log }, null, 2));
await browser.close();
