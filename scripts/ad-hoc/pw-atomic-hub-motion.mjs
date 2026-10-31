#!/usr/bin/env node
/**
 * OR-ATOM-010 — hub-crop motion: capture a focused node with paused=0,
 * crop the hub+links region across 10 rapid frames, count bright pulse
 * pixels per frame, and emit a 4-frame strip so transient discharges can
 * be judged on pixels rather than assumed.
 */
import { chromium } from "@playwright/test";
import sharp from "sharp";

const BASE = "http://127.0.0.1:21128";
const OUT = "OR_ATOM_010/screenshots";

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/dev/atomic-bench?paused=0&node=provider:bench-primary`, {
  waitUntil: "domcontentloaded",
});
await page.waitForSelector("main[data-ready=true]", { timeout: 30000 });
await page.waitForTimeout(3000);
const host = page.locator("main[data-atomic-bench]");
const frames = [];
for (let i = 0; i < 10; i++) {
  const f = `${OUT}/hub_motion_${i}.png`;
  await host.screenshot({ path: f });
  frames.push(f);
  await page.waitForTimeout(60);
}
await browser.close();

const crop = { left: 600, top: 330, width: 400, height: 340 };
const cropBufs = [];
for (const f of frames) {
  const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true });
  const w = crop.width;
  const h = crop.height;
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = crop.top + y;
    for (let x = 0; x < w; x++) {
      const sx = crop.left + x;
      const si = (sy * info.width + sx) * info.channels;
      const di = (y * w + x) * 3;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
    }
  }
  cropBufs.push(out);
}
const bright = cropBufs.map((f) => {
  let c = 0;
  for (let i = 0; i < f.length; i += 3) {
    const l = 0.2126 * f[i] + 0.7152 * f[i + 1] + 0.0722 * f[i + 2];
    if (l > 200) c++;
  }
  return c;
});
console.log("hub crop bright(>200) per frame:", bright.join(" "));

const pick = [0, 3, 6, 9];
const comp = pick.map((i) => ({
  input: Buffer.from(cropBufs[i]),
  left: i * (crop.width / pick.length) * pick.length * 0,
  top: 0,
}));
const stripW = 200 * pick.length;
const stripH = 170;
await sharp({ create: { width: stripW, height: stripH, channels: 3, background: "#000" } })
  .composite(
    pick.map((i, k) => ({
      input: Buffer.from(cropBufs[i]),
      width: 200,
      height: 170,
      left: k * 200,
      top: 0,
    }))
  )
  .jpeg({ quality: 92 })
  .toFile(`${OUT}/hub_motion_strip.jpg`);
console.log("strip written", `${OUT}/hub_motion_strip.jpg`);
