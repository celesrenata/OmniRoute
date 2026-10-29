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
page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message.slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 250));
});
const chunks = [];
page.on("response", async (res) => {
  const u = res.url();
  if (
    /three|r3f|react-three|@react-three|drei|maath|stats\.js|zustand/i.test(u) &&
    u.includes("_next")
  )
    chunks.push(`${res.status()} ${u.slice(0, 140)}`);
});
await page.goto(BASE + "/home?topology-demo=mixed-lanes&topology-dev=1", {
  waitUntil: "domcontentloaded",
  timeout: 90000,
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
for (const t of [10, 25, 45]) {
  await page.waitForTimeout(t === 10 ? 10000 : t === 25 ? 15000 : 20000);
  const s = await page.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="Topology view mode"]');
    const card = group ? (group.closest(".relative")?.parentElement ?? document.body) : null;
    const panel =
      group?.closest("div[class*=h-\\[420px\\]]") ?? group?.closest("div.relative") ?? null;
    const canvases = [...document.querySelectorAll("canvas")].map(
      (c) => `${c.width}x${c.height} visible=${c.offsetParent !== null}`
    );
    const sceneDiv = document.querySelector(".atomic-scene-canvas");
    return {
      canvases,
      sceneDivHtml: sceneDiv ? sceneDiv.outerHTML.slice(0, 800) : null,
      panelHtml: panel ? panel.outerHTML.slice(0, 1500) : "panel not found",
      atomicPressed:
        document.querySelector(
          '[role="group"][aria-label="Topology view mode"] [aria-pressed="true"]'
        )?.textContent ?? null,
    };
  });
  console.log(`== T+${t}s == canvases: ${JSON.stringify(s.canvases)} pressed=${s.atomicPressed}`);
  console.log("sceneDiv:", s.sceneDivHtml);
  console.log("panelHtml:", s.panelHtml);
  if (t === 45) await page.screenshot({ path: "OR_ATOM_009/scripts/tmp/debug-mount2.png" });
}
console.log("THREE/R3F ASSETS:", chunks.length ? chunks.slice(0, 10) : "none loaded");
console.log("ERRS:", JSON.stringify(errs.slice(0, 10), null, 1));
await browser.close();
