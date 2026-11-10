#!/usr/bin/env node
/**
 * Step 11 revision: detail view on the REAL /home (Atomic mode, real fleet), headed
 * Chrome on the real GPU. Opens a provider-atom detail view (and a GPU-atom one if a
 * real GPU atom exists), measures frame times with it open, then verifies Esc and
 * Reset-view exits and the camera returning to the prior framing.
 *   node scripts/ad-hoc/pw-atomic-step11-home.mjs <outDir>
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const outDir = process.argv[2] ?? "/tmp/step11-home";
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
    ...(process.env.UNCAPPED ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"] : []),
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  ...(process.env.VIDEO
    ? { recordVideo: { dir: outDir, size: { width: 1440, height: 900 } } }
    : {}),
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
await page.goto(`${base}/home`);
const group = page.locator('[role="group"][aria-label="Topology view mode"]');
await group.waitFor({ timeout: 120000 });
await group.getByRole("button", { name: "Atomic" }).click();
await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
await page.waitForTimeout(8000);
const cam = () =>
  page.evaluate(() => {
    const d = window.__atomicCamDbg;
    return (
      d && { pos: d.pos.map((v) => Math.round(v)), target: d.target.map((v) => Math.round(v)) }
    );
  });
const perf = () =>
  page.evaluate(
    () =>
      new Promise((res) => {
        const d = [];
        let last = performance.now();
        const t0 = last;
        const tick = (now) => {
          d.push(now - last);
          last = now;
          if (now - t0 < 5000) requestAnimationFrame(tick);
          else {
            d.shift();
            const a = [...d].sort((x, y) => x - y);
            const q = (p) =>
              Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] * 10) / 10;
            res({
              fps: Math.round((d.length / (d.reduce((x, y) => x + y, 0) / 1000)) * 10) / 10,
              p50: q(0.5),
              p95: q(0.95),
              p99: q(0.99),
              spikes30: d.filter((x) => x > 30).length,
            });
          }
        };
        requestAnimationFrame(tick);
      })
  );
const ids = await page.evaluate(() =>
  [...document.querySelectorAll(".atomic-labels [data-atom-id]")].map((e) => ({
    id: e.getAttribute("data-atom-id"),
    chip: e.querySelector(".atomic-labels__state")?.textContent,
  }))
);
const report = { atoms: ids, errors, runs: [] };
report.defaultCam = await cam();
report.perfDefault = await perf();
await page.screenshot({ path: path.join(outDir, "home-default.png") });
const pick = (prefix) => ids.find((a) => a.id.startsWith(prefix));
const targets = [
  { name: "provider", atom: ids.find((a) => a.id === "provider:openai") ?? pick("provider:") },
  { name: "hub", atom: pick("hub") },
  { name: "gpu", atom: pick("gpu:") },
].filter((t) => t.atom);
report.gpuAtomPresent = Boolean(pick("gpu:"));
for (const t of targets) {
  const run = { name: t.name, id: t.atom.id, chipBefore: t.atom.chip };
  await page.evaluate(() => document.querySelector('[data-atomic-control="reset"]')?.click());
  await page.waitForTimeout(1500);
  const before = await cam();
  // A real provider label click also navigates to the provider page (existing, frozen
  // behaviour), so use the dev-only hook that runs the same focus + open-detail path.
  run.opened = await page.evaluate((i) => window.__atomicOpenDetail?.(i), t.atom.id);
  await page.waitForTimeout(4500);
  run.detailCam = await cam();
  run.panel = await page.evaluate(
    () => document.querySelector('[data-atomic-detail="true"]')?.textContent.slice(0, 420) ?? null
  );
  run.labelDisplay = await page.evaluate((i) => {
    const e = document.querySelector(`.atomic-labels [data-atom-id="${i}"]`);
    return e ? getComputedStyle(e).display : "missing";
  }, t.atom.id);
  run.chipInLabel = t.atom.chip;
  await page.screenshot({ path: path.join(outDir, `home-detail-${t.name}.png`) });
  run.perfDetail = await perf();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2500);
  run.panelAfterEsc = await page.locator('[data-atomic-detail="true"]').count();
  run.camAfterEsc = await cam();
  await page.evaluate((i) => window.__atomicOpenDetail?.(i), t.atom.id);
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.querySelector('[data-atomic-control="reset"]')?.click());
  await page.waitForTimeout(2500);
  run.panelAfterReset = await page.locator('[data-atomic-detail="true"]').count();
  run.camAfterReset = await cam();
  run.camBeforeAll = before;
  report.runs.push(run);
}
const video = page.video();
await ctx.close();
if (video) fs.renameSync(await video.path(), path.join(outDir, "home-detail-flow.webm"));
await browser.close();
fs.writeFileSync(path.join(outDir, "home-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
