import { chromium } from "playwright";
import {
  buildFleetBody,
  capturedAtFor,
  installFleetRoute,
  atomicRendererPrefInitScript,
  demoHandleSeedInitScript,
  perfSamplerInitScript,
  topologyUrl,
  ensureAuthenticated,
} from "../lib/atomicDemo.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:20999";
const CHROME = process.env.CHROME_PATH;
const PW = process.env.LOGIN_PASSWORD;
const SCENARIO = "mixed-lanes";

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(atomicRendererPrefInitScript());
await ctx.addInitScript(demoHandleSeedInitScript(), [SCENARIO, capturedAtFor(SCENARIO)]);
await ctx.addInitScript(perfSamplerInitScript());
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE:", m.text().slice(0, 200));
});

const body = await buildFleetBody(SCENARIO, capturedAtFor(SCENARIO));
const served = installFleetRoute(page, body);
const target = topologyUrl(SCENARIO, { dev: true, base: BASE });

await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90000 });
console.log("post-goto url:", page.url());
await ensureAuthenticated(page, PW, target);
console.log("post-auth url:", page.url());
await page.waitForSelector("canvas", { timeout: 45000 });
console.log("canvas mounted, served=", served.servedCount());
await page.waitForTimeout(3000);

// Inspect session artifacts before reload
const sessionArtifacts = await page.evaluate(() => ({
  cookie: document.cookie,
  storageKeys: Object.keys(sessionStorage),
  localKeys: Object.keys(localStorage),
  url: location.href,
}));
console.log("session artifacts before reload:", JSON.stringify(sessionArtifacts, null, 2));

// The soak's remount step
const t0 = Date.now();
await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
console.log("reload domcontentloaded in", Date.now() - t0, "ms; url:", page.url());
const onLogin = await page.locator('input[type="password"]').count();
console.log("login form present after reload:", onLogin > 0);
const servedAfter = served.servedCount();
console.log("fleet served after reload (so far):", servedAfter);

let canvasOk = false;
const t1 = Date.now();
try {
  await page.waitForSelector("canvas", { timeout: 45000 });
  canvasOk = true;
  console.log(
    "CANVAS MOUNTED after reload in",
    Date.now() - t1,
    "ms; served=",
    served.servedCount()
  );
} catch {
  console.log("NO CANVAS after 45s post-reload");
  const state = await page.evaluate(() => ({
    url: location.href,
    bodyLen: document.body?.innerHTML?.length,
    hasLogin: !!document.querySelector('input[type="password"]'),
    canvases: document.querySelectorAll("canvas").length,
    atomicHost: !!document.querySelector('[data-atomic-host="true"]'),
    demo: window.__atomicDemo || null,
  }));
  console.log("post-reload state:", JSON.stringify(state, null, 2));
}
await browser.close();
console.log("PROBE DONE canvasOk=" + canvasOk);
