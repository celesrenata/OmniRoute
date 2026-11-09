#!/usr/bin/env node
/**
 * Presented frames vs rendered frames (uncapped or capped): counts GPU-process present events in a
 * short Chrome trace ("gpu" category only) next to the page's rAF ticks and scene renders.
 *   node scripts/ad-hoc/pw-atomic-presents.mjs "<bench query>" [...]   env CAPPED=1 for vsync on
 */
import { chromium } from "playwright";
const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const qs = process.argv.slice(2);
const capped = process.env.CAPPED === "1";
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1700,1100",
    ...(process.env.WINPOS ? [`--window-position=${process.env.WINPOS}`] : []),
    ...(capped ? [] : ["--disable-frame-rate-limit", "--disable-gpu-vsync"]),
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const URL0 = (q) => (q.startsWith("http") ? q : `${BASE}/dev/atomic-bench?${q}`);
for (const q of qs) {
  await page.goto(URL0(q));
  await page.waitForSelector('[data-ready="true"], .atomic-scene-canvas canvas', {
    timeout: 120000,
  });
  await page.waitForTimeout(3500);
  const DUR = 2000;
  await browser.startTracing(page, { categories: ["-*", "gpu", "viz"] });
  const r = await page.evaluate(
    (dur) =>
      new Promise((res) => {
        const f0 = window.__atomicRtFrames ?? 0;
        let n = 0;
        const d = [];
        let last = performance.now();
        const t0 = last;
        const tick = (t) => {
          n++;
          d.push(t - last);
          last = t;
          if (t - t0 < dur) requestAnimationFrame(tick);
          else {
            d.shift();
            d.sort((a, b) => a - b);
            const q = (p) => +d[Math.min(d.length - 1, Math.floor(p * d.length))].toFixed(1);
            res({
              raf: n,
              renders: (window.__atomicRtFrames ?? 0) - f0,
              p50: q(0.5),
              p95: q(0.95),
              p99: q(0.99),
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    DUR
  );
  const buf = await browser.stopTracing();
  const s = buf.toString("latin1");
  const count = (re) => (s.match(re) || []).length;
  const presents =
    count(/"name":"ImageTransportSurfaceOverlayMac::Present"/g) ||
    count(/"name":"[^"]*Present[^"]*"/g);
  const waits = count(/"name":"IOSurfaceImageBacking::WaitForCommandsToBeScheduled"/g);
  console.log(
    JSON.stringify({
      q,
      capped,
      perSec: {
        raf: +(r.raf / (DUR / 1000)).toFixed(1),
        sceneRenders: +(r.renders / (DUR / 1000)).toFixed(1),
        presents: +(presents / (DUR / 1000)).toFixed(1),
        surfaceWaits: +(waits / (DUR / 1000)).toFixed(1),
      },
      raf: { p50: r.p50, p95: r.p95, p99: r.p99 },
    })
  );
}
await browser.close();
