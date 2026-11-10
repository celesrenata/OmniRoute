#!/usr/bin/env node
/**
 * Directive 37 evidence: routed copper traces with racing pulses, headed Chrome on the real GPU.
 * Bench (20 atoms, motion on): default still, a 12 s default-zoom recording of the pulses,
 * a low detail-view board close-up and a tighter wheel-zoom close-up, two stills 0.5 s apart
 * (pulse displacement), the router stats and default-view perf.
 *   node scripts/ad-hoc/pw-atomic-traces.mjs <outDir>     (VIDEO=1 records)
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const outDir = process.argv[2] ?? "/tmp/atomic-traces";
const base = process.env.BENCH_BASE ?? "http://localhost:20199";
const query = process.env.BENCH_QUERY ?? "atoms=20&paused=0&instance=1";
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
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  ...(process.env.VIDEO
    ? { recordVideo: { dir: outDir, size: { width: 1600, height: 1000 } } }
    : {}),
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
await page.goto(`${base}/dev/atomic-bench?${query}`);
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(9000);
const shot = (name) =>
  page.screenshot({ path: path.join(outDir, name), type: "jpeg", quality: 90 });
const report = { errors };
report.stats = await page.evaluate(() =>
  JSON.parse(JSON.stringify(window.__atomicTraceStats ?? null))
);
await shot("traces-default.jpg");
report.perfDefault = await page.evaluate(
  () =>
    new Promise((res) => {
      const d = [];
      let last = performance.now();
      const t0 = last;
      const tick = (now) => {
        d.push(now - last);
        last = now;
        if (now - t0 < 4000) requestAnimationFrame(tick);
        else {
          d.shift();
          const a = [...d].sort((x, y) => x - y);
          res({
            fps: Math.round((d.length / (d.reduce((x, y) => x + y, 0) / 1000)) * 10) / 10,
            p95: Math.round(a[Math.floor(a.length * 0.95)] * 10) / 10,
          });
        }
      };
      requestAnimationFrame(tick);
    })
);
// Default-zoom pulses travelling (the recording covers this whole wait).
await page.waitForTimeout(12000);
// Low close-up of the board: open the detail view of the first non-hub atom.
const id = await page.evaluate(
  () =>
    [...document.querySelectorAll(".atomic-labels [data-atom-id]")]
      .map((e) => e.getAttribute("data-atom-id"))
      .find((i) => i && !i.startsWith("hub")) ?? null
);
report.detailAtom = id;
await page.evaluate((i) => window.__atomicOpenDetail?.(i), id);
await page.waitForTimeout(5000);
await shot("traces-closeup-detail.jpg");
await page.waitForTimeout(500);
await shot("traces-closeup-detail-t05.jpg");
// Tighter: wheel-zoom toward the board in front of the atom.
await page.mouse.move(800, 760);
for (let i = 0; i < 6; i += 1) {
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(2500);
await shot("traces-closeup-zoom.jpg");
await page.waitForTimeout(6000);
const video = page.video();
await ctx.close();
if (video) fs.renameSync(await video.path(), path.join(outDir, "traces-pulses.webm"));
await browser.close();
fs.writeFileSync(path.join(outDir, "traces-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
