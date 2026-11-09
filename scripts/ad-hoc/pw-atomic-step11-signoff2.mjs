#!/usr/bin/env node
/**
 * Step 11 sign-off 2 (directive 38): REAL /home, Atomic mode, real fleet, headed Chrome on
 * the real GPU. Captures the default card, the OpenAI provider and hub detail views in the
 * small card, the same in fullscreen, the safe-area composition the renderer chose, perf with
 * detail open, the toggle's computed colours, and every console error/warning.
 *   node scripts/ad-hoc/pw-atomic-step11-signoff2.mjs <outDir>
 *   UNCAPPED=1 (perf without vsync), VIDEO=1 (record)
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const outDir = process.argv[2] ?? "/tmp/step11-signoff2";
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
const consoleLog = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    consoleLog.push({ type: m.type(), text: m.text().slice(0, 400) });
});
page.on("pageerror", (e) => consoleLog.push({ type: "pageerror", text: String(e).slice(0, 400) }));
await page.goto(`${base}/home`);
const group = page.locator('[role="group"][aria-label="Topology view mode"]');
await group.waitFor({ timeout: 120000 });
await group.getByRole("button", { name: "Atomic" }).click();
await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
await page.waitForTimeout(8000);
const host = page.locator("[data-atomic-host]").first();
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
const composition = () =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.__atomicDetailComposition ?? null)));
const toggleColors = () =>
  page.evaluate(() => {
    const g = document.querySelector('[role="group"][aria-label="Topology view mode"]');
    if (!g) return null;
    return [...g.querySelectorAll("button")].map((b) => {
      const cs = getComputedStyle(b);
      return {
        label: b.textContent,
        color: cs.color,
        bg: cs.backgroundColor,
        groupBg: getComputedStyle(g).backgroundColor,
      };
    });
  });
const report = { consoleLog, runs: [] };
report.toggle = await toggleColors();
await page.screenshot({ path: path.join(outDir, "home-default.png") });
await host.screenshot({ path: path.join(outDir, "home-card-default.png") });
report.defaultCam = await cam();
// Directive 40: which real atoms light their feeder traces, and on what basis.
report.feeders = await page.evaluate(() =>
  JSON.parse(JSON.stringify(window.__atomicFeeders ?? null))
);
report.traceStats = await page.evaluate(() =>
  JSON.parse(JSON.stringify(window.__atomicTraceStats ?? null))
);
report.perfDefault = await perf();
const ids = await page.evaluate(() =>
  [...document.querySelectorAll(".atomic-labels [data-atom-id]")].map((e) =>
    e.getAttribute("data-atom-id")
  )
);
report.atoms = ids;
report.gpuAtomPresent = ids.some((i) => i.startsWith("gpu:"));
const targets = [
  { name: "openai", id: ids.find((i) => i === "provider:openai") },
  { name: "hub", id: ids.find((i) => i.startsWith("hub")) },
  { name: "gpu", id: ids.find((i) => i.startsWith("gpu:")) },
].filter((t) => t.id);
async function detailRun(t, tag) {
  const run = { name: t.name, id: t.id, mode: tag };
  await page.evaluate(() => document.querySelector('[data-atomic-control="reset"]')?.click());
  await page.waitForTimeout(1500);
  run.camBefore = await cam();
  run.opened = await page.evaluate((i) => window.__atomicOpenDetail?.(i), t.id);
  await page.waitForTimeout(5000);
  run.composition = await composition();
  run.detailCam = await cam();
  // Directive 39.1: no visible neighbour label may overlap the hero silhouette or panel.
  run.labels = await page.evaluate((focus) => {
    const m = window.__atomicLabelMask ?? null;
    const sil = m?.silhouette ?? null;
    const panel = document.querySelector("[data-atomic-detail]")?.getBoundingClientRect();
    const hitsSil = (r) => {
      if (!sil) return false;
      const nx = Math.max(r.left, Math.min(sil.x, r.right));
      const ny = Math.max(r.top, Math.min(sil.y, r.bottom));
      return (nx - sil.x) ** 2 + (ny - sil.y) ** 2 <= sil.r ** 2;
    };
    const hitsPanel = (r) =>
      Boolean(panel) &&
      r.left < panel.right &&
      r.right > panel.left &&
      r.top < panel.bottom &&
      r.bottom > panel.top;
    const visibleOverlaps = [];
    let visible = 0;
    for (const el of document.querySelectorAll(".atomic-labels [data-atom-id]")) {
      const id = el.getAttribute("data-atom-id");
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const shown =
        id !== focus &&
        cs.display !== "none" &&
        cs.visibility !== "hidden" &&
        Number(cs.opacity) > 0.02 &&
        r.width > 0;
      if (!shown) continue;
      visible += 1;
      if (hitsSil(r) || hitsPanel(r)) visibleOverlaps.push(id);
    }
    return { masked: m?.ids ?? null, silhouette: sil, visible, visibleOverlaps };
  }, t.id);
  await host.screenshot({ path: path.join(outDir, `${tag}-detail-${t.name}.png`) });
  run.perfDetail = await perf();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2500);
  run.panelAfterEsc = await page.locator('[data-atomic-detail="true"]').count();
  run.camAfterEsc = await cam();
  run.labelsAfterEsc = await page.evaluate(() => ({
    maskStyles: document.querySelectorAll("[data-atomic-detail-label-mask]").length,
    transparent: [...document.querySelectorAll(".atomic-labels [data-atom-id]")].filter(
      (el) => Number(getComputedStyle(el).opacity) < 0.98
    ).length,
  }));
  run.viewOffsetCleared = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector("[data-atomic-host]")).getPropertyValue(
        "--atomic-lens-x"
      ) === ""
  );
  report.runs.push(run);
}
for (const t of targets) await detailRun(t, "card");
// Fullscreen: the same flow inside the Fullscreen API host.
// Chrome only grants fullscreen to a focused window: focus it first (header, no-op area).
await page.bringToFront();
await page.mouse.click(1000, 40);
await page.locator('[data-atomic-control="fullscreen"]').click();
await page.waitForTimeout(2500);
report.fullscreenActive = await page.evaluate(() => Boolean(document.fullscreenElement));
for (const t of targets.filter((x) => x.name !== "gpu")) {
  // Esc in fullscreen leaves fullscreen first; re-enter before each run.
  if (!(await page.evaluate(() => Boolean(document.fullscreenElement)))) {
    await page.bringToFront();
    await page.locator('[data-atomic-control="fullscreen"]').click();
    await page.waitForTimeout(2000);
  }
  await detailRun(t, "fullscreen");
}
const video = page.video();
await ctx.close();
if (video) fs.renameSync(await video.path(), path.join(outDir, "signoff2-flow.webm"));
await browser.close();
fs.writeFileSync(path.join(outDir, "signoff2-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
