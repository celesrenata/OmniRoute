import { chromium } from "playwright";
import {
  buildFleetBody,
  capturedAtFor,
  installFleetRoute,
  atomicRendererPrefInitScript,
  demoHandleSeedInitScript,
  perfSamplerInitScript,
  topologyUrl,
} from "../lib/atomicDemo.mjs";

const BASE = process.env.BASE,
  CHROME = process.env.CHROME_PATH,
  PW = process.env.LOGIN_PASSWORD;
const body = await buildFleetBody("tps-80", capturedAtFor("tps-80"));

async function variant(name, { route, dev, seedDemo, seedPerf }) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(atomicRendererPrefInitScript());
  if (seedDemo)
    await ctx.addInitScript(demoHandleSeedInitScript(), ["tps-80", capturedAtFor("tps-80")]);
  if (seedPerf) await ctx.addInitScript(perfSamplerInitScript());
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message.slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 200));
  });
  let served = null;
  if (route) served = installFleetRoute(page, body);
  await page.goto(topologyUrl("tps-80", { dev, base: BASE }), {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  if (page.url().includes("/login") && PW) {
    await page.locator('input[type="password"]').first().fill(PW);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45000 }),
      page.locator("form").getByRole("button").first().click(),
    ]);
    if (!page.url().includes("topology-demo"))
      await page.goto(topologyUrl("tps-80", { dev, base: BASE }), {
        waitUntil: "domcontentloaded",
      });
  }
  await page.waitForTimeout(12000);
  const s = await page.evaluate(() => ({
    canvases: document.querySelectorAll("canvas").length,
    pressed:
      document.querySelector(
        '[role="group"][aria-label="Topology view mode"] [aria-pressed="true"]'
      )?.textContent ?? null,
    badge:
      document.querySelector("[data-atomic-telemetry-status]")?.dataset.atomicTelemetryStatus ??
      null,
    empty: document.querySelector("[data-atomic-empty]")?.textContent ?? null,
    pref: (() => {
      try {
        return localStorage.getItem("omniroute.topology.renderer");
      } catch {
        return "n/a";
      }
    })(),
  }));
  const filtered = errs.filter(
    (e) => !/FORBIDDEN_ORIGIN|GL Driver|GPU stall|synchronously unmount/.test(e)
  );
  console.log(`VARIANT ${name}: ${JSON.stringify(s)}`);
  if (served) console.log(`  served=${served.servedCount()}`);
  if (filtered.length) console.log(`  ERRS: ${JSON.stringify(filtered.slice(0, 5))}`);
  await browser.close();
}

await variant("A: plain (route+dev+demo+perf like smoke)", {
  route: true,
  dev: true,
  seedDemo: true,
  seedPerf: true,
});
await variant("B: no route, dev+demo+perf", {
  route: false,
  dev: true,
  seedDemo: true,
  seedPerf: true,
});
await variant("C: no route, no dev param, demo+perf", {
  route: false,
  dev: false,
  seedDemo: true,
  seedPerf: true,
});
