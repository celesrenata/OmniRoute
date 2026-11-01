// One-off live diagnostic (OR-ATOM-009). Not a gate; prints actual page state.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  buildFleetBody,
  installFleetRoute,
  atomicRendererPrefInitScript,
  perfSamplerInitScript,
  waitForAtomicCanvas,
  ensureAuthenticated,
  samplePerf,
  topologyUrl,
} from "./atomicDemo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || "http://127.0.0.1:21011";
const CHROME = process.env.CHROME_PATH;
const PW = process.env.LOGIN_PASSWORD || null;
const SCENARIO = process.env.SCENARIO || "mixed-lanes";

const scenario = buildFleetBody(SCENARIO, Date.now() - 4000);
const LAUNCH_ARGS =
  process.env.CHROME_ARGS === "none"
    ? []
    : (process.env.CHROME_ARGS || "swiftshader").split(",").map((s) => s.trim());
console.log("launchArgs:", JSON.stringify(LAUNCH_ARGS));
const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: LAUNCH_ARGS,
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(atomicRendererPrefInitScript());
await ctx.addInitScript(perfSamplerInitScript());
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push("PAGEERROR: " + String(e).slice(0, 500)));
const consoleMsgs = [];
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" || t.includes("TMP-ATOM")) {
    consoleMsgs.push(`CONSOLE[${m.type()}]: ` + t.slice(0, 300));
  }
});
const fleetRoute = installFleetRoute(page, scenario);
const url = topologyUrl(SCENARIO, { dev: true, base: BASE, demo: false });
console.log("goto", url);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
await ensureAuthenticated(page, PW, url);
await page.waitForLoadState("load").catch(() => {});
try {
  await waitForAtomicCanvas(page, 60_000);
  console.log("canvas mounted");
} catch (e) {
  console.log("canvas NOT mounted:", String(e).slice(0, 200));
}
await page.waitForTimeout(8000);

const state = await page.evaluate(() => {
  const w = window;
  const diag = w.__atomicDiagnostics || null;
  const canvases = [...document.querySelectorAll("canvas")].map((c) => ({
    w: c.width,
    h: c.height,
  }));
  const panel = document.querySelector(".atomic-telemetry-diagnostics");
  const linkRows = [...document.querySelectorAll("[data-atomic-diag-link]")].map((r) =>
    r.textContent.trim().slice(0, 120)
  );
  // Discriminators: which renderer is active + does WebGL2 exist in this browser.
  const toggleBtns = [...document.querySelectorAll('[aria-label="Topology view mode"] button')].map(
    (b) => ({ label: b.textContent.trim(), pressed: b.getAttribute("aria-pressed") })
  );
  const host = document.querySelector(".atomic-topology-host");
  const hostInner = host ? host.innerHTML.length : null;
  const sceneCanvasDiv = document.querySelector(".atomic-scene-canvas");
  const sceneInner = sceneCanvasDiv ? sceneCanvasDiv.innerHTML.slice(0, 300) : null;
  let webgl2 = null;
  try {
    const c = document.createElement("canvas");
    webgl2 = c.getContext("webgl2") != null;
  } catch {
    webgl2 = false;
  }
  return {
    hasPulse: typeof w.__atomicPulse === "function",
    hasDemo:
      typeof w.__atomicDemo !== "undefined"
        ? { id: w.__atomicDemo.id, active: w.__atomicDemo.active }
        : null,
    diag,
    canvases,
    canvasCount: canvases.length,
    atomicHosts: document.querySelectorAll(".atomic-topology-host").length,
    hostInner: hostInner,
    sceneInner: sceneInner,
    sceneHosts: document.querySelectorAll('[data-atomic-host="true"]').length,
    sceneCanvasDivs: document.querySelectorAll(".atomic-scene-canvas").length,
    toggleBtns,
    webgl2,
    panelPresent: !!panel,
    panelAria: panel ? panel.getAttribute("aria-label") : null,
    linkRows,
    badge: document
      .querySelector("[data-atomic-telemetry-status]")
      ?.getAttribute("data-atomic-telemetry-status"),
  };
});
console.log(JSON.stringify(state, null, 2));
console.log("pageErrors:", JSON.stringify(pageErrors, null, 2));
console.log("consoleMsgs:", JSON.stringify(consoleMsgs.slice(0, 10), null, 2));
await page.screenshot({
  path: path.resolve(HERE, "../../screenshots/step9-final/gap2/diag-page.png"),
});
await browser.close();
