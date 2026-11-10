#!/usr/bin/env node
/** Gate A motion recordings (headed Chrome, real GPU): node pw-atomic-gateA-video.mjs <outDir> <name> <query> [seconds] */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const [outDir, name, query, secs = "12"] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();
await page.goto(
  `${process.env.BENCH_BASE ?? "http://localhost:20199"}/dev/atomic-bench?atomic-fx=rt&${query}`
);
await page.waitForSelector('[data-atomic-bench="rt"][data-ready="true"]', { timeout: 180000 });
await page.waitForTimeout(Number(secs) * 1000);
const v = page.video();
await ctx.close();
fs.renameSync(await v.path(), path.join(outDir, `${name}.webm`));
await browser.close();
console.log(`${name}.webm recorded (${secs}s)`);
