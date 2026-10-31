#!/usr/bin/env node
/** OR-ATOM-010 — capture the bench main element + canvas pixel stats. */
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:21128";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl"],
});
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
const consoleLines = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleLines.push(m.text().slice(0, 300));
});

await page.goto(`${BASE}/dev/atomic-bench?paused=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("main[data-ready=true]", { timeout: 30000 });
await page.waitForTimeout(4000);

const main = page.locator("main[data-atomic-bench]");
await main.screenshot({ path: "/tmp/atomic_main.png" });
await page.locator("canvas").first().screenshot({ path: "/tmp/atomic_canvas.png" });

// WebGL readback
const stats = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
  if (!gl) return "no gl handle (context owned by three)";
  const w = canvas.width,
    h = canvas.height;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let sum = 0,
    dark = 0,
    bright = 0,
    satSum = 0,
    chan = [0, 0, 0];
  const hist = new Map();
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const r = buf[i],
        g = buf[i + 1],
        b = buf[i + 2],
        a = buf[i + 3];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum;
      if (lum < 60) dark++;
      if (lum > 200) bright++;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b);
      satSum += mx === 0 ? 0 : (mx - mn) / mx;
      chan[0] += r;
      chan[1] += g;
      chan[2] += b;
      const key = (r >> 4) + "," + (g >> 4) + "," + (b >> 4);
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  const n = (h / 2) * (w / 2);
  const top = [...hist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => {
      const [r, g, b] = k.split(",").map(Number);
      return `rgb(${r << 4},${g << 4},${b << 4}) ${((v / n) * 100).toFixed(1)}%`;
    });
  return {
    size: `${w}x${h}`,
    meanLum: (sum / n).toFixed(1),
    fracDark: (dark / n).toFixed(3),
    fracBright: (bright / n).toFixed(3),
    meanRGB: chan.map((c) => (c / n).toFixed(0)).join(","),
    meanSat: (satSum / n).toFixed(3),
    top,
  };
});
console.log("webgl readback:", JSON.stringify(stats, null, 2));
console.log("console errors:", consoleLines.length);
consoleLines.slice(0, 10).forEach((l) => console.log("  ", l));
await browser.close();
