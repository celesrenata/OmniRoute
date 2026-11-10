#!/usr/bin/env node
/**
 * Gate B captures (headed Chrome, real GPU): the REAL AtomicTopologyRenderer on
 * the golden DEMO topology (`/dev/atomic-bench?atoms=N`, DEMO badge on).
 *
 *   node scripts/ad-hoc/pw-atomic-gateB-capture.mjs <outDir> <name>=<query>[|zoom=<ticks>][|wait=<ms>] ...
 *   VIDEO=12000 node ... <outDir> <name>=<query>   # also record a 12 s webm
 *
 * `zoom=<ticks>` scrolls the real OrbitControls (mouse wheel over the canvas)
 * to reach a close-up with the production camera; no camera code is touched.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [outDir, ...cases] = process.argv.slice(2);
const base = process.env.BENCH_BASE ?? "http://localhost:20199";
const VIDEO = Number(process.env.VIDEO ?? 0);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1700,1100",
  ],
});
for (const c of cases) {
  const eq = c.indexOf("=");
  const name = c.slice(0, eq);
  const [query, ...opts] = c.slice(eq + 1).split("|");
  const opt = Object.fromEntries(opts.map((o) => o.split("=")));
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    ...(opt.reduced ? { reducedMotion: "reduce" } : {}),
    ...(VIDEO ? { recordVideo: { dir: outDir, size: { width: 1600, height: 1000 } } } : {}),
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => errors.push(`pageerror ${String(e).slice(0, 200)}`));
  await page.goto(`${base}/dev/atomic-bench?${query}`);
  await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
  await page.waitForTimeout(2500);
  if (opt.zoom) {
    await page.mouse.move(800, 500);
    for (let i = 0; i < Number(opt.zoom); i += 1) {
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(40);
    }
  }
  await page.waitForTimeout(Number(opt.wait ?? 2500));
  if (VIDEO) await page.waitForTimeout(VIDEO);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  const video = page.video();
  await ctx.close();
  if (video) fs.renameSync(await video.path(), path.join(outDir, `${name}.webm`));
  console.log(
    `${name}: ${file}${video ? " +webm" : ""} errors=${JSON.stringify(errors.slice(0, 4))}`
  );
}
await browser.close();
