#!/usr/bin/env node
/**
 * Directive 36 live check (headed Chrome, real GPU): two samples of every electron
 * orbit angle ~1 s apart on the bench (paused=0, paused=1, reduced motion) and the
 * real /home. Reports min/median displacement per orbit across all atoms.
 *   node scripts/ad-hoc/pw-atomic-electrons.mjs <out.json>
 */
import { chromium } from "playwright";
import fs from "node:fs";
const out = process.argv[2] ?? "/tmp/electrons.json";
const base = process.env.BENCH_BASE ?? "http://localhost:20199";
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const report = {};
const TAU = Math.PI * 2;
async function sample(page, gapMs) {
  const snap = () =>
    page.evaluate(() => (window.__atomicElectronDbg ?? []).map((r) => (r ? [...r] : [])));
  const a = await snap();
  await page.waitForTimeout(gapMs);
  const b = await snap();
  const d = [];
  a.forEach((row, r) =>
    row.forEach((v, w) => {
      const x = Math.abs(v - b[r]?.[w]) % TAU;
      d.push({ r, w, rad: Math.min(x, TAU - x) });
    })
  );
  const s = d.map((x) => x.rad).sort((p, q) => p - q);
  return {
    atoms: a.length,
    orbits: d.length,
    minRad: s[0] ?? null,
    medianRad: s[Math.floor(s.length / 2)] ?? null,
    stillOrbits: d.filter((x) => x.rad < 0.05).length,
  };
}
async function run(name, url, { reduced = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(reduced ? { reducedMotion: "reduce" } : {}),
  });
  const page = await ctx.newPage();
  await page.goto(url);
  if (name === "home") {
    const group = page.locator('[role="group"][aria-label="Topology view mode"]');
    await group.waitFor({ timeout: 120000 });
    await group.getByRole("button", { name: "Atomic" }).click();
    await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
    await page.waitForTimeout(9000);
  } else await page.waitForTimeout(5000);
  report[name] = await sample(page, 1000);
  await ctx.close();
}
await run("bench-paused0", `${base}/dev/atomic-bench?atoms=20&paused=0`);
await run("bench-paused1", `${base}/dev/atomic-bench?atoms=20&paused=1`);
await run("bench-reduced", `${base}/dev/atomic-bench?atoms=20&paused=0`, { reduced: true });
await run("home", `${base}/home`);
await browser.close();
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
