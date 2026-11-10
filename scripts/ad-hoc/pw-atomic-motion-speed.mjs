#!/usr/bin/env node
/**
 * Directive 45: motion speed must be identical at 30 fps and at the display refresh rate.
 * On the topology bench (`paused=0`, real renderer) it samples, at 30 fps and synced:
 *   - the shared scene clock rate (dev `__atomicRtFrames` is frame count; the clock is read from
 *     the per-row electron angles `__atomicElectronDbg`, unwrapped) in rad/s per orbit,
 * and records a 10 s video of /home at the default 30 fps.
 *
 *   node scripts/ad-hoc/pw-atomic-motion-speed.mjs <outDir>
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const out = process.argv[2] ?? "/tmp/motion-speed";
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1600,1000",
    "--window-position=0,0",
  ],
});

async function speeds(sync) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/dev/atomic-bench?atoms=8&paused=0&badge=0`);
  await page.evaluate(
    (s) => localStorage.setItem("omniroute.atomic.syncRefresh", s ? "1" : "0"),
    sync
  );
  await page.reload();
  await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
  await page.waitForTimeout(4000);
  const r = await page.evaluate(
    () =>
      new Promise((res) => {
        const snap = () => JSON.parse(JSON.stringify(window.__atomicElectronDbg ?? []));
        const samples = [];
        const t0 = performance.now();
        const f0 = window.__atomicRtFrames ?? 0;
        const take = () => {
          samples.push({ t: performance.now(), a: snap() });
          if (performance.now() - t0 < 4000) setTimeout(take, 100);
          else {
            // Unwrapped angular speed per (row, wire), rad/s.
            const out = {};
            const first = samples[0].a;
            first.forEach((row, ri) =>
              (row ?? []).forEach((_, wi) => {
                let acc = 0;
                for (let k = 1; k < samples.length; k += 1) {
                  let d = samples[k].a[ri][wi] - samples[k - 1].a[ri][wi];
                  while (d > Math.PI) d -= 2 * Math.PI;
                  while (d < -Math.PI) d += 2 * Math.PI;
                  acc += d;
                }
                const secs = (samples[samples.length - 1].t - samples[0].t) / 1000;
                out[`${ri}:${wi}`] = +(acc / secs).toFixed(4);
              })
            );
            res({
              mode: window.__atomicFrameRate?.(),
              renderedFps: +(
                ((window.__atomicRtFrames ?? 0) - f0) /
                ((performance.now() - t0) / 1000)
              ).toFixed(1),
              radPerSec: out,
            });
          }
        };
        take();
      })
  );
  await ctx.close();
  return r;
}

const a = await speeds(false);
const b = await speeds(true);
const keys = Object.keys(a.radPerSec);
const ratios = keys
  .filter((k) => Math.abs(b.radPerSec[k]) > 1e-3)
  .map((k) => a.radPerSec[k] / b.radPerSec[k]);
const summary = {
  at30: { mode: a.mode, renderedFps: a.renderedFps },
  synced: { mode: b.mode, renderedFps: b.renderedFps },
  orbits: keys.length,
  speedRatio30overSync: {
    min: +Math.min(...ratios).toFixed(4),
    max: +Math.max(...ratios).toFixed(4),
    mean: +(ratios.reduce((x, y) => x + y, 0) / ratios.length).toFixed(4),
  },
  sample: Object.fromEntries(keys.slice(0, 6).map((k) => [k, [a.radPerSec[k], b.radPerSec[k]]])),
};
console.log(JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(out, "motion-speed.json"), JSON.stringify({ summary, a, b }, null, 2));

// 10 s recording of the real /home at the default 30 fps.
const vctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: out, size: { width: 1440, height: 900 } },
});
const page = await vctx.newPage();
await page.goto(`${BASE}/home`);
await page.evaluate(() => localStorage.setItem("omniroute.atomic.syncRefresh", "0"));
await page.reload();
const group = page.locator('[role="group"][aria-label="Topology view mode"]');
await group.waitFor({ timeout: 120000 });
await group.getByRole("button", { name: "Atomic" }).click();
await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
await page.waitForTimeout(12000);
const v = page.video();
await vctx.close();
const vp = await v.path();
fs.renameSync(vp, path.join(out, "home-30fps.webm"));
console.log("video", path.join(out, "home-30fps.webm"));
await browser.close();
