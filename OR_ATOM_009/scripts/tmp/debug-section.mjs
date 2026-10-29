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
const errs = [];
page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message.slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 140));
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
await page.waitForTimeout(20000);
const out = await page.evaluate(async () => {
  let settings = null;
  try {
    const r = await fetch("/api/settings", { credentials: "include" });
    settings = await r.json();
  } catch (e) {
    settings = "ERR " + e.message;
  }
  const txt = document.body.innerText;
  return {
    url: location.href,
    canvases: document.querySelectorAll("canvas").length,
    hasTopologyHeading: /topology/i.test(txt)
      ? txt.match(/[^|\n]*topology[^|\n]*/gi)?.slice(0, 5)
      : null,
    showProviderTopologyOnHome:
      settings && typeof settings === "object" ? settings.showProviderTopologyOnHome : settings,
    bodyTail: txt.slice(-400).replace(/\n+/g, " | "),
  };
});
console.log(JSON.stringify(out, null, 1));
console.log("ERRORS:", errs.length ? [...new Set(errs)].slice(0, 12).join("\n") : "none");
await browser.close();
