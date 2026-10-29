import { chromium } from "playwright";
const BASE = process.env.BASE,
  CHROME = process.env.CHROME_PATH,
  PW = process.env.LOGIN_PASSWORD;
const ARGS = process.env.GL_ARGS ? process.env.GL_ARGS.split(" ") : [];
const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ARGS,
  ignoreDefaultArgs: ["--hide-scrollbars"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try {
    window.localStorage.setItem("omniroute.topology.renderer", "atomic");
  } catch {}
});
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message.slice(0, 150)));
page.on("console", (m) => {
  if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 120));
});
await page.goto(BASE + "/home?topology-demo=mixed-lanes&topology-dev=1", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
if (page.url().includes("/login") && PW) {
  await page.locator('input[type="password"]').first().fill(PW);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login")),
    page.locator("form").getByRole("button").first().click(),
  ]);
  await page.goto(BASE + "/home?topology-demo=mixed-lanes&topology-dev=1", {
    waitUntil: "domcontentloaded",
  });
}
await page.waitForTimeout(15000);
const state = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  return {
    url: location.href,
    canvases: document.querySelectorAll("canvas").length,
    hasWebGL2: (() => {
      try {
        const cv = document.createElement("canvas");
        return !!cv.getContext("webgl2");
      } catch {
        return false;
      }
    })(),
    atomicDemo: window.__atomicDemo ?? null,
  };
});
console.log(JSON.stringify(state, null, 1));
console.log("ERRORS:", errs.length ? [...new Set(errs)].slice(0, 10).join("\n") : "none");
await page.screenshot({ path: "OR_ATOM_009/scripts/tmp/debug-gl.png" });
await browser.close();
