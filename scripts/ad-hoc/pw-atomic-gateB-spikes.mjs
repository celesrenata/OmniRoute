#!/usr/bin/env node
/**
 * Gate B: is the periodic uncapped long frame GPU/present back-pressure or main-thread work?
 * Wraps requestAnimationFrame callbacks to time their JS execution, and wraps
 * GPUQueue.submit / onSubmittedWorkDone to time GPU completion latency, then
 * reports both next to the rAF gap series.
 *   node scripts/ad-hoc/pw-atomic-gateB-spikes.mjs "<bench query>" [VW VH]
 */
import { chromium } from "playwright";
const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const [query, vw = "800", vh = "500"] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: Number(vw), height: Number(vh) },
  deviceScaleFactor: 2,
});
await ctx.addInitScript(() => {
  const js = [];
  const gaps = [];
  const gpu = [];
  window.__spk = { js, gaps, gpu };
  const raf = window.requestAnimationFrame.bind(window);
  let last = 0;
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      const s = performance.now();
      if (last) gaps.push(t - last);
      last = t;
      cb(t);
      js.push(performance.now() - s);
    });
  const patch = () => {
    const Q = window.GPUQueue?.prototype;
    if (!Q || Q.__p) return;
    Q.__p = true;
    const submit = Q.submit;
    Q.submit = function (...a) {
      const s = performance.now();
      const r = submit.apply(this, a);
      this.onSubmittedWorkDone().then(() => gpu.push(performance.now() - s));
      return r;
    };
  };
  patch();
});
const page = await ctx.newPage();
await page.goto(`${BASE}/dev/atomic-bench?${query}`);
await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  window.__spk.js.length = 0;
  window.__spk.gaps.length = 0;
  window.__spk.gpu.length = 0;
});
await page.waitForTimeout(6000);
const r = await page.evaluate(() => {
  const q = (a, p) => {
    const b = [...a].sort((x, y) => x - y);
    return +b[Math.min(b.length - 1, Math.floor(p * b.length))]?.toFixed(2);
  };
  const { js, gaps, gpu } = window.__spk;
  // JS time in the frames that follow a long gap vs normal gaps.
  const longIdx = gaps.map((g, i) => (g > 30 ? i : -1)).filter((i) => i >= 0);
  const jsLong = longIdx.map((i) => js[i]).filter((v) => v != null);
  return {
    frames: gaps.length,
    gapP50: q(gaps, 0.5),
    gapP99: q(gaps, 0.99),
    longFrames: longIdx.length,
    jsP50: q(js, 0.5),
    jsP99: q(js, 0.99),
    jsMaxOnLongFrames: jsLong.length ? +Math.max(...jsLong).toFixed(2) : null,
    gpuDoneP50: q(gpu, 0.5),
    gpuDoneP99: q(gpu, 0.99),
  };
});
console.log(JSON.stringify({ query, ...r }));
await browser.close();
