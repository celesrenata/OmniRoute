#!/usr/bin/env node
/** CPU sampling profile of the bench over the uncapped window, split into slow vs fast frames. */
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
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto(`${BASE}/dev/atomic-bench?${query}`);
await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(3500);
const cdp = await ctx.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
await cdp.send("Profiler.start");
const t = await page.evaluate(
  () =>
    new Promise((res) => {
      const rows = [];
      const o = performance.timeOrigin;
      let last = performance.now();
      const t0 = last;
      const tick = (n) => {
        rows.push([o + last, o + n]);
        last = n;
        if (n - t0 < 5000) requestAnimationFrame(tick);
        else res(rows);
      };
      requestAnimationFrame(tick);
    })
);
const { profile } = await cdp.send("Profiler.stop");
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
let ts = profile.startTime; // microseconds
const slowWin = t.filter(([a, b]) => b - a > 12).map(([a, b]) => [a * 1000, b * 1000]);
const agg = (pred) => {
  const m = new Map();
  profile.samples.forEach((id, i) => {
    ts += profile.timeDeltas[i];
  });
  ts = profile.startTime;
  const out = new Map();
  profile.samples.forEach((id, i) => {
    ts += profile.timeDeltas[i];
    if (!pred(ts)) return;
    const n = byId.get(id);
    const cf = n.callFrame;
    const k = `${cf.functionName || "(anon)"} ${cf.url.split("/").slice(-1)[0].slice(0, 40)}:${cf.lineNumber}`;
    out.set(k, (out.get(k) ?? 0) + (profile.timeDeltas[i + 1] ?? 100) / 1000);
  });
  return [...out.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => [k, Math.round(v)]);
};
// profile timestamps are in the monotonic clock (us); rAF times use performance.now()-based epoch, so match by offset:
// use first/last sample alignment: map rAF windows by the same relative offsets from window start.
const frameStart = t[0][0] * 1000,
  profEnd = profile.endTime;
const shift = profEnd - t[t.length - 1][1] * 1000; // align profile end to last rAF end
const inSlow = (x) => slowWin.some(([a, b]) => x >= a + shift && x <= b + shift);
console.log("slowFrames", slowWin.length, "of", t.length);
console.log("SLOW", JSON.stringify(agg(inSlow), null, 0));
console.log(
  "FAST",
  JSON.stringify(
    agg((x) => !inSlow(x)),
    null,
    0
  )
);
await browser.close();
