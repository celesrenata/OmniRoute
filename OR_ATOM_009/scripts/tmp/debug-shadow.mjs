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
const out = await page.evaluate(() => {
  const findIn = (root, acc) => {
    const els = root.querySelectorAll("*");
    for (const el of els) {
      if (el.tagName === "CANVAS") acc.push(el.outerHTML.slice(0, 120));
      if (el.shadowRoot) findIn(el.shadowRoot, acc);
    }
  };
  const canvases = [];
  findIn(document, canvases);
  // topology card subtree
  const card = [...document.querySelectorAll("section, div")].find(
    (el) => /Provider Topology/.test(el.textContent) && el.querySelector("canvas, svg")
  );
  return {
    shadowCanvases: canvases,
    totalCanvasesInShadowToo: canvases.length,
    cardFound: !!card,
    cardSnippet: card ? card.innerHTML.slice(0, 600) : null,
    iframes: document.querySelectorAll("iframe").length,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
