#!/usr/bin/env node
/**
 * Step 11 captures (headed Chrome, real GPU): the opt-in GPU detail view driven
 * through the REAL UI path (focus a GPU atom -> tooltip -> "Open detail view"),
 * on the golden DEMO topology (`/dev/atomic-bench`).
 *
 *   node scripts/ad-hoc/pw-atomic-step11.mjs <outDir>
 *   VIDEO=1 node ...   # also record the whole flow as webm
 *
 * Writes: default.jpg, focus.jpg, detail-t<ms>.jpg (fly-in frames), detail.jpg,
 * exit.jpg, detail-reduced.jpg, plus step11-report.json (DOM facts, camera distances,
 * console errors). Dev-only `window.__atomicCamDbg` supplies camera positions.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2] ?? "/tmp/step11";
const base = process.env.BENCH_BASE ?? "http://localhost:20199";
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    ...(process.env.UNCAPPED ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"] : []),
  ],
});
const report = { errors: [], steps: {} };

async function session(name, { reduced = false, video = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    ...(reduced ? { reducedMotion: "reduce" } : {}),
    ...(video ? { recordVideo: { dir: outDir, size: { width: 1600, height: 1000 } } } : {}),
  });
  const page = await ctx.newPage();
  page.on(
    "console",
    (m) => m.type() === "error" && report.errors.push(`${name}: ${m.text().slice(0, 200)}`)
  );
  page.on("pageerror", (e) => report.errors.push(`${name}: pageerror ${String(e).slice(0, 200)}`));
  return { ctx, page };
}

const framePerf = (page) =>
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
const camDist = (page) =>
  page.evaluate(() => {
    const d = window.__atomicCamDbg;
    if (!d) return null;
    return {
      dist: Math.hypot(d.pos[0] - d.target[0], d.pos[1] - d.target[1], d.pos[2] - d.target[2]),
      pos: d.pos.map((v) => Math.round(v)),
      target: d.target.map((v) => Math.round(v)),
    };
  });

async function gpuId(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-atom-id]")].find((e) =>
      e.getAttribute("data-atom-id")?.startsWith("gpu:")
    );
    return el?.getAttribute("data-atom-id") ?? null;
  });
}

// ---- Flow 1: default -> focus -> detail (fly-in frames) -> exit -------------
{
  const { ctx, page } = await session("flow", { video: !!process.env.VIDEO });
  await page.goto(`${base}/dev/atomic-bench?atoms=20&paused=0&instance=1`);
  await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
  await page.waitForTimeout(3500);
  const id = await gpuId(page);
  report.gpuId = id;
  report.steps.defaultCam = await camDist(page);
  report.steps.perfDefault = await framePerf(page);
  report.steps.detailPanelAtDefault = await page.locator('[data-atomic-detail="true"]').count();
  report.steps.openButtonAtDefault = await page.locator("[data-atomic-open-detail]").count();
  await page.screenshot({ type: "jpeg", quality: 88, path: path.join(outDir, "default.jpg") });

  // Focus the GPU atom through the real label control (what a viewer clicks).
  await page.locator(`[data-atom-id="${id}"]`).first().click({ force: true });
  await page.waitForTimeout(2500);
  report.steps.focusCam = await camDist(page);
  report.steps.perfFocus = await framePerf(page);
  report.steps.openButtonAtFocus = await page.locator("[data-atomic-open-detail]").count();
  await page.screenshot({ type: "jpeg", quality: 88, path: path.join(outDir, "focus.jpg") });

  // Opt in: the tooltip's button.
  await page.locator("[data-atomic-open-detail]").click();
  report.steps.flight = [];
  const t0 = Date.now();
  for (const at of [250, 700, 1200]) {
    await page.waitForTimeout(Math.max(0, at - (Date.now() - t0)));
    report.steps.flight.push({ at, cam: await camDist(page) });
    await page.screenshot({
      type: "jpeg",
      quality: 88,
      path: path.join(outDir, `detail-t${at}.jpg`),
    });
  }
  await page.waitForTimeout(2200);
  report.steps.detailCam = await camDist(page);
  report.steps.detailPanel = await page.evaluate(() => {
    const p = document.querySelector('[data-atomic-detail="true"]');
    return p
      ? {
          atom: p.getAttribute("data-atom-id"),
          sections: [...p.querySelectorAll("[data-detail]")].map((e) =>
            e.getAttribute("data-detail")
          ),
          jobs: [...p.querySelectorAll("[data-job]")].map((e) => e.textContent),
          text: p.textContent.slice(0, 900),
        }
      : null;
  });
  report.steps.focusedLabelDisplay = await page.evaluate((i) => {
    const el = document.querySelector(`.atomic-labels [data-atom-id="${i}"]`);
    return el ? getComputedStyle(el).display : "missing";
  }, id);
  report.steps.otherLabelOpacity = await page.evaluate((i) => {
    const el = [...document.querySelectorAll(".atomic-labels__row")].find(
      (e) => e.getAttribute("data-atom-id") !== i
    );
    return el ? getComputedStyle(el).opacity : null;
  }, id);
  report.steps.labelChip = await page.evaluate((i) => {
    const el = document.querySelector(`.atomic-labels [data-atom-id="${i}"] .atomic-labels__state`);
    return el ? el.textContent : null;
  }, id);
  report.steps.tooltipHiddenInDetail =
    (await page.locator('[data-atomic-tooltip="true"]').count()) === 0;
  report.steps.detailCamPos = await camDist(page);
  report.steps.perfDetailOpen = await framePerf(page);
  await page.waitForTimeout(6000);
  report.steps.detailCamAfterDrift = await camDist(page);
  await page.screenshot({ type: "jpeg", quality: 88, path: path.join(outDir, "detail.jpg") });

  // Exit with Escape: previous framing returns, panel is gone.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2500);
  report.steps.exitCam = await camDist(page);
  report.steps.panelAfterExit = await page.locator('[data-atomic-detail="true"]').count();
  await page.screenshot({ type: "jpeg", quality: 88, path: path.join(outDir, "exit.jpg") });

  // Reopen, then Reset view must also leave the detail view.
  await page.locator("[data-atomic-open-detail]").click();
  await page.waitForTimeout(2200);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("atomic:reset-view")));
  await page.waitForTimeout(800);
  // The bench lacks the dashboard CSS that makes the control hit-testable, so click
  // it programmatically (same React onClick -> window event -> instance listener path).
  await page.evaluate(() => document.querySelector('[data-atomic-control="reset"]').click());
  await page.waitForTimeout(2500);
  report.steps.panelAfterResetClick = await page.locator('[data-atomic-detail="true"]').count();
  report.steps.camAfterResetClick = await camDist(page);
  report.steps.tooltipAfterResetClick = await page.locator('[data-atomic-tooltip="true"]').count();
  await page.screenshot({ type: "jpeg", quality: 88, path: path.join(outDir, "reset.jpg") });
  report.steps.panelAfterResetEvent = await page.locator('[data-atomic-detail="true"]').count();
  const video = page.video();
  await ctx.close();
  if (video) fs.renameSync(await video.path(), path.join(outDir, "step11-flow.webm"));
}

// ---- Flow 2: reduced motion: detail snaps, no animation ---------------------
{
  const { ctx, page } = await session("reduced", { reduced: true });
  await page.goto(`${base}/dev/atomic-bench?atoms=20&paused=0`);
  await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
  await page.waitForTimeout(3000);
  const id = await gpuId(page);
  await page.locator(`[data-atom-id="${id}"]`).first().click({ force: true });
  await page.waitForTimeout(1500);
  await page.locator("[data-atomic-open-detail]").click();
  await page.waitForTimeout(400);
  report.steps.reducedDetailCam400ms = await camDist(page);
  await page.screenshot({
    type: "jpeg",
    quality: 88,
    path: path.join(outDir, "detail-reduced.jpg"),
  });
  await ctx.close();
}

// ---- Flow 3: the bench `?detail=1` deep link with a provider atom -----------
{
  const { ctx, page } = await session("provider");
  await page.goto(
    `${base}/dev/atomic-bench?atoms=20&paused=0&node=provider:bench-primary&detail=1`
  );
  await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
  await page.waitForTimeout(4500);
  report.steps.providerDetail = await page.evaluate(() => {
    const p = document.querySelector('[data-atomic-detail="true"]');
    return p ? p.textContent.slice(0, 700) : null;
  });
  await page.screenshot({
    type: "jpeg",
    quality: 88,
    path: path.join(outDir, "detail-provider.jpg"),
  });
  await ctx.close();
}

await browser.close();
fs.writeFileSync(path.join(outDir, "step11-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
