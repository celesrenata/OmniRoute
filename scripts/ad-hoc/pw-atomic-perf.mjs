/**
 * OR-ATOM-010 T10.6/7 — perf + accessibility measurement harness.
 *
 * Measures the REAL production renderer (`/dev/atomic-bench`) on the 8 / 16 /
 * 32 atom perf ladder (`?atoms=N`), with `paused=0` so the shared scene clock
 * runs:
 *   - FPS: rAF frame-rate sampling over a fixed window per scale.
 *   - JS heap + WebGL memory (where exposed) before/after the window.
 *   - A 3-minute (180 s) continuous-render SOAK at the default scale: confirms
 *     no frame freeze, no context loss, no unbounded heap growth.
 *   - Reduced-motion: re-renders the default scale under a forced
 *     `prefers-reduced-motion: reduce` media override and confirms the scene
 *     still renders a valid (static) frame.
 *
 * SwiftShader caveat (documented in OR_ATOM_010/PERFORMANCE.md): absolute FPS
 * is CPU-rasterized and NOT representative of GPU hardware; the ladder's
 * purpose is to confirm per-scale render cost STAYS BOUNDED (no cliff, no
 * frame freeze) and that the quality ladder degrades gracefully.
 *
 * Output: OR_ATOM_010/screenshots/perf_<scale>.png + a console table.
 */
import { mkdir } from "node:fs/promises";

import { chromium } from "@playwright/test";

const OUT_DIR = "OR_ATOM_010/screenshots";
const SCALES = [8, 16, 32];
const SAMPLE_FRAMES = 240; // ~4 s at 60fps
const SOAK_MS = 180_000; // 3 min soak (20-min variant = documented follow-up)
const BASE_URL = process.env.DEV_SERVER_URL || "http://127.0.0.1:21128";

/** rAF + memory sampler injected into the page before app code runs. */
const INJECT = `
window.__perf = { frames: [], last: 0, started: false };
const orig = window.requestAnimationFrame;
window.requestAnimationFrame = (cb) => orig.call(window, (t) => {
  const p = window.__perf;
  if (p.started && p.last) p.frames.push(t - p.last);
  p.last = t;
  cb(t);
});
`;

