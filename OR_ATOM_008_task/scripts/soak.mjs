// OR-ATOM-008 S8.5 — 20-minute telemetry-polling soak against the 'after'
// (S8-patched) dev server. GATE:
//   - 20 frames (one per minute) composited + pixel-variance-checked.
//   - renderer.info triple (render.calls / memory.geometries /
//     memory.textures) BEFORE and AFTER the soak, plus per-minute samples.
//   - active WebGL context count stable (live canvas count) — no context loss.
//   - dispose works: a forced scene remount at the mid-point must return
//     liveCanvases to baseline (no unbounded geometry/texture growth).
//   - per-minute FPS + console errors.
//
// Usage:
//   BASE=http://127.0.0.1:20140 TAG=after DURATION=1200 node soak.mjs
//
// Writes (OUT_DIR): soak-after.json, soak-after.log, soak-after-min-<N>.png,
// soak-after-final.png, soak-after-final-page.png, soak-after-remount.png
import { chromium } from "playwright";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE;
const TAG = process.env.TAG || "after";
const DURATION = Math.max(600, parseInt(process.env.DURATION || "1200", 10)); // seconds
const OUT_DIR = process.env.OUT_DIR || "OR_ATOM_008_task/screenshots";
const REMOUNT_AT = process.env.REMOUNT_AT === "0" ? -1 : Math.round(DURATION * 0.5);
const TRAFFIC_AT = process.env.TRAFFIC_AT !== "0" ? Math.round(DURATION * 0.35) : -1;
const MODEL = process.env.MODEL || "kiro/claude-haiku-4.5";
let PARTIAL = null;

const SHELL =
  "/Users/celes/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";

async function frameStats(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let sum = 0;
  const lum = new Float64Array(n);
  const ch = info.channels;
  for (let p = 0, i = 0; p < n; p++, i += ch) {
    const l = data[i] + data[i + 1] + data[i + 2];
    lum[p] = l;
    sum += l;
  }
  const mean = sum / n;
  let sq = 0;
  for (let p = 0; p < n; p++) sq += (lum[p] - mean) * (lum[p] - mean);
  return {
    pixelVar: Math.round(sq / n),
    meanLum: Math.round(mean),
    size: [info.width, info.height],
  };
}

async function fireTraffic() {
  const models = [MODEL, MODEL];
  const jobs = models.map(async (model) => {
    try {
      const r = await fetch(BASE + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 8,
        }),
      });
      return { model, status: r.status };
    } catch (e) {
      return { model, status: "ERR:" + e.message };
    }
  });
  return Promise.all(jobs);
}

const logLines = [];
const log = (line) => {
  const ts = new Date().toISOString();
  const s = `[${ts}] ${line}`;
  logLines.push(s);
  console.log(s);
};

