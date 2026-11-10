#!/usr/bin/env node
/**
 * Real dashboard captures (headed Chrome, real GPU): `/home` in Atomic mode with the
 * REAL fleet from this dev server. Prints the small-atom LOD distribution (dev-only
 * `window.__atomicLodStats`) and writes a screenshot per case.
 *
 *   node scripts/ad-hoc/pw-atomic-home.mjs <outDir> <name>=<query> ...
 *   e.g. real=  mixed=topology-demo=mixed-lanes  stale=topology-demo=unknown-stale
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const [outDir, ...cases] = process.argv.slice(2);
const base = process.env.BENCH_BASE ?? "http://localhost:20199";
const VW = Number(process.env.VW ?? 1440);
const VH = Number(process.env.VH ?? 900);
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
for (const c of cases) {
  const eq = c.indexOf("=");
  const name = c.slice(0, eq);
  const query = c.slice(eq + 1);
  const ctx = await browser.newContext({
    viewport: { width: VW, height: VH },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
  await page.goto(`${base}/home${query ? `?${query}` : ""}`);
  const group = page.locator('[role="group"][aria-label="Topology view mode"]');
  await group.waitFor({ timeout: 120000 });
  await group.getByRole("button", { name: "Atomic" }).click();
  await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
  await page.waitForTimeout(Number(process.env.WAIT ?? 8000));
  const stats = await page.evaluate(() => {
    const s = window.__atomicLodStats;
    if (!s) return null;
    const d = [...s.diameters].sort((a, b) => a - b);
    return {
      atoms: s.n,
      lodFull: s.lod,
      lodBlend: s.blend,
      lodFraction: +((s.lod + s.blend) / Math.max(1, s.n)).toFixed(3),
      diameterCssPx: { min: d[0], median: d[Math.floor(d.length / 2)], max: d[d.length - 1] },
    };
  });
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  const panel = page.locator(".atomic-scene-canvas").first();
  await panel.screenshot({ path: path.join(outDir, `${name}-panel.png`) }).catch(() => {});
  console.log(JSON.stringify({ name, file, stats, errors: [...new Set(errors)].slice(0, 3) }));
  await ctx.close();
}
await browser.close();
