#!/usr/bin/env node
/**
 * Gate B harness (headed Chrome, real GPU; never headless / SwiftShader).
 *
 *   node scripts/ad-hoc/pw-atomic-gateB.mjs ladder            # 8/16/20/32 atoms x webgpu/webgl, uncapped
 *   node scripts/ad-hoc/pw-atomic-gateB.mjs loss              # forced device/context loss x3 + recovery
 *   node scripts/ad-hoc/pw-atomic-gateB.mjs toggle [N=50]     # dashboard 2D <-> Atomic toggles (real host)
 *   node scripts/ad-hoc/pw-atomic-gateB.mjs soak [ms=1200000] # dashboard Atomic soak, live 3.5 s telemetry
 *   node scripts/ad-hoc/pw-atomic-gateB.mjs reduced           # prefers-reduced-motion: static frames
 *   node scripts/ad-hoc/pw-atomic-gateB.mjs probe "<query>"...  # uncapped frame stats for bench queries
 *
 * Bench = /dev/atomic-bench?atoms=N (the REAL AtomicTopologyRenderer on the
 * golden DEMO snapshot, labelled DEMO). Dashboard = /home (real host, real
 * data from this dev server). Results print as JSON lines; screenshots go to
 * OUT (default OR_ATOM_010_RAYTRACED/screenshots/gateB/live).
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const OUT = process.env.OUT ?? "OR_ATOM_010_RAYTRACED/screenshots/gateB/live";
fs.mkdirSync(OUT, { recursive: true });
const [mode = "ladder", arg] = process.argv.slice(2);
const UNCAPPED =
  process.env.CAPPED !== "1" &&
  (mode === "ladder" || mode === "probe" || process.env.UNCAPPED === "1");

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1700,1100",
    "--js-flags=--expose-gc",
    ...(UNCAPPED ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"] : []),
  ],
});

async function newPage(viewport = { width: 1600, height: 1000 }, opts = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  return { page, errors, ctx };
}

async function frameStats(page, ms = 5000) {
  return page.evaluate(
    (dur) =>
      new Promise((resolve) => {
        const d = [];
        let last = performance.now();
        const end = last + dur;
        const tick = (t) => {
          d.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(tick);
          else {
            d.sort((a, b) => a - b);
            const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
            resolve({
              frames: d.length,
              avgFps: +(d.length / (dur / 1000)).toFixed(1),
              p50: +q(0.5).toFixed(2),
              p95: +q(0.95).toFixed(2),
              p99: +q(0.99).toFixed(2),
              heapMB: performance.memory
                ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1)
                : null,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    ms
  );
}

async function adapterInfo(page) {
  return page.evaluate(async () => {
    try {
      const a = await navigator.gpu?.requestAdapter();
      const i = a?.info;
      return i ? `${i.vendor}/${i.architecture}` : "no adapter";
    } catch (e) {
      return String(e);
    }
  });
}

const atomCount = (page) => page.evaluate(() => document.querySelectorAll("[data-atom-id]").length);

async function openBench(page, query) {
  await page.goto(`${BASE}/dev/atomic-bench?${query}`);
  await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
  await page.waitForTimeout(3000);
}

if (mode === "ladder") {
  const { page, errors } = await newPage();
  for (const backend of ["webgpu", "webgl"]) {
    for (const n of [8, 16, 20, 32]) {
      errors.length = 0;
      await openBench(page, `atoms=${n}&paused=0&backend=${backend}`);
      const s = await frameStats(page);
      const atoms = await atomCount(page);
      await page.screenshot({ path: path.join(OUT, `ladder-${backend}-${n}.png`) });
      console.log(
        JSON.stringify({ mode, backend, atomsParam: n, atomsRendered: atoms, ...s, errors })
      );
    }
  }
  console.log(JSON.stringify({ adapter: await adapterInfo(page) }));
}

if (mode === "probe") {
  const { page, errors } = await newPage();
  for (const q of process.argv.slice(3)) {
    errors.length = 0;
    // A bare query is the full-topology bench; a "bench:" prefix is the Gate A single-atom grid.
    await openBench(page, q.startsWith("bench:") ? `atomic-fx=rt&${q.slice(6)}` : q);
    const s = await frameStats(page);
    console.log(JSON.stringify({ q, atoms: await atomCount(page), ...s, errors }));
  }
}

if (mode === "loss") {
  const { page, errors } = await newPage();
  for (const backend of ["webgpu", "webgl"]) {
    errors.length = 0;
    await openBench(page, `atoms=16&paused=0&backend=${backend}`);
    const before = await frameStats(page, 2000);
    const results = [];
    for (let k = 0; k < 3; k += 1) {
      const canvasBefore = await page.evaluate(() => document.querySelector("canvas"));
      const how = await page.evaluate(() => window.__atomicForceContextLoss?.() ?? "no hook");
      await page.waitForTimeout(4000);
      const after = await page.evaluate((old) => {
        const c = document.querySelector("canvas");
        return {
          canvases: document.querySelectorAll("canvas").length,
          replaced: c !== old,
          size: c ? [c.width, c.height] : null,
        };
      }, canvasBefore);
      const s = await frameStats(page, 2000);
      await page.screenshot({ path: path.join(OUT, `loss-${backend}-${k + 1}.png`) });
      results.push({ forced: how, ...after, p50: s.p50, frames: s.frames });
      // Each successful rebuild resets the failure counter (RestoreWatch).
    }
    console.log(JSON.stringify({ mode, backend, before: before.p50, results, errors }));
  }
}

if (mode === "toggle") {
  const n = Number(arg ?? 50);
  const { page, errors } = await newPage({ width: 1440, height: 900 });
  await page.goto(`${BASE}/home${process.env.HOME_QUERY ?? ""}`);
  await page.waitForSelector('[role="group"][aria-label="Topology view mode"]', {
    timeout: 120000,
  });
  const group = page.locator('[role="group"][aria-label="Topology view mode"]');
  let peak = 0;
  const lat = [];
  const heapAt = async () =>
    page.evaluate(async () => {
      window.gc?.();
      await new Promise((r) => setTimeout(r, 300));
      return performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
    });
  const heapCurve = [];
  let okA = 0;
  let ok2 = 0;
  for (let i = 0; i < n; i += 1) {
    const t0 = Date.now();
    await group.getByRole("button", { name: "Atomic" }).click();
    await page
      .waitForFunction(
        () => document.querySelectorAll(".atomic-scene-canvas canvas").length === 1,
        null,
        { timeout: 30000 }
      )
      .then(() => (okA += 1))
      .catch(() => {});
    lat.push(Date.now() - t0);
    await page.waitForTimeout(1200);
    peak = Math.max(peak, await page.evaluate(() => document.querySelectorAll("canvas").length));
    if (i === n - 1) await page.screenshot({ path: path.join(OUT, "toggle-atomic.png") });
    if (i % 10 === 0) heapCurve.push([i, await heapAt()]);
    await group.getByRole("button", { name: "2D" }).click();
    await page
      .waitForFunction(
        () => document.querySelectorAll(".atomic-scene-canvas canvas").length === 0,
        null,
        { timeout: 30000 }
      )
      .then(() => (ok2 += 1))
      .catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: path.join(OUT, "toggle-2d.png") });
  // Forced GC before reading the heap so the number is retained memory, not garbage.
  const heap = await page.evaluate(async () => {
    window.gc?.();
    await new Promise((r) => setTimeout(r, 500));
    window.gc?.();
    return performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
  });
  const end = await page.evaluate(() => document.querySelectorAll("canvas").length);
  lat.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      mode,
      toggles: n,
      atomicMounted: okA,
      twoDMounted: ok2,
      peakCanvases: peak,
      endCanvases: end,
      switchMsP50: lat[Math.floor(lat.length / 2)],
      switchMsMax: lat[lat.length - 1],
      heapMB: heap,
      heapCurveMB: heapCurve,
      errors: [...new Set(errors)].slice(0, 10),
    })
  );
}

if (mode === "soak") {
  const ms = Number(arg ?? 1_200_000);
  const { page, errors } = await newPage({ width: 1440, height: 900 });
  await page.goto(`${BASE}/home`);
  const group = page.locator('[role="group"][aria-label="Topology view mode"]');
  await group.waitFor({ timeout: 120000 });
  await group.getByRole("button", { name: "Atomic" }).click();
  await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
  const samples = [];
  const t0 = Date.now();
  let lost = 0;
  await page.evaluate(() => {
    window.__lost = 0;
    document.addEventListener("webglcontextlost", () => (window.__lost += 1), true);
  });
  while (Date.now() - t0 < ms) {
    const s = await frameStats(page, 3000);
    const st = await page.evaluate(() => ({
      canvases: document.querySelectorAll(".atomic-scene-canvas canvas").length,
      telemetry:
        document.querySelector("[data-telemetry-state]")?.getAttribute("data-telemetry-state") ??
        null,
      lost: window.__lost,
    }));
    lost = st.lost;
    samples.push({ tSec: Math.round((Date.now() - t0) / 1000), ...s, ...st });
    console.log(JSON.stringify({ mode, ...samples[samples.length - 1] }));
    await page.waitForTimeout(27000);
  }
  await page.screenshot({ path: path.join(OUT, "soak-end.png") });
  const heaps = samples.map((s) => s.heapMB).filter((v) => v != null);
  console.log(
    JSON.stringify({
      mode: "soak-summary",
      minutes: +(ms / 60000).toFixed(1),
      samples: samples.length,
      p50Range: [Math.min(...samples.map((s) => s.p50)), Math.max(...samples.map((s) => s.p50))],
      heapStartMB: heaps[0],
      heapEndMB: heaps[heaps.length - 1],
      heapMaxMB: Math.max(...heaps),
      contextLost: lost,
      errors: [...new Set(errors)].slice(0, 10),
    })
  );
}

if (mode === "reduced") {
  const { page, errors } = await newPage(undefined, { reducedMotion: "reduce" });
  await openBench(page, "atoms=16&paused=0");
  const a = await page.screenshot({ path: path.join(OUT, "reduced-a.png") });
  await page.waitForTimeout(2500);
  const b = await page.screenshot({ path: path.join(OUT, "reduced-b.png") });
  const identical = Buffer.compare(a, b) === 0;
  // Orbit: a camera change must still render a new static frame.
  await page.mouse.move(800, 500);
  await page.mouse.down();
  await page.mouse.move(900, 520, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const c = await page.screenshot({ path: path.join(OUT, "reduced-c-orbited.png") });
  console.log(
    JSON.stringify({
      mode,
      staticWhileIdle: identical,
      orbitRendersNewFrame: Buffer.compare(b, c) !== 0,
      errors,
    })
  );
}

await browser.close();
