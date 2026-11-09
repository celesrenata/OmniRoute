#!/usr/bin/env node
/**
 * Profile-and-optimize harness (directives 19/21/41): headed Chrome on the real GPU, WebGPU, uncapped.
 * Per frame it records: rAF delta, CPU time inside pipeline.render() (JS submit cost), the whole
 * rAF-callback CPU time (React/R3F useFrame included) and the GPU time from timestamp queries
 * (`?gputime=1`). It then lists the frames over a threshold with all three numbers, so a tail frame
 * can be classified as GPU-bound, CPU-bound or presentation/compositor pacing.
 *
 *   node scripts/ad-hoc/pw-atomic-profile.mjs ladder [outJson]     # 8/16/20/32 atoms
 *   node scripts/ad-hoc/pw-atomic-profile.mjs probe "<query>" ...  # explicit bench queries
 * env: BENCH_BASE, WINDOW_MS (default 8000), VW/VH, DPR (default 2), EXTRA (appended to the query)
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const WINDOW = Number(process.env.WINDOW_MS ?? 8000);
const [mode = "ladder", ...rest] = process.argv.slice(2);

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1700,1100",
    // WINPOS=0,0 puts the window on the built-in 120 Hz ProMotion panel (main display).
    ...(process.env.WINPOS ? [`--window-position=${process.env.WINPOS}`] : []),
    // CAPPED=1: normal vsync (what a user sees). Default: uncapped (headroom only).
    ...(process.env.CAPPED === "1" ? [] : ["--disable-frame-rate-limit", "--disable-gpu-vsync"]),
    "--enable-webgpu-developer-features",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: Number(process.env.VW ?? 1600), height: Number(process.env.VH ?? 1000) },
  deviceScaleFactor: Number(process.env.DPR ?? 2),
});
const page = await ctx.newPage();
if (process.env.TRUNC === "1") {
  // EXPERIMENT ONLY: upload just the non-zero prefix of each writeBuffer (tests the upload-volume hypothesis).
  await page.addInitScript(() => {
    const o = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (buf, off, data, dOff, size) {
      if (data instanceof Float32Array && !dOff && size == null && data.length > 1024) {
        let n = data.length;
        while (n > 0 && data[n - 1] === 0) n -= 1;
        n = Math.min(data.length, (n + 3) & ~3);
        return o.call(this, buf, off, data, 0, n);
      }
      return o.call(this, buf, off, data, dOff, size);
    };
  });
}

async function open(query) {
  if (query.startsWith("home")) {
    // Real dashboard: /home, Atomic mode, real local fleet. "home:detail=<id>" opens a detail view.
    const [, opt] = query.split(":");
    await page.goto(`${BASE}/home?gputime=1${process.env.EXTRA ? "&" + process.env.EXTRA : ""}`);
    const group = page.locator('[role="group"][aria-label="Topology view mode"]');
    await group.waitFor({ timeout: 120000 });
    await group.getByRole("button", { name: "Atomic" }).click();
    await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
    await page.waitForTimeout(8000);
    if (query.includes(":fs")) {
      // Fullscreen (Fullscreen API on the topology container), then the detail view.
      await page.bringToFront();
      await page.mouse.click(1000, 40);
      await page.locator('[data-atomic-control="fullscreen"]').click();
      await page.waitForTimeout(2500);
      await page.evaluate(() => window.__atomicOpenDetail?.("provider:openai"));
      await page.waitForTimeout(5000);
      return;
    }
    if (opt?.startsWith("detail=")) {
      await page.evaluate((id) => window.__atomicOpenDetail?.(id), opt.slice(7));
      await page.waitForTimeout(5000);
    }
    return;
  }
  const extra = process.env.EXTRA ? `&${process.env.EXTRA}` : "";
  await page.goto(`${BASE}/dev/atomic-bench?${query}&gputime=1${extra}`);
  await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
  await page.waitForTimeout(3500);
}

const sample = (ms) =>
  page.evaluate(
    (dur) =>
      new Promise((resolve) => {
        const dbg = window.__atomicGpuDbg;
        const gl = dbg?.gl;
        const pipe = dbg?.post?.pipeline;
        const rows = [];
        let renderCpu = 0;
        const origRender = pipe?.render?.bind(pipe);
        if (pipe && origRender && !pipe.__prof) {
          pipe.__prof = true;
          pipe.render = () => {
            const t0 = performance.now();
            const r = origRender();
            renderCpu += performance.now() - t0;
            return r;
          };
        }
        // Presentation back-pressure probe: time spent inside getCurrentTexture() per frame.
        let acquireMs = 0;
        const proto = window.GPUCanvasContext?.prototype;
        if (proto && !proto.__prof) {
          proto.__prof = true;
          const g = proto.getCurrentTexture;
          proto.getCurrentTexture = function () {
            const t0 = performance.now();
            const r = g.call(this);
            acquireMs += performance.now() - t0;
            return r;
          };
        }
        let last = performance.now();
        const start = last;
        let pending = null;
        let resolvedFrom = 0;
        let cbStart = 0;
        const gpuBy = [];
        const tick = (now) => {
          // Everything between the previous callback end and this one belongs to the previous frame.
          const cbCpu = performance.now() - now; // delay between frame start and callback entry
          const row = {
            dt: now - last,
            renderCpu,
            acquire: acquireMs,
            lateStart: Math.max(0, cbCpu),
            gpu: null,
          };
          renderCpu = 0;
          acquireMs = 0;
          rows.push(row);
          last = now;
          if (gl?.resolveTimestampsAsync && !pending) {
            const idx = rows.length - 1;
            const span = idx - resolvedFrom + 1;
            resolvedFrom = idx + 1;
            pending = gl
              .resolveTimestampsAsync("render")
              .then((v) => {
                const t = typeof v === "number" ? v : gl.info?.render?.timestamp;
                if (Number.isFinite(t)) {
                  rows[idx].gpu = t;
                  rows[idx].gpuSpan = span;
                  // Only single-frame resolves give a per-frame GPU time distribution.
                  if (span === 1) rows[idx].gpuPerFrame = t;
                }
              })
              .catch(() => {})
              .finally(() => (pending = null));
          }
          if (now - start < dur) requestAnimationFrame(tick);
          else
            setTimeout(() => {
              rows.shift();
              resolve(rows);
            }, 300);
        };
        requestAnimationFrame(tick);
      }),
    ms
  );

const q = (arr, p) => {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  return a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2) : null;
};

const SLOW = Number(process.env.SLOW_MS ?? 12);
function summarize(rows) {
  const dt = rows.map((r) => r.dt);
  const gpu = rows.map((r) => r.gpu);
  const cpu = rows.map((r) => r.renderCpu);
  const acq = rows.map((r) => r.acquire);
  const gpf = rows.map((r) => r.gpuPerFrame);
  const gpuTotal = rows.reduce((a, r) => a + (r.gpu ?? 0), 0);
  const gpuFrames = rows.reduce((a, r) => a + (r.gpu != null ? r.gpuSpan : 0), 0);
  const slowAcq = rows.filter((r) => r.dt > SLOW).map((r) => r.acquire);
  const fastAcq = rows.filter((r) => r.dt <= SLOW).map((r) => r.acquire);
  const slow = rows.filter((r) => r.dt > SLOW);
  const top = rows
    .map((r, i) => ({ i, ...r }))
    .sort((a, b) => b.dt - a.dt)
    .slice(0, 8)
    .map((r) => ({
      i: r.i,
      dt: +r.dt.toFixed(1),
      renderCpu: +r.renderCpu.toFixed(2),
      acquire: +r.acquire.toFixed(2),
    }));
  const slowGpu = slow.map((r) => r.gpu).filter((x) => x != null);
  return {
    frames: rows.length,
    fps: +(rows.length / (dt.reduce((a, b) => a + b, 0) / 1000)).toFixed(1),
    dt: { p50: q(dt, 0.5), p95: q(dt, 0.95), p99: q(dt, 0.99), max: q(dt, 1) },
    renderCpuMs: { p50: q(cpu, 0.5), p95: q(cpu, 0.95), p99: q(cpu, 0.99), max: q(cpu, 1) },
    // mean = all resolved GPU time / frames covered; p50/p95/max over single-frame resolves.
    gpuMsPerFrame: {
      mean: gpuFrames ? +(gpuTotal / gpuFrames).toFixed(2) : null,
      p50: q(gpf, 0.5),
      p95: q(gpf, 0.95),
      max: q(gpf, 1),
      singles: gpf.filter((x) => x != null).length,
    },
    acquireMs: {
      p50: q(acq, 0.5),
      p99: q(acq, 0.99),
      slowFramesMedian: q(slowAcq, 0.5),
      fastFramesMedian: q(fastAcq, 0.5),
    },
    gpuSamples: gpu.filter((x) => x != null).length,
    slowFrames: slow.length,
    slowFramesMedianDt: q(
      slow.map((r) => r.dt),
      0.5
    ),
    // Beat period of the slow frames (index gaps), a pacing signature.
    slowGapsFrames: (() => {
      const idx = rows.map((r, i) => (r.dt > SLOW ? i : -1)).filter((i) => i >= 0);
      const gaps = idx.slice(1).map((v, k) => v - idx[k]);
      return { n: gaps.length, p50: q(gaps, 0.5), max: q(gaps, 1) };
    })(),
    top,
  };
}

const out = [];
const queries = mode === "ladder" ? [8, 16, 20, 32].map((n) => `atoms=${n}&paused=0`) : rest;
for (const query of queries) {
  await open(query);
  const r0 = await page.evaluate(() => window.__atomicRtFrames ?? 0);
  const rows = await sample(WINDOW);
  const r1 = await page.evaluate(() => window.__atomicRtFrames ?? 0);
  const s = summarize(rows);
  s.renderedFps = +(((r1 - r0) / (WINDOW + 300)) * 1000).toFixed(1);
  s.skipped = await page.evaluate(() => window.__atomicRtSkipped ?? 0);
  const info = await page.evaluate(() => ({
    atoms: document.querySelectorAll("[data-atom-id]").length,
    calls: window.__atomicGpuDbg?.gl?.info?.render?.calls ?? null,
    fullscreen: Boolean(document.fullscreenElement),
    canvasPx: (() => {
      const c = window.__atomicGpuDbg?.gl?.domElement;
      return c ? [c.width, c.height] : null;
    })(),
    tris: window.__atomicGpuDbg?.gl?.info?.render?.triangles ?? null,
  }));
  const rec = { query, ...info, ...s };
  out.push(rec);
  console.log(JSON.stringify(rec));
}
if (process.env.OUT_JSON) fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
await browser.close();
