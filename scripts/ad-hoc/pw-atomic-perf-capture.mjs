#!/usr/bin/env node
/**
 * Identical-camera captures for the profile phase "no visible change" proof.
 * Every scene is a frozen clock (topology bench `paused=1`, Gate A grid `t=<fixed>`), the same
 * viewport / DPR / camera pose, captured twice per build (the second capture checks determinism).
 *
 *   node scripts/ad-hoc/pw-atomic-perf-capture.mjs <outDir>
 * env: BENCH_BASE (default http://localhost:20199), SCENES (comma list to restrict)
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const out = process.argv[2];
if (!out) throw new Error("usage: pw-atomic-perf-capture.mjs <outDir>");
fs.mkdirSync(out, { recursive: true });

/** name -> bench query (+ optional wheel zoom steps over the canvas centre). */
const SCENES = {
  "topo-08": { q: "atoms=8&paused=1&badge=0" },
  "topo-16": { q: "atoms=16&paused=1&badge=0" },
  "topo-20": { q: "atoms=20&paused=1&badge=0" },
  "topo-32": { q: "atoms=32&paused=1&badge=0" },
  "topo-20-close": { q: "atoms=20&paused=1&badge=0", zoom: 8 },
  "grid-32": { q: "atomic-fx=rt&count=32&t=7.25&badge=0" },
  "single-default": { q: "atomic-fx=rt&t=7.25&badge=0" },
  "single-close": { q: "atomic-fx=rt&t=7.25&dist=close&badge=0" },
  "single-idle": { q: "atomic-fx=rt&t=7.25&energy=idle&badge=0" },
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
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

// Warm-up load (shader compile, fonts, first layout) so the first measured scene is not special.
await page.goto(`${BASE}/dev/atomic-bench?atoms=8&paused=1&badge=0`);
await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(5000);
for (const [name, s] of Object.entries(SCENES)) {
  if (only && !only.has(name)) continue;
  for (const rep of [1, 2]) {
    await page.goto(
      `${BASE}/dev/atomic-bench?${s.q}${process.env.EXTRA ? "&" + process.env.EXTRA : ""}`
    );
    await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
    if (s.zoom) {
      const c = page.locator("canvas").first();
      const box = await c.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < s.zoom; i += 1) {
        await page.mouse.wheel(0, -240);
        // Let each wheel step's damping finish so the final pose does not depend on timing.
        await page.waitForTimeout(900);
      }
    }
    // Let eased state (DOF focus, feeder levels, camera damping) settle on the frozen clock.
    await page.waitForTimeout(7000);
    const host = page.locator('[data-ready="true"]').first();
    await host.screenshot({ path: path.join(out, `${name}.r${rep}.png`) });
  }
  console.log(name, "captured");
}
if (errors.length) console.log("page errors:", errors);
await browser.close();
