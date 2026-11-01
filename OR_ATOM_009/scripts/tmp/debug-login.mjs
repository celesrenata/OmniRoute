import { chromium } from "playwright";
const BASE = process.env.BASE;
const CHROME = process.env.CHROME_PATH;
const PW = process.env.LOGIN_PASSWORD;
const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try {
    window.localStorage.setItem("omniroute.topology.renderer", "atomic");
  } catch {}
});
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message.slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 200));
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
  console.log("logged in ->", page.url());
  await page.goto(BASE + "/home?topology-demo=mixed-lanes&topology-dev=1", {
    waitUntil: "domcontentloaded",
  });
}
await page.waitForTimeout(20000);
const state = await page.evaluate(() => ({
  url: location.href,
  canvases: document.querySelectorAll("canvas").length,
  bodyLen: document.body.innerText.length,
  bodyHead: document.body.innerText.slice(0, 500).replace(/\n+/g, " | "),
  atomicDemo: window.__atomicDemo ?? null,
}));
console.log(JSON.stringify(state, null, 1));
console.log("ERRORS:", errs.length ? errs.slice(0, 15).join("\n") : "none");
await page.screenshot({ path: "OR_ATOM_009/scripts/tmp/debug-login.png" });
await browser.close();