async function main() {
  if (!BASE) throw new Error("BASE env required");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    executablePath:
      "/Users/celes/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    args: [],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((p) => {
    try {
      window.localStorage.setItem("omniroute.topology.renderer", p);
    } catch {}
  }, "atomic");
  // rAF sampler (per-minute FPS) + WebGL context lifecycle tracker.
  await ctx.addInitScript(() => {
    window.__ft = { frames: 0, dtSum: 0, dtMax: 0, last: 0, windowFrames: 0, windowStart: 0 };
    function tick(ts) {
      const ft = window.__ft;
      if (ft.last) {
        const dt = ts - ft.last;
        ft.frames++;
        ft.dtSum += dt;
        if (dt > ft.dtMax) ft.dtMax = dt;
      }
      ft.windowFrames++;
      ft.last = ts;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    window.__ctxEvents = { lost: 0, restored: 0 };
    document.addEventListener("webglcontextlost", () => {
      window.__ctxEvents.lost++;
    });
    document.addEventListener("webglcontextrestored", () => {
      window.__ctxEvents.restored++;
    });
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => {
    pageErrors.push("PAGEERROR: " + e.message.slice(0, 300));
    log("pageerror: " + e.message.slice(0, 300));
  });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });

  const t0 = Date.now();
  log(`soak start base=${BASE} duration=${DURATION}s`);
  await page.goto(BASE + "/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(4000);
  await page
    .waitForFunction(() => window.__atomic?.rendererInfo, null, { timeout: 30000 })
    .catch(() => {});

  // ---- BEFORE triple (gate) ----
  const before = await page.evaluate(() => ({
    at: new Date().toISOString(),
    rendererInfo: window.__atomic?.rendererInfo ?? null,
    liveCanvases: window.__atomic?.liveCanvases ?? null,
    peakCanvases: window.__atomic?.peakCanvases ?? null,
    contextLost: window.__atomic?.contextLost ?? 0,
    contextRestored: window.__atomic?.contextRestored ?? 0,
    remounts: window.__atomic?.remounts ?? 0,
    canvases: [...document.querySelectorAll("canvas")].map((c) => ({ w: c.width, h: c.height })),
  }));
  log("BEFORE " + JSON.stringify(before));

  const perMinute = [];
  const metrics200 = { count: 0 };
  page.on("response", (r) => {
    if (r.url().includes("/api/provider-metrics") && r.status() === 200) metrics200.count++;
  });

  const remountResult = { done: false };
  const trafficResult = { done: false };

  const minutes = Math.floor(DURATION / 60);
  for (let i = 1; i <= minutes; i++) {
    const waitMs = (DURATION / minutes) * 1000;
    await page.waitForTimeout(waitMs);
    const el = page.locator("canvas").first();
    const shotFile = path.join(OUT_DIR, `soak-${TAG}-min-${i}.png`);
    try {
      await el.screenshot({ path: shotFile, timeout: 15000 });
    } catch (e) {
      await page.screenshot({ path: shotFile });
      log(
        `minute ${i}: element screenshot failed (${e.message.slice(0, 120)}) — used page screenshot`
      );
    }
    const stats = await frameStats(shotFile);
    const probe = await page
      .evaluate(() => ({
        rendererInfo: window.__atomic?.rendererInfo ?? null,
        liveCanvases: window.__atomic?.liveCanvases ?? null,
        peakCanvases: window.__atomic?.peakCanvases ?? null,
        contextLost: window.__atomic?.contextLost ?? 0,
        contextRestored: window.__atomic?.contextRestored ?? 0,
        remounts: window.__atomic?.remounts ?? 0,
      }))
      .catch(() => null);
    const fps = await page.evaluate(() => {
      const f = window.__ft;
      const inst = f.windowFrames && f.frames ? f.windowFrames / (f.dtSum / 1000 || 1) : 0;
      f.windowFrames = 0;
      f.frames = 0;
      f.dtSum = 0;
      return Math.round(inst);
    });
    const rec = {
      min: i,
      t: ((Date.now() - t0) / 1000).toFixed(1) + "s",
      pixelVar: stats.pixelVar,
      nonBlank: stats.pixelVar > 1,
      fps,
      metrics200: metrics200.count,
      consoleErrors: consoleErrors.length,
      ...probe,
    };
    perMinute.push(rec);
    log(
      `min ${i}: pixelVar=${rec.pixelVar} fps=${fps} liveCanvases=${rec.liveCanvases} ctxLost=${rec.contextLost} geoms=${rec.rendererInfo?.geometries} tex=${rec.rendererInfo?.textures} calls=${rec.rendererInfo?.calls} consoleErrors=${rec.consoleErrors}`
    );

    // Mid-point: force a remount to exercise dispose; capture the result.
    if (REMOUNT_AT >= 0 && !remountResult.done && (Date.now() - t0) / 1000 >= REMOUNT_AT) {
      const pre = await page.evaluate(() => window.__atomic);
      await page.evaluate(() => window.__atomic?.probeRemount?.());
      await page.waitForTimeout(3500);
      const post = await page.evaluate(() => window.__atomic);
      await page.screenshot({ path: path.join(OUT_DIR, `soak-${TAG}-remount.png`) });
      remountResult.done = true;
      remountResult.pre = pre;
      remountResult.post = post;
      log(
        `remount: pre live=${pre?.liveCanvases} peak=${pre?.peakCanvases} | post live=${post?.liveCanvases} peak=${post?.peakCanvases} remounts=${post?.remounts} geoms=${post?.rendererInfo?.geometries} tex=${post?.rendererInfo?.textures} calls=${post?.rendererInfo?.calls}`
      );
    }
    // ~35% in: fire traffic to exercise one-shot discharges during the soak.
    if (TRAFFIC_AT >= 0 && !trafficResult.done && (Date.now() - t0) / 1000 >= TRAFFIC_AT) {
      const tr = await fireTraffic();
      trafficResult.done = true;
      trafficResult.results = tr;
      log(`mid-soak traffic: ${JSON.stringify(tr)}`);
    }
  }

  // ---- AFTER triple (gate) ----
  const after = await page.evaluate(() => ({
    at: new Date().toISOString(),
    rendererInfo: window.__atomic?.rendererInfo ?? null,
    liveCanvases: window.__atomic?.liveCanvases ?? null,
    peakCanvases: window.__atomic?.peakCanvases ?? null,
    contextLost: window.__atomic?.contextLost ?? 0,
    contextRestored: window.__atomic?.contextRestored ?? 0,
    remounts: window.__atomic?.remounts ?? 0,
    canvases: [...document.querySelectorAll("canvas")].map((c) => ({ w: c.width, h: c.height })),
  }));
  log("AFTER " + JSON.stringify(after));

  await page
    .locator("canvas")
    .first()
    .screenshot({ path: path.join(OUT_DIR, `soak-${TAG}-final.png`) })
    .catch(async () => {
      await page.screenshot({ path: path.join(OUT_DIR, `soak-${TAG}-final.png`) });
    });
  await page.screenshot({ path: path.join(OUT_DIR, `soak-${TAG}-final-page.png`) });
  const finalStats = await frameStats(path.join(OUT_DIR, `soak-${TAG}-final.png`));

  // Verdicts (gate assertions).
  const ri = (o) =>
    o && o.rendererInfo
      ? {
          calls: o.rendererInfo.calls,
          geoms: o.rendererInfo.geometries,
          tex: o.rendererInfo.textures,
        }
      : null;
  const stableContexts =
    before.liveCanvases === after.liveCanvases &&
    after.contextLost === 0 &&
    before.liveCanvases === 1;
  const disposeOk =
    remountResult.done &&
    remountResult.post &&
    (remountResult.post.liveCanvases === 1 || remountResult.post.liveCanvases === null) &&
    remountResult.post.contextLost === 0;
  const noGrowth =
    ri(before) &&
    ri(after) &&
    after.rendererInfo.geometries <= before.rendererInfo.geometries + 4 &&
    after.rendererInfo.textures <= before.rendererInfo.textures + 2;
  const allNonBlank = perMinute.every((m) => m.nonBlank);

  const result = {
    tag: TAG,
    base: BASE,
    durationSec: DURATION,
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date().toISOString(),
    before,
    after,
    perMinute,
    remount: remountResult,
    traffic: trafficResult,
    finalFrame: finalStats,
    metrics200Total: metrics200.count,
    pageErrors,
    consoleErrors: [...new Set(consoleErrors)],
    verdicts: {
      stableContexts,
      disposeOk,
      noUnboundedGrowth: noGrowth,
      allFramesNonBlank: allNonBlank,
      pass: stableContexts && disposeOk && noGrowth && allNonBlank,
    },
  };
  PARTIAL = result;
  fs.writeFileSync(path.join(OUT_DIR, `soak-${TAG}.json`), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `soak-${TAG}.log`), logLines.join("\n") + "\n");
  log("VERDICT " + JSON.stringify(result.verdicts));
  await browser.close();
}

main().catch((e) => {
  log("FATAL " + (e.stack || e));
  if (PARTIAL) {
    try {
      fs.writeFileSync(path.join(OUT_DIR, `soak-${TAG}.json`), JSON.stringify(PARTIAL, null, 2));
      log("PARTIAL JSON flushed to soak-" + TAG + ".json");
    } catch (e2) {
      log("PARTIAL flush failed: " + (e2.stack || e2));
    }
  }
  fs.writeFileSync(
    path.join(OUT_DIR, `soak-${TAG}.log`),
    logLines.join("\n") + "\nFATAL " + (e.stack || e) + "\n"
  );
  process.exit(1);
});
