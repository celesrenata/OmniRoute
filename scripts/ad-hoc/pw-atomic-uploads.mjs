#!/usr/bin/env node
/** Per-frame GPUQueue.writeBuffer volume and the largest buffers, bench or any URL. */
import { chromium } from "playwright";
const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const query = process.argv[2] ?? "atoms=20&paused=0";
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
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto(`${BASE}/dev/atomic-bench?${query}`);
await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(3500);
const r = await page.evaluate(
  () =>
    new Promise((res) => {
      const sizes = new Map();
      let calls = 0,
        bytes = 0,
        frames = 0;
      const o = GPUQueue.prototype.writeBuffer;
      GPUQueue.prototype.writeBuffer = function (buf, off, data, dOff, size) {
        const n =
          size != null
            ? size * (data.BYTES_PER_ELEMENT ?? 1)
            : (data.byteLength ?? 0) - (dOff ?? 0) * (data.BYTES_PER_ELEMENT ?? 1);
        calls++;
        bytes += n;
        const e = sizes.get(buf.label || buf.size) ?? { calls: 0, bytes: 0 };
        e.calls++;
        e.bytes += n;
        sizes.set(buf.label || buf.size, e);
        return o.call(this, buf, off, data, dOff, size);
      };
      const t0 = performance.now();
      const tick = (now) => {
        frames++;
        if (now - t0 < 4000) requestAnimationFrame(tick);
        else
          res({
            frames,
            callsPerFrame: Math.round(calls / frames),
            kbPerFrame: Math.round(bytes / frames / 1024),
            top: [...sizes.entries()]
              .sort((a, b) => b[1].bytes - a[1].bytes)
              .slice(0, 10)
              .map(([k, e]) => [
                String(k),
                Math.round(e.bytes / frames),
                +(e.calls / frames).toFixed(1),
              ]),
          });
      };
      requestAnimationFrame(tick);
    })
);
console.log(JSON.stringify(r));
await browser.close();
