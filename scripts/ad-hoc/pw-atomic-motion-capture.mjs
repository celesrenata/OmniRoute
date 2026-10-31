#!/usr/bin/env node
/**
 * OR-ATOM-010 — motion evidence capture.
 *
 * Two frames seconds apart on the RUNNING scene (`paused=0`) → proof the
 * orbital spin + energy-link pulse + haze are animating (not a frozen
 * still). Emits `OR_ATOM_010/screenshots/motion_<a|b>.png` + an identical
 * byte check (false = scene is moving).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE_URL = process.env.ATOMIC_BASE_URL || "http://127.0.0.1:21128";
const OUT_DIR = "OR_ATOM_010/screenshots";
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto(`${BASE_URL}/dev/atomic-bench?paused=0&badge=0`, {
  waitUntil: "networkidle",
});
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT_DIR}/motion_a.png` });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT_DIR}/motion_b.png` });

const a = readFileSync(`${OUT_DIR}/motion_a.png`);
const b = readFileSync(`${OUT_DIR}/motion_b.png`);
console.log(
  `motion_a=${a.length}B motion_b=${b.length}B identical=${a.equals(b)} errors=${errors.length}`
);
await browser.close();
