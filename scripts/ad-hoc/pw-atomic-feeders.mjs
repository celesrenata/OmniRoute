#!/usr/bin/env node
/**
 * Directive 40 evidence: usage-driven feeder traces on the DEMO bench (headed Chrome, real
 * GPU). For each uniform measured output tok/s (`?tps=`: idle 0 / 20 / 80) it records a
 * webm of the default view, saves a still, a 4-frame (150 ms) pulse strip source set, the
 * per-atom feeder basis/target/level and perf. Real /home: see pw-atomic-step11-signoff2.mjs
 * (it records window.__atomicFeeders).
 *   node scripts/ad-hoc/pw-atomic-feeders.mjs <outDir>
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const outDir = process.argv[2] ?? "/tmp/atomic-feeders";
const base = process.env.BENCH_BASE ?? "http://localhost:20199";
const levels = (process.env.TPS ?? "0,20,80").split(",").map(Number);
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
const report = { runs: [] };
for (const tps of levels) {
  const tag = tps === 0 ? "idle" : `tps${tps}`;
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    recordVideo: { dir: outDir, size: { width: 1600, height: 1000 } },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/dev/atomic-bench?atoms=20&paused=0&instance=1&tps=${tps}`);
  await page.waitForSelector("canvas", { timeout: 120000 });
  await page.waitForTimeout(9000);
  const run = { tps, tag, errors };
  run.feeders = await page.evaluate(() =>
    JSON.parse(JSON.stringify(window.__atomicFeeders ?? null))
  );
  run.traceStats = await page.evaluate(() =>
    JSON.parse(JSON.stringify(window.__atomicTraceStats ?? null))
  );
  await page.screenshot({
    path: path.join(outDir, `${tag}-default.jpg`),
    type: "jpeg",
    quality: 92,
  });
  // Pulse-rate proof in stills: 4 frames ~150 ms apart (CDP screencast timestamps).
  const cdp = await ctx.newCDPSession(page);
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
  });
  await page.waitForTimeout(1500);
  await cdp.send("Page.stopScreencast");
  cdp.off("Page.screencastFrame", onFrame);
  const t0 = frames[Math.min(3, frames.length - 1)].t;
  run.strip = [];
  for (let k = 0; k < 4; k += 1) {
    let best = null;
    for (const f of frames)
      if (!best || Math.abs(f.t - (t0 + k * 150)) < Math.abs(best.t - (t0 + k * 150))) best = f;
    const name = `${tag}-f${k}.jpg`;
    fs.writeFileSync(path.join(outDir, name), Buffer.from(best.data, "base64"));
    run.strip.push({ file: name, tMs: Math.round(best.t - t0) });
  }
  run.perf = await page.evaluate(
    () =>
      new Promise((res) => {
        const d = [];
        let last = performance.now();
        const t0 = last;
        const tick = (now) => {
          d.push(now - last);
          last = now;
          if (now - t0 < 3000) requestAnimationFrame(tick);
          else {
            d.shift();
            res({ fps: Math.round((d.length / (d.reduce((x, y) => x + y, 0) / 1000)) * 10) / 10 });
          }
        };
        requestAnimationFrame(tick);
      })
  );
  await page.waitForTimeout(3000);
  const video = page.video();
  await ctx.close();
  if (video) fs.renameSync(await video.path(), path.join(outDir, `feeders-${tag}.webm`));
  report.runs.push(run);
}
await browser.close();
fs.writeFileSync(path.join(outDir, "feeders-report.json"), JSON.stringify(report, null, 2));
for (const r of report.runs) {
  const lv = Object.values(r.feeders ?? {}).map((f) => f.level ?? 0);
  console.log(
    r.tag,
    "fps",
    r.perf.fps,
    "errors",
    r.errors.length,
    "lit",
    lv.filter((x) => x > 0).length,
    "maxLevel",
    Math.max(...lv).toFixed(3),
    "strip",
    r.strip.map((s) => s.tMs)
  );
}
