#!/usr/bin/env node
/**
 * OR-ATOM-010 — motion evidence: capture consecutive running-scene frames
 * (paused=0) so transient link pulses / discharges are visible as motion,
 * not just a frozen paused frame.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:21128";
const OUT = "OR_ATOM_010/screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/dev/atomic-bench?paused=0`, { waitUntil: "domcontentloaded" }); // explicit live
await page.waitForSelector("main[data-ready=true]", { timeout: 30000 });
await page.waitForTimeout(2500); // let the scene settle into traffic
const host = page.locator("main[data-atomic-bench]");
const N = 6;
const frames = [];
for (let i = 0; i < N; i++) {
  const f = `${OUT}/motion_run_${i}.png`;
  await host.screenshot({ path: f });
  frames.push(f);
  await page.waitForTimeout(120);
}
console.log("motion frames:", frames.join(" "));
await browser.close();
