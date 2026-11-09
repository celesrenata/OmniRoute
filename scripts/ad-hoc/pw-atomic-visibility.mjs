#!/usr/bin/env node
/**
 * Directive 19 measurement (headed Chrome, real GPU): what the visibility
 * savings buy. A/B on the SAME build: `cull=0` (savings off) vs default (on).
 *
 *   node scripts/ad-hoc/pw-atomic-visibility.mjs ab        # uncapped frame stats, 3 interleaved rounds
 *   node scripts/ad-hoc/pw-atomic-visibility.mjs loop      # render-loop stop: visible vs scrolled away vs tab hidden
 *   node scripts/ad-hoc/pw-atomic-visibility.mjs diff      # pixel diff of the paused default frame, savings on vs off
 */
import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const mode = process.argv[2] ?? "ab";
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
  ],
});
async function open(query, zoom = 0, ctx) {
  const c =
    ctx ??
    (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 }));
  const page = await c.newPage();
  await page.goto(`${BASE}/dev/atomic-bench?${query}`);
  await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
  await page.waitForTimeout(2500);
  if (zoom) {
    await page.mouse.move(800, 500);
    for (let i = 0; i < zoom; i += 1) {
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(1500);
  }
  return { page, ctx: c };
}
const stats = (page, ms = 5000) =>
  page.evaluate(
    (dur) =>
      new Promise((resolve) => {
        const d = [];
        let last = performance.now();
        const end = last + dur;
        const tick = (t) => {
          d.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(tick);
          else {
            d.sort((a, b) => a - b);
            const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
            resolve({
              fps: +(d.length / (dur / 1000)).toFixed(1),
              p50: +q(0.5).toFixed(2),
              p95: +q(0.95).toFixed(2),
              p99: +q(0.99).toFixed(2),
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    ms
  );

if (mode === "ab") {
  const scenarios = [
    ["default-20", "atoms=20&paused=0", 0],
    ["default-32", "atoms=32&paused=0", 0],
    ["close-32", "atoms=32&paused=0", 7],
    ["closer-32", "atoms=32&paused=0", 11],
  ];
  for (const [name, q, zoom] of scenarios) {
    const rows = { on: [], off: [] };
    for (let round = 0; round < 3; round += 1) {
      for (const cull of ["off", "on"]) {
        const { page, ctx } = await open(`${q}${cull === "off" ? "&cull=0" : ""}`, zoom);
        rows[cull].push(await stats(page));
        await ctx.close();
      }
    }
    const med = (a, k) => a.map((r) => r[k]).sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(
      JSON.stringify({
        scenario: name,
        off: { fps: med(rows.off, "fps"), p50: med(rows.off, "p50"), p95: med(rows.off, "p95") },
        on: { fps: med(rows.on, "fps"), p50: med(rows.on, "p50"), p95: med(rows.on, "p95") },
        raw: rows,
      })
    );
  }
}

if (mode === "loop") {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  const { page } = await open("atoms=20&paused=0", 0, ctx);
  const frames = (p, ms) =>
    p.evaluate(
      (dur) =>
        new Promise((r) => {
          const a = window.__atomicRtFrames ?? 0;
          setTimeout(() => r((window.__atomicRtFrames ?? 0) - a), dur);
        }),
      ms
    );
  const visible = await frames(page, 3000);
  // Canvas scrolled out of view (IntersectionObserver).
  await page.evaluate(() => {
    const c = document.querySelector("canvas");
    let el = c;
    while (el && el.parentElement && el.parentElement !== document.body) el = el.parentElement;
    el.style.transform = "translateY(-6000px)";
  });
  await page.waitForTimeout(500);
  const scrolledAway = await frames(page, 3000);
  await page.evaluate(() => {
    const c = document.querySelector("canvas");
    let el = c;
    while (el && el.parentElement && el.parentElement !== document.body) el = el.parentElement;
    el.style.transform = "";
  });
  await page.waitForTimeout(800);
  const resumed = await frames(page, 3000);
  // Tab hidden. Playwright pages are separate windows, so a second tab never hides
  // this one; drive the real `visibilitychange` handler by overriding
  // `document.hidden` (the same event the browser fires for a hidden tab).
  const setHidden = (h) =>
    page.evaluate((hide) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hide });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (hide ? "hidden" : "visible"),
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, h);
  await setHidden(true);
  await page.waitForTimeout(500);
  const hidden = await frames(page, 3000);
  const hiddenFlag = await page.evaluate(() => document.hidden);
  await setHidden(false);
  await page.waitForTimeout(800);
  const back = await frames(page, 3000);
  console.log(JSON.stringify({ visible, scrolledAway, resumed, hidden, hiddenFlag, back }));
}

if (mode === "diff") {
  fs.mkdirSync("/tmp/vis", { recursive: true });
  for (const [name, q, zoom] of [
    ["default", "atoms=20&paused=1", 0],
    ["close", "atoms=32&paused=1", 7],
  ]) {
    for (const cull of ["off", "on"]) {
      const { page, ctx } = await open(`${q}${cull === "off" ? "&cull=0" : ""}`, zoom);
      await page.screenshot({ path: `/tmp/vis/${name}-${cull}.png` });
      await ctx.close();
    }
  }
}
await browser.close();
