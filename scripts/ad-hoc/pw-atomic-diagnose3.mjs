#!/usr/bin/env node
/** OR-ATOM-010 — who paints white under color-scheme: light? */
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:21128";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl"],
});

for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage({
    viewport: { width: 1700, height: 1100 },
    colorScheme: scheme,
  });
  await page.goto(`${BASE}/dev/atomic-bench?paused=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main[data-ready=true]", { timeout: 30000 });
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const el = document.elementFromPoint(800, 500);
    const chain = [];
    let n = el;
    while (n && n.tagName !== "BODY") {
      const cs = getComputedStyle(n);
      chain.push(
        `${n.tagName}.${(n.className && n.className.toString ? n.className.toString() : "").slice(0, 40)} bg=${cs.backgroundColor} vis=${cs.visibility} disp=${cs.display} z=${cs.zIndex}`
      );
      n = n.parentElement;
    }
    return {
      docClass: document.documentElement.className,
      docDataTheme: document.documentElement.dataset.theme || null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      mainBg: getComputedStyle(document.querySelector("main")).backgroundColor,
      centerChain: chain,
    };
  });
  console.log("==", scheme, "==");
  console.log(JSON.stringify(info, null, 1));
  await page.locator("main[data-atomic-bench]").screenshot({ path: `/tmp/d3_main_${scheme}.png` });
  await page
    .locator("canvas")
    .first()
    .screenshot({ path: `/tmp/d3_canvas_${scheme}.png` });
  await page.close();
}
await browser.close();
