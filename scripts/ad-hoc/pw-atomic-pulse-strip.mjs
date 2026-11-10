#!/usr/bin/env node
/**
 * Directive 39.2: trace-pulse proof in stills. Headed Chrome on the real GPU, bench (20 atoms,
 * motion on). A CDP screencast collects every presented frame with its timestamp; the 8 frames
 * nearest 0, 150, ..., 1050 ms are saved (default zoom, then the detail-view board close-up),
 * with the real capture times in strip-report.json. Assemble with pulse-strip.py.
 *   node scripts/ad-hoc/pw-atomic-pulse-strip.mjs <outDir>
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const outDir = process.argv[2] ?? "/tmp/atomic-pulse-strip";
const base = process.env.BENCH_BASE ?? "http://localhost:20199";
const query = process.env.BENCH_QUERY ?? "atoms=20&paused=0&instance=1";
const FRAMES = 8;
const STEP_MS = 150;
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
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
await page.goto(`${base}/dev/atomic-bench?${query}`);
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(9000);
const cdp = await ctx.newCDPSession(page);
async function strip(tag) {
  const frames = [];
  const onFrame = async (f) => {
    frames.push({ t: f.metadata.timestamp * 1000, data: f.data });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  };
  cdp.on("Page.screencastFrame", onFrame);
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    maxWidth: 3200,
    maxHeight: 2000,
    everyNthFrame: 1,
  });
  await page.waitForTimeout(FRAMES * STEP_MS + 900);
  await cdp.send("Page.stopScreencast");
  cdp.off("Page.screencastFrame", onFrame);
  // Skip the first frames (screencast warm-up), then pick the nearest to each 150 ms tick.
  const t0 = frames[Math.min(3, frames.length - 1)].t;
  const picked = [];
  for (let k = 0; k < FRAMES; k += 1) {
    const goal = t0 + k * STEP_MS;
    let best = null;
    for (const f of frames) if (!best || Math.abs(f.t - goal) < Math.abs(best.t - goal)) best = f;
    const name = `${tag}-${k}.jpg`;
    fs.writeFileSync(path.join(outDir, name), Buffer.from(best.data, "base64"));
    picked.push({ file: name, tMs: Math.round(best.t - t0) });
  }
  return { capturedFrames: frames.length, picked };
}
const report = { errors };
report.default = await strip("default");
const id = await page.evaluate(
  () =>
    [...document.querySelectorAll(".atomic-labels [data-atom-id]")]
      .map((e) => e.getAttribute("data-atom-id"))
      .find((i) => i && !i.startsWith("hub")) ?? null
);
report.detailAtom = id;
await page.evaluate((i) => window.__atomicOpenDetail?.(i), id);
await page.waitForTimeout(5500);
report.closeup = await strip("closeup");
await browser.close();
fs.writeFileSync(path.join(outDir, "strip-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
