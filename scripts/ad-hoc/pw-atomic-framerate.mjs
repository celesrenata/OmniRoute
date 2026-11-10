#!/usr/bin/env node
/**
 * Directive 45 evidence: 30 fps default vs "Sync to display refresh rate", on the real /home
 * (Atomic), window on the built-in 120 Hz panel, normal vsync (no uncapping flags).
 *
 * Per state x mode it records over WINDOW_MS:
 *   - rendered-frame intervals (dev-only `window.__atomicFrameTimes`, written by the FrameDriver
 *     only when a frame is actually rendered) -> fps + histogram;
 *   - GPU "Device Utilization %" (ioreg, whole GPU) and system power in (AppleSmartBattery
 *     SystemPowerIn, mW, whole machine), sampled every 500 ms.
 * States: rest (default view), interact (continuous orbit drag), fsdetail (fullscreen + OpenAI
 * detail), replay (recorded-request replay playing). A blank-page baseline is sampled first.
 *
 *   node scripts/ad-hoc/pw-atomic-framerate.mjs <outJson> [rounds=2]
 * Also: `persist` mode checks the checkbox survives a reload:
 *   node scripts/ad-hoc/pw-atomic-framerate.mjs persist
 */
import { chromium } from "playwright";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const WINDOW = Number(process.env.WINDOW_MS ?? 8000);
const [arg1 = "/tmp/framerate.json", rounds = "2"] = process.argv.slice(2);

