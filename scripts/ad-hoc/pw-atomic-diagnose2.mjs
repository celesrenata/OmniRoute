#!/usr/bin/env node
/** OR-ATOM-010 — probe: is the white from capture, host CSS, or canvas compositing? */
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:21128";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl"],
});
const page = await browser.newPage({
  viewport: { width: 1700, height: 1100 },
  colorScheme: "dark",
});
await page.goto(`${BASE}/dev/atomic-bench?paused=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("main[data-ready=true]", { timeout: 30000 });
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const main = document.querySelector("main[data-atomic-bench]");
  const cs = getComputedStyle(main);
  const bodyCs = getComputedStyle(document.body);
  const htmlCs = getComputedStyle(document.documentElement);
  const canvas = document.querySelector("canvas");
  const r = canvas ? canvas.getBoundingClientRect() : null;
  return {
    mainBg: cs.backgroundColor,
    mainColorScheme: cs.colorScheme,
    bodyBg: bodyCs.backgroundColor,
    htmlBg: htmlCs.backgroundColor,
    mainRect: JSON.parse(JSON.stringify(main.getBoundingClientRect())),
    canvasRect: r,
    canvasAlphaCss: canvas ? getComputedStyle(canvas).mixBlendMode : null,
  };
});
console.log("styles:", JSON.stringify(info, null, 1));

// 1) element screenshot of a synthetic dark box appended to the bench page
await page.evaluate(() => {
  const d = document.createElement("div");
  d.id = "probe-dark";
  d.style.cssText =
    "position:absolute;left:0;top:0;width:200px;height:200px;background:#05060f;z-index:9999";
  document.body.appendChild(d);
});
await page.locator("#probe-dark").screenshot({ path: "/tmp/probe_dark.png" });

// 2) omitBackground page shot — reveals where the canvas composites as opaque
await page.screenshot({ path: "/tmp/probe_page_omitbg.png", omitBackground: true });
// 3) normal page shot
await page.screenshot({ path: "/tmp/probe_page.png" });
await browser.close();

const sharp = (await import("/Users/celes/sources/celesrenata/OmniRoute/node_modules/sharp"))
  .default;
const stats = async (f) => {
  const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  let s = 0,
    d = 0,
    n = 0;
  for (let y = 0; y < H; y += 2)
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * C;
      const a = C === 4 ? data[i + 3] : 255;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      s += lum * (a / 255);
      if (lum < 60) d++;
      n++;
    }
  return `${W}x${H} ch=${C} meanLum=${(s / n).toFixed(1)} fracDark=${(d / n).toFixed(3)}`;
};
console.log("probe_dark:", await stats("/tmp/probe_dark.png"));
console.log("page_omitbg:", await stats("/tmp/probe_page_omitbg.png"));
console.log("page:", await stats("/tmp/probe_page.png"));
