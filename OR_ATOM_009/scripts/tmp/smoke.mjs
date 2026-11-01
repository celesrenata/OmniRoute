import { chromium } from "playwright";
import {
  buildFleetBody,
  capturedAtFor,
  installFleetRoute,
  atomicRendererPrefInitScript,
  demoHandleSeedInitScript,
  perfSamplerInitScript,
  topologyUrl,
  waitForAtomicCanvas,
  samplePerf,
  FLEET_ENDPOINT,
} from "../lib/atomicDemo.mjs";
import fs from "node:fs";

const BASE = process.env.BASE,
  CHROME = process.env.CHROME_PATH,
  PW = process.env.LOGIN_PASSWORD;
const SCENARIO = process.env.SCENARIO || "tps-80";

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(atomicRendererPrefInitScript());
const capturedAt = capturedAtFor(SCENARIO);
const body = await buildFleetBody(SCENARIO, capturedAt);
await ctx.addInitScript(demoHandleSeedInitScript(), [SCENARIO, capturedAt]);
await ctx.addInitScript(perfSamplerInitScript());

const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push("PAGEERROR: " + e.message.slice(0, 300)));
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
});

const served = installFleetRoute(page, body);
const target = topologyUrl(SCENARIO, { dev: true, base: BASE });

await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90000 });
if (page.url().includes("/login") && PW) {
  await page.locator('input[type="password"]').first().fill(PW);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45000 }),
    page.locator("form").getByRole("button").first().click(),
  ]);
  if (!page.url().includes(target)) await page.goto(target, { waitUntil: "domcontentloaded" });
}
console.log("URL after login:", page.url());

let canvas = null,
  canvasErr = null;
try {
  canvas = await waitForAtomicCanvas(page, 45000);
} catch (e) {
  canvasErr = e.message.split("\n")[0];
}
console.log("CANVAS mounted:", canvas ? "yes" : "NO — " + canvasErr);
await page.waitForTimeout(5000);
const sample = await samplePerf(page);
const servedState = { servedCount: served.servedCount(), servedAt: served.servedAt().length };
const demo = await page.evaluate(() =>
  window.__atomicDemo
    ? {
        id: window.__atomicDemo.id,
        capturedAt: window.__atomicDemo.capturedAt,
        ageMs: window.__atomicDemo.capturedAt ? Date.now() - window.__atomicDemo.capturedAt : null,
      }
    : null
);
const status = await page.evaluate(() => {
  const el = document.querySelector("[data-atomic-telemetry-status]");
  return el
    ? { state: el.dataset.atomicTelemetryStatus, label: el.getAttribute("aria-label") }
    : null;
});
console.log("served:", JSON.stringify(servedState));
console.log("perf:", JSON.stringify(sample));
console.log("demoHandle:", JSON.stringify(demo));
const panelInfo = await page.evaluate(() => {
  const group = document.querySelector('[role="group"][aria-label="Topology view mode"]');
  return {
    hasToggle: Boolean(group),
    pressed: group
      ? (document.querySelector(
          '[role="group"][aria-label="Topology view mode"] [aria-pressed="true"]'
        )?.textContent ?? null)
      : null,
    notice: document.body.innerText.match(/Topology renderer unavailable[^\n]*/i)?.[0] ?? null,
    hasTopologyCard: /Provider Topology/i.test(document.body.innerText),
  };
});
console.log("telemetryBadge:", JSON.stringify(status));
console.log("panel:", JSON.stringify(panelInfo));
console.log("pageErrors:", JSON.stringify(pageErrors.slice(0, 5)));
console.log(
  "consoleErrors:",
  JSON.stringify(
    consoleErrors.filter((c) => !/FORBIDDEN_ORIGIN|GPU stall|GL Driver/.test(c)).slice(0, 5)
  )
);
await page.screenshot({ path: `OR_ATOM_009/scripts/tmp/smoke-${SCENARIO}-page.png` });
if (canvas)
  await canvas.screenshot({ path: `OR_ATOM_009/scripts/tmp/smoke-${SCENARIO}-canvas.png` });
await browser.close();
