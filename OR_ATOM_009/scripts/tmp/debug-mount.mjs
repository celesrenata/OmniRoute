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
  if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 200));
});
const requests = [];
page.on("request", (r) => {
  if (r.url().includes("telemetry") || r.url().includes("providers"))
    requests.push(r.method() + " " + r.url().slice(0, 120));
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
await page.waitForTimeout(8000);
const before = await page.evaluate(() => ({
  canvases: document.querySelectorAll("canvas").length,
  atomicPressed:
    document.querySelector('[role="group"][aria-label="Topology view mode"] [aria-pressed="true"]')
      ?.textContent ?? null,
  notice: /renderer unavailable/i.test(document.body.innerText),
}));
console.log("BEFORE", JSON.stringify(before));
try {
  await page
    .getByRole("button", { name: "Atomic", exact: true })
    .click({ timeout: 10000, trial: false });
  console.log("click OK");
} catch (e) {
  console.log("click ERR:", e.message.split("\n")[0]);
  try {
    await page
      .getByRole("button", { name: "Atomic", exact: true })
      .click({ force: true, timeout: 10000 });
    console.log("force click OK");
  } catch (e2) {
    console.log("force click ERR:", e2.message.split("\n")[0]);
  }
}
for (const i of [0, 5, 15]) {
  await page.waitForTimeout(i === 0 ? 5000 : i === 5 ? 5000 : 10000);
  const s = await page.evaluate(() => ({
    canvases: document.querySelectorAll("canvas").length,
    canvasSizes: [...document.querySelectorAll("canvas")].map((c) => c.width + "x" + c.height),
    atomicPressed:
      document.querySelector(
        '[role="group"][aria-label="Topology view mode"] [aria-pressed="true"]'
      )?.textContent ?? null,
    notice: document.body.innerText.match(/Topology renderer unavailable[^\n]*/i)?.[0] ?? null,
  }));
  console.log(`T+${i}s`, JSON.stringify(s));
  if (i === 15) await page.screenshot({ path: "OR_ATOM_009/scripts/tmp/debug-mount.png" });
}
console.log("FLEET REQS (first 5):", requests.filter((u) => u.includes("telemetry")).slice(0, 5));
console.log("ERRS:", JSON.stringify(errs.slice(0, 8), null, 1));
await browser.close();
