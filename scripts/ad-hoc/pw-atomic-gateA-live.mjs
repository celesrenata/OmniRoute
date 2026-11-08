#!/usr/bin/env node
/**
 * Gate A live check (headed Chrome, real GPU): runs the animated (unpaused)
 * bench, samples requestAnimationFrame deltas, and saves two frames 1.5 s apart
 * to show motion. Usage: node pw-atomic-gateA-live.mjs <outDir> <name> <query>
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [outDir, name, query] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await (
  await browser.newContext({ viewport: { width: 1672, height: 941 }, deviceScaleFactor: 2 })
).newPage();
await page.goto(
  `${process.env.BENCH_BASE ?? "http://localhost:20199"}/dev/atomic-bench?atomic-fx=rt&${query}`
);
await page.waitForSelector('[data-atomic-bench="rt"][data-ready="true"]', { timeout: 180000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(outDir, `${name}-a.png`) });
const stats = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const deltas = [];
      let last = performance.now();
      const end = last + 5000;
      const tick = (t) => {
        deltas.push(t - last);
        last = t;
        if (t < end) requestAnimationFrame(tick);
        else {
          deltas.sort((a, b) => a - b);
          const q = (p) => deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))];
          resolve({
            frames: deltas.length,
            p50: q(0.5),
            p95: q(0.95),
            p99: q(0.99),
            fps: 1000 / q(0.5),
          });
        }
      };
      requestAnimationFrame(tick);
    })
);
await page.screenshot({ path: path.join(outDir, `${name}-b.png`) });
console.log(
  `${name}: frames=${stats.frames} p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms (~${stats.fps.toFixed(0)} fps @ 3344x1882 DPR2)`
);
await browser.close();
