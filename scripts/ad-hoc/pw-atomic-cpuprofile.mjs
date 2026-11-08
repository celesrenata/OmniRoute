#!/usr/bin/env node
/** CPU profile (CDP) of the animated bench: top self-time functions. Usage: node pw-atomic-cpuprofile.mjs <query> */
import { chromium } from "playwright";
const [query] = process.argv.slice(2);
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
const page = await (
  await browser.newContext({ viewport: { width: 1672, height: 941 }, deviceScaleFactor: 2 })
).newPage();
await page.goto(
  `${process.env.BENCH_BASE ?? "http://localhost:20199"}/dev/atomic-bench?atomic-fx=rt&${query}`
);
await page.waitForSelector('[data-atomic-bench="rt"][data-ready="true"]', { timeout: 180000 });
await page.waitForTimeout(2500);
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.start");
await page.waitForTimeout(5000);
const { profile } = await cdp.send("Profiler.stop");
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dts = profile.timeDeltas;
profile.samples.forEach((id, i) => {
  const n = byId.get(id);
  const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber}`;
  self.set(k, (self.get(k) ?? 0) + (dts[i] ?? 0) / 1000);
});
[...self.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 14)
  .forEach(([k, v]) => console.log(v.toFixed(0).padStart(6), "ms", k));
await browser.close();
