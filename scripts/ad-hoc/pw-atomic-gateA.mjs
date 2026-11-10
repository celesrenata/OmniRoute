#!/usr/bin/env node
/**
 * Gate A capture: HEADED Chrome with the real GPU (never headless / SwiftShader).
 *
 *   node scripts/ad-hoc/pw-atomic-gateA.mjs <outDir> <name>=<query> [<name>=<query> ...]
 *
 * Each query is appended to /dev/atomic-bench?atomic-fx=rt&... and captured at
 * 1672x941 CSS px with deviceScaleFactor 2 (full retina). Prints the GPU
 * adapter, the active backend and any console errors per capture.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [outDir, ...cases] = process.argv.slice(2);
const base = process.env.BENCH_BASE ?? "http://localhost:20199";
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
const context = await browser.newContext({
  viewport: { width: 1672, height: 941 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on("crash", () => console.log("PAGE CRASH"));
browser.on("disconnected", () => console.log("BROWSER DISCONNECTED"));
page.on("pageerror", (e) => errors.push(`[pageerror] ${String(e).slice(0, 300)}`));

for (const c of cases) {
  const eq = c.indexOf("=");
  const name = c.slice(0, eq);
  const query = c.slice(eq + 1);
  errors.length = 0;
  const url = `${base}/dev/atomic-bench?atomic-fx=rt&${query}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector('[data-atomic-bench="rt"][data-ready="true"]', { timeout: 180000 });
  } catch {
    const st = await page.evaluate(() => {
      const el = document.querySelector('[data-atomic-bench="rt"]');
      return el ? JSON.stringify(el.dataset) : "no host";
    });
    console.log(`${name}: NOT READY ${st}`);
  }
  await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 1500));
  const info = await page.evaluate(async () => {
    const host = document.querySelector('[data-atomic-bench="rt"]');
    let adapter = "n/a";
    try {
      const a = await navigator.gpu?.requestAdapter();
      const i = a?.info;
      adapter = i ? `${i.vendor}/${i.architecture}/${i.description || i.device}` : "no adapter";
    } catch (e) {
      adapter = String(e);
    }
    return { backend: host?.dataset.backend, state: host?.dataset.state, adapter };
  });
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(
    `${name}: ${file} backend=${info.backend} state=${info.state ?? "ok"} adapter=${info.adapter}`
  );
  for (const e of errors.slice(0, 6)) console.log(`   ${e}`);
}
await browser.close();
