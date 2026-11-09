#!/usr/bin/env node
/**
 * Camera-containment demo (headed Chrome, real GPU): drive the real
 * OrbitControls (wheel zoom out/in, drag orbit to extremes, right-drag pan) and
 * sample the live camera via the dev-only `window.__atomicCamDbg` after every
 * step. Passes when the camera never leaves the container's walls/floor/ceiling.
 *
 *   OUT=dir node scripts/ad-hoc/pw-atomic-camlimit.mjs
 * Writes <OUT>/camlimit.webm (+ stills) and prints a JSON summary.
 */
import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const OUT = process.env.OUT ?? "/tmp/camlimit";
fs.mkdirSync(OUT, { recursive: true });
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
  recordVideo: { dir: OUT, size: { width: 1600, height: 1000 } },
});
const page = await ctx.newPage();
await page.goto(`${BASE}/dev/atomic-bench?atoms=20&paused=0&badge=0`);
await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(3000);
const samples = [];
const sample = async (label) => {
  await page.waitForTimeout(250);
  const d = await page.evaluate(() => window.__atomicCamDbg);
  samples.push({ label, pos: d.pos, min: d.bounds.min, max: d.bounds.max });
  return d;
};
await page.mouse.move(800, 500);
await sample("start");
// Zoom out hard (wheel down), then in hard.
for (let i = 0; i < 40; i += 1) {
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(30);
}
await sample("zoom-out-limit");
await page.screenshot({ path: `${OUT}/zoom-out.png` });
for (let i = 0; i < 70; i += 1) {
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(30);
}
await sample("zoom-in-limit");
await page.screenshot({ path: `${OUT}/zoom-in.png` });
for (let i = 0; i < 25; i += 1) {
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(30);
}
// Orbit to extremes: drag far in each direction.
const drag = async (dx, dy, steps = 40) => {
  await page.mouse.move(800, 500);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(800 + (dx * i) / steps, 500 + (dy * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
};
for (const [label, dx, dy] of [
  ["orbit-left", -700, 0],
  ["orbit-right", 1400, 0],
  ["orbit-up", -700, 450],
  ["orbit-down", 0, -900],
]) {
  await drag(dx, dy);
  await sample(label);
  await page.screenshot({ path: `${OUT}/${label}.png` });
}
// Zoom out again from the extreme orbit, then pan (right-drag) to the limits.
for (let i = 0; i < 30; i += 1) {
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(30);
}
await sample("zoom-out-from-orbit");
await page.mouse.move(800, 500);
await page.mouse.down({ button: "right" });
for (let i = 1; i <= 40; i += 1) {
  await page.mouse.move(800 - i * 18, 500 + i * 6);
  await page.waitForTimeout(16);
}
await page.mouse.up({ button: "right" });
await sample("pan");
const margin = -1e-6; // strictly inside (soft clamp approaches the wall, never reaches it)
let worst = Infinity;
let inside = true;
for (const s of samples) {
  for (let a = 0; a < 3; a += 1) {
    const d = Math.min(s.pos[a] - s.min[a], s.max[a] - s.pos[a]);
    worst = Math.min(worst, d);
    if (d <= margin) inside = false;
  }
}
await page.waitForTimeout(500);
await ctx.close();
await browser.close();
console.log(JSON.stringify({ inside, worstClearance: +worst.toFixed(2), samples }, null, 1));
