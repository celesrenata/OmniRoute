#!/usr/bin/env node
/** Cumulative ablation of scene parts on the uncapped bench: where does the periodic ~20 ms frame go away? */
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
const measure = (ms = 4000) =>
  page.evaluate(
    (dur) =>
      new Promise((res) => {
        const d = [];
        let last = performance.now();
        const t0 = last;
        const tick = (n) => {
          d.push(n - last);
          last = n;
          if (n - t0 < dur) requestAnimationFrame(tick);
          else {
            d.shift();
            const s = [...d].sort((a, b) => a - b);
            const q = (x) => +s[Math.min(s.length - 1, Math.floor(s.length * x))].toFixed(1);
            res({
              fps: +(d.length / (d.reduce((a, b) => a + b, 0) / 1000)).toFixed(0),
              p50: q(0.5),
              p95: q(0.95),
              p99: q(0.99),
              slow: d.filter((x) => x > 12).length,
              n: d.length,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    ms
  );
const steps = [
  ["baseline", () => {}],
  [
    "- motes",
    () => {
      const m = window.__atomicGpuDbg.motes;
      m.far.visible = m.near.visible = false;
    },
  ],
  ["- env", () => window.__atomicGpuDbg.env.objects.forEach((o) => (o.visible = false))],
  ["- atoms", () => (window.__atomicGpuDbg.atoms.group.visible = false)],
  ["- bloom", () => window.__atomicGpuDbg.post.setBloom(false)],
];
for (const [name, fn] of steps) {
  await page.evaluate(fn);
  await page.waitForTimeout(600);
  console.log(name.padEnd(10), JSON.stringify(await measure()));
}
await browser.close();
