#!/usr/bin/env node
/** Locate WHERE a slow frame blocks: wraps every GPU* prototype method and attributes time per frame. */
import { chromium } from "playwright";
const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const query = process.argv[2] ?? "atoms=20&paused=0";
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1700,1100",
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
    "--enable-webgpu-developer-features",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: Number(process.env.DPR ?? 2),
});
const page = await ctx.newPage();
await page.goto(`${BASE}/dev/atomic-bench?${query}&gputime=1`);
await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(3500);
const res = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const per = {};
      let frame = {};
      const wrapAll = (C) => {
        for (const k of Object.getOwnPropertyNames(C.prototype)) {
          const d = Object.getOwnPropertyDescriptor(C.prototype, k);
          if (!d || typeof d.value !== "function" || k === "constructor") continue;
          const f = d.value;
          C.prototype[k] = function (...a) {
            const t0 = performance.now();
            const r = f.apply(this, a);
            const dt = performance.now() - t0;
            const key = C.name + "." + k;
            const e = frame[key] ?? (frame[key] = [0, 0]);
            e[0] += dt;
            e[1] += 1;
            return r;
          };
        }
      };
      [
        "GPUQueue",
        "GPUDevice",
        "GPUCommandEncoder",
        "GPURenderPassEncoder",
        "GPUCanvasContext",
        "GPUBuffer",
        "GPUTexture",
      ].forEach((n) => window[n] && wrapAll(window[n]));
      const rows = [];
      let last = performance.now();
      const t0 = last;
      const tick = (now) => {
        const f = frame;
        frame = {};
        rows.push({ dt: now - last, f });
        last = now;
        if (now - t0 < 6000) requestAnimationFrame(tick);
        else resolve(rows);
      };
      requestAnimationFrame(tick);
    })
);
res.shift();
const slow = res.filter((r) => r.dt > 12),
  fast = res.filter((r) => r.dt <= 12);
const agg = (rows) => {
  const m = {};
  for (const r of rows)
    for (const [k, [t, n]] of Object.entries(r.f)) {
      const e = m[k] ?? (m[k] = [0, 0]);
      e[0] += t;
      e[1] += n;
    }
  return Object.entries(m)
    .map(([k, [t, n]]) => [k, +(t / rows.length).toFixed(3), +(n / rows.length).toFixed(1)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
};
console.log(
  JSON.stringify(
    { query, frames: res.length, slow: slow.length, slowTop: agg(slow), fastTop: agg(fast) },
    null,
    1
  )
);
await browser.close();
