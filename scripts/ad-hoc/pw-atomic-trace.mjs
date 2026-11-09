#!/usr/bin/env node
/** Chrome trace (CDP) of the bench: busy time per process/thread, to separate renderer-main, GPU-process CPU and GPU. */
import { chromium } from "playwright";
import fs from "node:fs";
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
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto(`${BASE}/dev/atomic-bench?${query}`);
await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(3000);
await browser.startTracing(page, { categories: ["-*", "toplevel", "gpu"], screenshots: false });
await page.waitForTimeout(1500);
const buf = await browser.stopTracing();
fs.writeFileSync("/tmp/atomic-trace.json", buf);
const tr = JSON.parse(buf.toString());
const ev = tr.traceEvents ?? tr;
const names = {};
const tnames = {};
for (const e of ev) {
  if (e.ph === "M" && e.name === "process_name") names[e.pid] = e.args.name;
  if (e.ph === "M" && e.name === "thread_name") tnames[`${e.pid}:${e.tid}`] = e.args.name;
}
const busy = {};
for (const e of ev) {
  if (e.ph !== "X" || !e.dur) continue;
  const k = `${names[e.pid] ?? e.pid} / ${tnames[`${e.pid}:${e.tid}`] ?? e.tid}`;
  busy[k] = (busy[k] ?? 0) + e.dur;
}
const top = Object.entries(busy)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 14)
  .map(([k, v]) => [k, +(v / 1500).toFixed(1) + "%"]);
console.log(top.map((x) => x.join("  ")).join("\n"));
// Top event names in GPU process threads
const byName = {};
for (const e of ev) {
  if (e.ph !== "X" || !e.dur) continue;
  const pn = names[e.pid] ?? "";
  if (!/GPU/i.test(pn)) continue;
  const k = e.name;
  const x = byName[k] ?? (byName[k] = [0, 0]);
  x[0] += e.dur;
  x[1]++;
}
console.log("--- GPU process top events (ms over 3s, count)");
console.log(
  Object.entries(byName)
    .sort((a, b) => b[1][0] - a[1][0])
    .slice(0, 14)
    .map(([k, [d, n]]) => `${k}  ${(d / 1000).toFixed(0)}ms  n=${n}`)
    .join("\n")
);
await browser.close();