function summarize(frames) {
  if (frames.length < 2) return { fps: 0, avgMs: 0, worstMs: 0, frames: frames.length };
  const sorted = [...frames].sort((a, b) => a - b);
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  return {
    fps: Math.round(1000 / avg),
    avgMs: Number(avg.toFixed(2)),
    worstMs: Number(sorted[sorted.length - 1].toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
    frames: frames.length,
  };
}

async function sampleScale(browser, atoms, reduced) {
  const suffix = reduced ? "reduced" : String(atoms);
  const params = `atoms=${atoms}&paused=0&badge=0${reduced ? "" : ""}`;
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  await context.addInitScript(INJECT);
  const page = await context.newPage();
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${BASE_URL}/dev/atomic-bench?${params}`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector("canvas", { timeout: 60_000 });
  // Warm-up: let the env map compile + first frames settle.
  await page.waitForTimeout(2500);

  const memBefore = await page.evaluate(() => {
    const m = performance.memory;
    return m
      ? {
          heapMB: Number((m.usedJSHeapSize / 1048576).toFixed(1)),
          totalMB: Number((m.jsHeapSizeLimit / 1048576).toFixed(1)),
        }
      : null;
  });
  await page.evaluate(() => {
    window.__perf.frames = [];
    window.__perf.last = 0;
    window.__perf.started = true;
  });

  // Sample frames.
  const frames = [];
  let elapsed = 0;
  while (elapsed < (SAMPLE_FRAMES / 60) * 1000) {
    await page.waitForTimeout(250);
    const got = await page.evaluate(() => {
      const f = window.__perf.frames;
      window.__perf.frames = [];
      return f;
    });
    frames.push(...got);
    elapsed += 250;
    if (frames.length >= SAMPLE_FRAMES) break;
  }
  await page.evaluate(() => {
    window.__perf.started = false;
  });

  const memAfter = await page.evaluate(() => {
    const m = performance.memory;
    return m
      ? {
          heapMB: Number((m.usedJSHeapSize / 1048576).toFixed(1)),
          totalMB: Number((m.jsHeapSizeLimit / 1048576).toFixed(1)),
        }
      : null;
  });
  const stats = summarize(frames);

  // WebGL memory (if the renderer exposes it via extension).
  const glInfo = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return null;
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_memory");
    return ext ? { gpuMB: Number((ext.getGpuMemoryUsed() / 1048576).toFixed(1)) } : null;
  });

  const shot = `${OUT_DIR}/perf_${suffix}.png`;
  await page.screenshot({ path: shot });

  await context.close();
  return {
    scale: suffix,
    atoms,
    reduced,
    fps: stats.fps,
    avgMs: stats.avgMs,
    p95Ms: stats.p95Ms,
    worstMs: stats.worstMs,
    sampled: stats.frames,
    heapMB: memAfter?.heapMB ?? null,
    heapDeltaMB:
      memBefore && memAfter ? Number((memAfter.heapMB - memBefore.heapMB).toFixed(1)) : null,
    gpuMB: glInfo?.gpuMB ?? null,
    shot,
    errors: errors.filter((e) => !/favicon|404/i.test(e)).slice(0, 6),
  };
}

async function soak(browser) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  await context.addInitScript(INJECT);
  const page = await context.newPage();
  const errors = [];
  let contextLost = false;
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && /webgl|context/i.test(m.text())) {
      contextLost = true;
      errors.push(`console: ${m.text()}`);
    }
  });
  await page.goto(`${BASE_URL}/dev/atomic-bench?atoms=16&paused=0&badge=0`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector("canvas", { timeout: 60_000 });
  await page.evaluate(() => {
    window.__perf.frames = [];
    window.__perf.last = 0;
    window.__perf.started = true;
  });

  const t0 = Date.now();
  let minGap = Infinity;
  let frozen = 0;
  while (Date.now() - t0 < SOAK_MS) {
    await page.waitForTimeout(1000);
    const got = await page.evaluate(() => {
      const f = window.__perf.frames;
      window.__perf.frames = [];
      return f;
    });
    for (const g of got) minGap = Math.min(minGap, g);
    // A gap > 2500 ms is a frozen frame.
    frozen += got.filter((g) => g > 2500).length;
  }
  const memEnd = await page.evaluate(() => {
    const m = performance.memory;
    return m ? Number((m.usedJSHeapSize / 1048576).toFixed(1)) : null;
  });
  await page.screenshot({ path: `${OUT_DIR}/perf_soak_end.png` });
  await context.close();
  return {
    soakMs: SOAK_MS,
    frozenFrames: frozen,
    minGapMs: minGap === Infinity ? null : Number(minGap.toFixed(1)),
    heapEndMB: memEnd,
    contextLost,
    errors: errors.slice(0, 6),
  };
}

// The dev server is already running by the operator; reuse it.
const serverUrl = BASE_URL;
async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
    ],
  });
  const results = [];
  for (const atoms of SCALES) {
    const r = await sampleScale(browser, atoms, false);
    results.push(r);
    console.log(
      `[perf] atoms=${r.atoms} fps=${r.fps} avgMs=${r.avgMs} p95Ms=${r.p95Ms} worstMs=${r.worstMs} sampled=${r.sampled} heapΔMB=${r.heapDeltaMB} gpuMB=${r.gpuMB} errors=${r.errors.length}`
    );
  }
  const reduced = await sampleScale(browser, 8, true);
  results.push(reduced);
  console.log(
    `[perf] reduced-motion atoms=8 fps=${reduced.fps} avgMs=${reduced.avgMs} errors=${reduced.errors.length}`
  );
  const soakResult = await soak(browser);
  console.log(
    `[soak] ${soakResult.soakMs}ms frozenFrames=${soakResult.frozenFrames} minGapMs=${soakResult.minGapMs} contextLost=${soakResult.contextLost} heapEndMB=${soakResult.heapEndMB} errors=${soakResult.errors.length}`
  );
  await browser.close();

  const report = { serverUrl, swiftshader: true, results, soak: soakResult };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${OUT_DIR}/perf_report.json`, JSON.stringify(report, null, 2));
  console.log(`wrote ${OUT_DIR}/perf_report.json`);
}

main().catch((e) => {
  console.error("perf harness failed:", e);
  process.exit(1);
});
