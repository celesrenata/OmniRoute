import { chromium } from "playwright";
const BASE = process.env.BASE,
  CHROME = process.env.CHROME_PATH,
  PW = process.env.LOGIN_PASSWORD;
const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try {
    window.localStorage.setItem("omniroute.topology.renderer", "atomic");
  } catch {}
});
const page = await ctx.newPage();
const mountErrs = [];
page.on("pageerror", (e) => mountErrs.push("PAGEERROR: " + e.message.slice(0, 200)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" || /mount failed|WebGL|webgl|THREE/i.test(t))
    mountErrs.push(m.type().toUpperCase() + ": " + t.slice(0, 160));
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
await page.waitForTimeout(12000);
const before = await page.evaluate(() => ({
  pref: (() => {
    try {
      return localStorage.getItem("omniroute.topology.renderer");
    } catch {
      return "n/a";
    }
  })(),
  canvases: document.querySelectorAll("canvas").length,
  fallbackNotice: /Topology renderer unavailable/i.test(document.body.innerText),
}));
// Try clicking the Atomic toggle
let atomicBtn = page.getByRole("button", { name: /atomic/i }).first();
let clicked = false;
if (await atomicBtn.count()) {
  try {
    await atomicBtn.click({ timeout: 5000 });
    clicked = true;
  } catch (e) {
    clicked = "ERR " + e.message.slice(0, 80);
  }
}
await page.waitForTimeout(10000);
const after = await page.evaluate(() => ({
  canvases: document.querySelectorAll("canvas").length,
  fallbackNotice: /Topology renderer unavailable/i.test(document.body.innerText),
}));
console.log("BEFORE", JSON.stringify(before));
console.log("clickedAtomic", clicked);
console.log("AFTER", JSON.stringify(after));
console.log(
  "MOUNT/GPU ERRORS:",
  mountErrs.length ? [...new Set(mountErrs)].slice(0, 15).join("\n") : "none"
);
await browser.close();
