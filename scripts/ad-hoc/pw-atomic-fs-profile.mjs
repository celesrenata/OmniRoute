#!/usr/bin/env node
/**
 * Directive 39.3: uncapped fullscreen pacing breakdown on real /home (headed Chrome, real GPU).
 * Detail open on provider:openai; card vs fullscreen; GPU timestamps (?gputime=1) when the
 * renderer exposes them; layer/pass A/B through the dev handle window.__atomicGpuDbg (dev-only).
 *   node scripts/ad-hoc/pw-atomic-fs-profile.mjs <outDir> [label]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const outDir = process.argv[2] ?? "/tmp/fsprof";
const label = process.argv[3] ?? "run";
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
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
    "--enable-webgpu-developer-features",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto(`${base}/home?gputime=1${process.env.QS ? "&" + process.env.QS : ""}`);
const group = page.locator('[role="group"][aria-label="Topology view mode"]');
await group.waitFor({ timeout: 120000 });
await group.getByRole("button", { name: "Atomic" }).click();
await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
await page.waitForTimeout(8000);
// Count renderer resizes (render-target reallocation path).
await page.evaluate(() => {
  const g = window.__atomicGpuDbg?.gl;
  if (!g || g.__wrapped) return;
  g.__wrapped = true;
  window.__resizes = 0;
  const s = g.setSize.bind(g);
  g.setSize = (...a) => {
    window.__resizes += 1;
    return s(...a);
  };
});
const measure = (ms = 3000) =>
  page.evaluate(
    (dur) =>
      new Promise((res) => {
        const g = window.__atomicGpuDbg?.gl;
        const d = [];
        const gpu = [];
        let last = performance.now();
        const t0 = last;
        const r0 = window.__resizes ?? 0;
        let pending = false;
        const tick = async (now) => {
          d.push(now - last);
          last = now;
          if (g?.resolveTimestampsAsync && !pending) {
            pending = true;
            g.resolveTimestampsAsync("render")
              .then((v) => {
                const t = typeof v === "number" ? v : g.info?.render?.timestamp;
                if (Number.isFinite(t) && t > 0) gpu.push(t);
              })
              .catch(() => {})
              .finally(() => (pending = false));
          }
          if (now - t0 < dur) requestAnimationFrame(tick);
          else {
            d.shift();
            const a = [...d].sort((x, y) => x - y);
            const q = (arr, p) =>
              arr.length
                ? Math.round(arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] * 100) / 100
                : null;
            const gs = [...gpu].sort((x, y) => x - y);
            const c = g?.domElement;
            res({
              fps: Math.round((d.length / (d.reduce((x, y) => x + y, 0) / 1000)) * 10) / 10,
              p50: q(a, 0.5),
              p95: q(a, 0.95),
              // Resolved timestamps cover every frame since the previous resolve.
              gpuMsPerFrame: gs.length
                ? Math.round((gs.reduce((x, y) => x + y, 0) / d.length) * 100) / 100
                : null,
              gpuSamples: gs.length,
              canvasPx: c ? [c.width, c.height] : null,
              cssPx: c ? [c.clientWidth, c.clientHeight] : null,
              dpr: g?.getPixelRatio?.(),
              resizes: (window.__resizes ?? 0) - r0,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    ms
  );
const report = { label };
// Upload accounting: bytes / calls of queue.writeBuffer per frame, by size class.
await page.evaluate(() => {
  if (window.__wb) return;
  const wb = (window.__wb = { calls: 0, bytes: 0, sizes: new Map() });
  const orig = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function (buf, off, data, dOff, size) {
    const n = size ?? (data.byteLength ?? 0) - (dOff ?? 0) * (data.BYTES_PER_ELEMENT ?? 1);
    wb.calls += 1;
    wb.bytes += n;
    const k = buf.size;
    const e = wb.sizes.get(k) ?? { calls: 0, bytes: 0, label: buf.label };
    e.calls += 1;
    e.bytes += n;
    wb.sizes.set(k, e);
    return orig.call(this, buf, off, data, dOff, size);
  };
});
const uploads = (ms = 2000) =>
  page.evaluate(
    (dur) =>
      new Promise((res) => {
        const wb = window.__wb;
        wb.calls = 0;
        wb.bytes = 0;
        wb.sizes = new Map();
        let frames = 0;
        const t0 = performance.now();
        const tick = (now) => {
          frames += 1;
          if (now - t0 < dur) requestAnimationFrame(tick);
          else
            res({
              frames,
              callsPerFrame: Math.round(wb.calls / frames),
              kbPerFrame: Math.round(wb.bytes / frames / 1024),
              top: [...wb.sizes.entries()]
                .sort((a, b) => b[1].bytes - a[1].bytes)
                .slice(0, 8)
                .map(([size, e]) => ({
                  bufSize: size,
                  label: e.label,
                  kbPerFrame: Math.round(e.bytes / frames / 1024),
                  callsPerFrame: Math.round(e.calls / frames),
                })),
            });
        };
        requestAnimationFrame(tick);
      }),
    ms
  );
await page.evaluate(() => window.__atomicOpenDetail?.("provider:openai"));
await page.waitForTimeout(5000);
report.card = await measure();
report.cardUploads = await uploads();
await page.keyboard.press("Escape");
await page.waitForTimeout(2000);
await page.bringToFront();
await page.mouse.click(1000, 40);
await page.locator('[data-atomic-control="fullscreen"]').click();
await page.waitForTimeout(2500);
report.fullscreenActive = await page.evaluate(() => Boolean(document.fullscreenElement));
await page.evaluate(() => window.__atomicOpenDetail?.("provider:openai"));
await page.waitForTimeout(5000);
report.fullscreen = await measure();
report.fullscreenUploads = await uploads();
if (process.env.CPUPROF) {
  // JS sampling profile + long-frame log over 4 s of fullscreen detail.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  report.frames = await page.evaluate(
    () =>
      new Promise((res) => {
        const out = [];
        let last = performance.now();
        const t0 = last;
        const tick = (now) => {
          out.push(Math.round((now - last) * 10) / 10);
          last = now;
          if (now - t0 < 4000) requestAnimationFrame(tick);
          else res(out);
        };
        requestAnimationFrame(tick);
      })
  );
  const { profile } = await cdp.send("Profiler.stop");
  fs.writeFileSync(path.join(outDir, "fs-detail.cpuprofile"), JSON.stringify(profile));
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dts = profile.timeDeltas;
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const cf = n.callFrame;
    const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").slice(-1)[0]}:${cf.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + (dts[i] ?? 0) / 1000);
  });
  report.topSelfMs = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([k, v]) => [k, Math.round(v)]);
}
if (process.env.DPRS) {
  report.dprs = {};
  for (const d of process.env.DPRS.split(",").map(Number)) {
    await page.evaluate((x) => window.__atomicGpuDbg.gl.setPixelRatio(x), d);
    await page.waitForTimeout(800);
    const m = await measure(2500);
    report.dprs[d] = [m.fps, m.p95, m.canvasPx];
    await page.screenshot({ path: path.join(outDir, `fs-detail-dpr${d}.png`) });
  }
}
if (process.env.SERIES) {
  // Stability over time: fullscreen detail, then fullscreen without detail.
  report.seriesDetail = [];
  for (let i = 0; i < Number(process.env.SERIES_N ?? 6); i += 1) {
    const m = await measure(2500);
    const c = await page.evaluate(
      () => window.__atomicCamDbg && window.__atomicCamDbg.pos.map((v) => Math.round(v))
    );
    const wbc = await page.evaluate(() => window.__atomicGpuDbg.gl.info?.render?.calls ?? null);
    report.seriesDetail.push([m.fps, m.gpuMsPerFrame, c, wbc]);
  }
  await page.keyboard.press("Escape"); // leaves fullscreen first (browser Esc)
  await page.waitForTimeout(1500);
  report.afterEsc = await measure(2500);
  await page.bringToFront();
  await page.mouse.click(1000, 40);
  await page.locator('[data-atomic-control="fullscreen"]').click();
  await page.waitForTimeout(2500);
  report.seriesNoDetail = [];
  for (let i = 0; i < 4; i += 1) report.seriesNoDetail.push((await measure(2500)).fps);
  report.noDetailSample = await measure(2500);
}
if (!process.env.NO_AB && !process.env.SERIES && !process.env.CPUPROF && !process.env.DPRS) {
  // Interleaved A/B (base, variant) x PAIRS: cancels the slow drift of a long run.
  const PAIRS = Number(process.env.PAIRS ?? 3);
  const med = (a) => {
    const b = a.filter((x) => x != null).sort((x, y) => x - y);
    return b.length ? b[Math.floor(b.length / 2)] : null;
  };
  const ab = async (name, on, off, arg) => {
    const base = [];
    const vari = [];
    for (let i = 0; i < PAIRS; i += 1) {
      base.push(await measure(1500));
      await page.evaluate(on, arg);
      await page.waitForTimeout(400);
      vari.push(await measure(1500));
      await page.evaluate(off, arg);
      await page.waitForTimeout(400);
    }
    report[name] = {
      baseFps: med(base.map((m) => m.fps)),
      fps: med(vari.map((m) => m.fps)),
      baseGpuMs: med(base.map((m) => m.gpuMsPerFrame)),
      gpuMs: med(vari.map((m) => m.gpuMsPerFrame)),
    };
    console.log(name.padEnd(22), JSON.stringify(report[name]));
  };
  await ab(
    "fs_dpr1",
    () => window.__atomicGpuDbg.gl.setPixelRatio(1),
    () => window.__atomicGpuDbg.gl.setPixelRatio(2)
  );
  await ab(
    "fs_noBloom",
    () => window.__atomicGpuDbg.post.setBloom(false),
    () => window.__atomicGpuDbg.post.setBloom(true)
  );
  await ab(
    "fs_noDof",
    () => {
      const p = window.__atomicGpuDbg.post;
      p.__sf = p.setFocus;
      p.setFocus = () => {};
      p.__sf(1e7);
    },
    () => {
      const p = window.__atomicGpuDbg.post;
      p.setFocus = p.__sf;
    }
  );
  await ab(
    "fs_noAtoms",
    () => (window.__atomicGpuDbg.atoms.group.visible = false),
    () => (window.__atomicGpuDbg.atoms.group.visible = true)
  );
  await ab(
    "fs_noEnv",
    () =>
      window.__atomicGpuDbg.env.objects.forEach((o) => ((o.__v = o.visible), (o.visible = false))),
    () => window.__atomicGpuDbg.env.objects.forEach((o) => (o.visible = o.__v))
  );
  await ab(
    "fs_noMotes",
    () => {
      const m = window.__atomicGpuDbg.motes;
      m.far.visible = m.near.visible = false;
    },
    () => {
      const m = window.__atomicGpuDbg.motes;
      m.far.visible = m.near.visible = true;
    }
  );
  // Per-mesh-name A/B inside the atom batch (material.visible, like ?hideLayers).
  const names = await page.evaluate(() => {
    const n = new Set();
    window.__atomicGpuDbg.atoms.group.traverse((o) => o.isMesh && o.name && n.add(o.name));
    return [...n];
  });
  report.atomMeshNames = names;
  for (const nm of names) {
    await ab(
      "fs_no:" + nm,
      (x) =>
        window.__atomicGpuDbg.atoms.group.traverse((o) => {
          if (o.name === x && o.material) o.material.visible = false;
        }),
      (x) =>
        window.__atomicGpuDbg.atoms.group.traverse((o) => {
          if (o.name === x && o.material) o.material.visible = true;
        }),
      nm
    );
  }
  report.fullscreenAgain = await measure();
}
await browser.close();
fs.writeFileSync(path.join(outDir, `profile-${label}.json`), JSON.stringify(report, null, 2));
for (const [k, v] of Object.entries(report))
  if (typeof v === "object") console.log(k.padEnd(16), JSON.stringify(v));
