#!/usr/bin/env node
/** Directive 45: the 30 fps throttle + default hero/reflection passes on WebGPU and WebGL2 (bench detail). */
import { chromium } from "playwright";
const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-position=0,0",
  ],
});
const page = await (
  await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
for (const backend of ["webgpu", "webgl"]) {
  for (const sync of [false, true, false]) {
    errors.length = 0;
    await page.goto(
      `${BASE}/dev/atomic-bench?atoms=20&paused=0&badge=0&node=provider:bench-primary&detail=1&backend=${backend}`
    );
    await page.evaluate(
      (s) => localStorage.setItem("omniroute.atomic.syncRefresh", s ? "1" : "0"),
      sync
    );
    await page.reload();
    await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
    await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 12000));
    const r = await page.evaluate(
      () =>
        new Promise((res) => {
          window.__atomicFrameTimes = [];
          setTimeout(() => {
            const t = window.__atomicFrameTimes;
            res({
              mode: window.__atomicFrameRate?.(),
              heroIdx: window.__atomicHeroIdx,
              backend:
                document.querySelector("[data-backend]")?.getAttribute("data-backend") ?? null,
              fps: +((t.length - 1) / ((t[t.length - 1] - t[0]) / 1000)).toFixed(2),
            });
          }, 4000);
        })
    );
    await page.screenshot({ path: `/tmp/backend-${backend}-${sync ? "sync" : "30"}.png` });
    console.log(
      JSON.stringify({
        backend,
        sync,
        ...r,
        errors: errors.filter((e) => !/FORBIDDEN_ORIGIN/.test(e)),
      })
    );
  }
}
await browser.close();