function ioregNum(cls, key) {
  try {
    const out = execFileSync("ioreg", ["-r", "-d", "1", "-w0", "-c", cls], { encoding: "utf8" });
    const m = out.match(new RegExp(`"${key}"=(\\d+)`));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
const gpuUtil = () => ioregNum("IOAccelerator", "Device Utilization %");
const powerMw = () => ioregNum("AppleSmartBattery", "SystemPowerIn");

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1600,1000",
    "--window-position=0,0",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

async function openHome(sync) {
  await page.goto(`${BASE}/home`);
  await page.evaluate(
    (s) => localStorage.setItem("omniroute.atomic.syncRefresh", s ? "1" : "0"),
    sync
  );
  await page.reload();
  const group = page.locator('[role="group"][aria-label="Topology view mode"]');
  await group.waitFor({ timeout: 120000 });
  await group.getByRole("button", { name: "Atomic" }).click();
  await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
  await page.waitForTimeout(7000);
}

async function measure(during) {
  await page.evaluate(() => (window.__atomicFrameTimes = []));
  const util = [];
  const pw = [];
  const t0 = Date.now();
  const sampler = (async () => {
    while (Date.now() - t0 < WINDOW) {
      util.push(gpuUtil());
      pw.push(powerMw());
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  await Promise.all([sampler, during ? during(WINDOW) : page.waitForTimeout(WINDOW)]);
  const times = await page.evaluate(() => window.__atomicFrameTimes ?? []);
  const iv = times.slice(1).map((t, i) => t - times[i]);
  const hist = {};
  for (const d of iv) {
    const b = `${Math.round(d / 4.1667) * 4.1667 >= 100 ? ">=100" : (Math.round(d / 4.1667) * 4.1667).toFixed(1)}`;
    hist[b] = (hist[b] ?? 0) + 1;
  }
  const s = [...iv].sort((a, b) => a - b);
  const q = (p) =>
    s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null;
  const mean = (a) => {
    const b = a.filter((x) => x != null);
    return b.length ? +(b.reduce((x, y) => x + y, 0) / b.length).toFixed(1) : null;
  };
  return {
    frames: times.length,
    fps: iv.length ? +(iv.length / ((times[times.length - 1] - times[0]) / 1000)).toFixed(2) : 0,
    intervalMs: { p5: q(0.05), p50: q(0.5), p95: q(0.95), max: q(1) },
    histogramMs: hist,
    gpuUtilPct: {
      mean: mean(util),
      min: Math.min(...util.filter((x) => x != null)),
      max: Math.max(...util.filter((x) => x != null)),
    },
    systemPowerW: mean(pw) != null ? +(mean(pw) / 1000).toFixed(2) : null,
  };
}

const drag = async (ms) => {
  const c = page.locator(".atomic-scene-canvas canvas").first();
  const b = await c.boundingBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const t0 = Date.now();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  let k = 0;
  while (Date.now() - t0 < ms) {
    k += 1;
    await page.mouse.move(cx + Math.cos(k / 10) * 120, cy + Math.sin(k / 14) * 40, { steps: 2 });
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
};

if (arg1 === "persist") {
  // Checkbox on -> reload -> still on (and the loop is synced); off -> reload -> off (30 fps).
  const out = {};
  await openHome(false);
  const box = page.locator('[data-atomic-control="sync-refresh"] input');
  out.defaultChecked = await box.isChecked();
  out.defaultMode = await page.evaluate(() => window.__atomicFrameRate?.());
  out.tooltip = await page.locator('[data-atomic-control="sync-refresh"]').getAttribute("title");
  await box.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(500);
  out.afterKeyboardToggle = await box.isChecked();
  out.stored = await page.evaluate(() => localStorage.getItem("omniroute.atomic.syncRefresh"));
  await page.reload();
  const group = page.locator('[role="group"][aria-label="Topology view mode"]');
  await group.waitFor({ timeout: 120000 });
  await group.getByRole("button", { name: "Atomic" }).click();
  await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
  await page.waitForTimeout(5000);
  out.afterReloadChecked = await page
    .locator('[data-atomic-control="sync-refresh"] input')
    .isChecked();
  out.afterReloadMode = await page.evaluate(() => window.__atomicFrameRate?.());
  out.afterReloadFps = (await measure()).fps;
  await page.locator('[data-atomic-control="sync-refresh"] input').click();
  await page.waitForTimeout(800);
  out.uncheckedMode = await page.evaluate(() => window.__atomicFrameRate?.());
  out.uncheckedFps = (await measure()).fps;
  await page.reload();
  await group.waitFor({ timeout: 120000 });
  await group.getByRole("button", { name: "Atomic" }).click();
  await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
  await page.waitForTimeout(4000);
  out.afterSecondReloadChecked = await page
    .locator('[data-atomic-control="sync-refresh"] input')
    .isChecked();
  await page
    .locator('[data-atomic-control="sync-refresh"]')
    .screenshot({ path: "/tmp/sync-refresh-chip.png" });
  await page.locator(".atomic-controls").first().screenshot({ path: "/tmp/atomic-controls.png" });
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(0);
}

const results = [];
await page.goto("about:blank");
await page.waitForTimeout(3000);
results.push({ state: "blank-page", mode: "-", ...(await measure()) });
console.log(JSON.stringify(results[results.length - 1]));
for (let r = 1; r <= Number(rounds); r += 1) {
  for (const sync of [false, true]) {
    const mode = sync ? "sync" : "30";
    await openHome(sync);
    results.push({ round: r, state: "rest", mode, ...(await measure()) });
    console.log(JSON.stringify(results[results.length - 1]));
    results.push({ round: r, state: "interact", mode, ...(await measure(drag)) });
    console.log(JSON.stringify(results[results.length - 1]));
    await page.evaluate(() => window.__atomicReplay?.open());
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      window.__atomicReplay?.setSpeed?.(8);
      window.__atomicReplay?.play();
    });
    results.push({ round: r, state: "replay", mode, ...(await measure()) });
    console.log(JSON.stringify(results[results.length - 1]));
    await page.evaluate(() => window.__atomicReplay?.close());
    await page.waitForTimeout(1500);
    await page.bringToFront();
    await page.mouse.click(1000, 40);
    await page.locator('[data-atomic-control="fullscreen"]').click();
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.__atomicOpenDetail?.("provider:openai"));
    await page.waitForTimeout(5000);
    results.push({ round: r, state: "fsdetail", mode, ...(await measure()) });
    console.log(JSON.stringify(results[results.length - 1]));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
  }
}
fs.writeFileSync(arg1, JSON.stringify(results, null, 2));
await browser.close();
