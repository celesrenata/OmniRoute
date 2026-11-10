#!/usr/bin/env node
/**
 * Final-state targets (profile phase review item 2): the SHIPPED defaults (half-res reflection, cloud-only
 * hero, 30 fps throttle), normal vsync on the built-in 120 Hz panel, headed Chrome, real M5 Max GPU.
 * Each scene is measured twice: "Sync to display refresh rate" ON (>= 60 / ~120 fps target) and OFF (30 fps).
 * Interval source: the dev-only `window.__atomicFrameTimes` (written once per RENDERED frame), with a rAF-delta
 * fallback for pages that do not run the FrameDriver. GPU busy % is ioreg "Device Utilization" (whole GPU).
 *
 *   node scripts/ad-hoc/pw-atomic-final.mjs [outJson]
 * env: ROUNDS (default 2), WINDOW_MS (default 8000), SETTLE_MS (default 6000), SCENES=comma list
 */
import { chromium } from "playwright";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const WINDOW = Number(process.env.WINDOW_MS ?? 8000);
const SETTLE = Number(process.env.SETTLE_MS ?? 6000);
const ROUNDS = Number(process.env.ROUNDS ?? 2);
const gpuUtil = () => {
  try {
    const out = execFileSync("ioreg", ["-r", "-d", "1", "-w0", "-c", "IOAccelerator"], {
      encoding: "utf8",
    });
    const m = out.match(/"Device Utilization %"=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
};
const SCENES = {
  "topo-08": "/dev/atomic-bench?atoms=8&paused=0&badge=0",
  "topo-16": "/dev/atomic-bench?atoms=16&paused=0&badge=0",
  "topo-20": "/dev/atomic-bench?atoms=20&paused=0&badge=0",
  "topo-32": "/dev/atomic-bench?atoms=32&paused=0&badge=0",
  "grid-32": "/dev/atomic-bench?atomic-fx=rt&count=32&badge=0",
  "bench-detail":
    "/dev/atomic-bench?atoms=20&paused=0&badge=0&node=provider:bench-primary&detail=1",
  home: "/home",
};
const only = process.env.SCENES ? process.env.SCENES.split(",") : Object.keys(SCENES);
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-position=0,0",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const q = (a, p) =>
  a.length ? +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2) : null;
async function open(url, sync) {
  await page.goto(`${BASE}${url}`);
  await page.evaluate(
    (s) => localStorage.setItem("omniroute.atomic.syncRefresh", s ? "1" : "0"),
    sync
  );
  await page.reload();
  if (url.startsWith("/home")) {
    const group = page.locator('[role="group"][aria-label="Topology view mode"]');
    await group.waitFor({ timeout: 120000 });
    await group.getByRole("button", { name: "Atomic" }).click();
    await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
  } else {
    await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
  }
  await page.waitForTimeout(SETTLE);
}
async function measure() {
  const util = [];
  const sampler = (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < WINDOW) {
      util.push(gpuUtil());
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  const res = page.evaluate(
    (dur) =>
      new Promise((resolve) => {
        window.__atomicFrameTimes = [];
        const raf = [];
        let last = performance.now();
        const end = last + dur;
        const tick = (t) => {
          raf.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(tick);
          else {
            const ft = window.__atomicFrameTimes ?? [];
            resolve({ ft, raf });
          }
        };
        requestAnimationFrame(tick);
      }),
    WINDOW
  );
  const [{ ft, raf }] = await Promise.all([res, sampler]);
  const iv = ft.length > 5 ? ft.slice(1).map((t, i) => t - ft[i]) : raf.slice(1);
  const s = [...iv].sort((a, b) => a - b);
  const span = ft.length > 5 ? ft[ft.length - 1] - ft[0] : s.reduce((a, b) => a + b, 0);
  const u = util.filter((x) => x != null);
  return {
    source: ft.length > 5 ? "rendered-frame" : "rAF",
    frames: iv.length,
    fps: +(iv.length / (span / 1000)).toFixed(2),
    p50: q(s, 0.5),
    p95: q(s, 0.95),
    p99: q(s, 0.99),
    max: q(s, 1),
    // > 1.5 vsyncs of the 120 Hz panel (12.5 ms): a missed refresh while synced.
    over12_5ms: iv.filter((d) => d > 12.5).length,
    gpuUtilMean: u.length ? +(u.reduce((a, b) => a + b, 0) / u.length).toFixed(1) : null,
  };
}
const out = [];
for (const name of only) {
  const rec = { scene: name, synced: [], throttled: [] };
  for (let r = 0; r < ROUNDS; r += 1) {
    for (const sync of [true, false]) {
      await open(SCENES[name], sync);
      rec[sync ? "synced" : "throttled"].push(await measure());
    }
  }
  out.push(rec);
  console.log(JSON.stringify(rec));
}
await page.evaluate(() => localStorage.setItem("omniroute.atomic.syncRefresh", "0"));
await browser.close();
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
