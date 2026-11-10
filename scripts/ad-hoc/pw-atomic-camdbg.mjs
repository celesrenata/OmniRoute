import { chromium } from "playwright";
const b = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist"],
});
for (const [base, label] of [[process.env.BASE ?? "http://localhost:20199", "new"]]) {
  for (const q of [
    "atoms=20&paused=1",
    "atoms=20&paused=1&node=provider:bench-primary",
    "atoms=20&paused=1&node=provider:bench-primary&clamp=0",
  ]) {
    const ctx = await b.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/dev/atomic-bench?${q}`);
    await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
    await page.waitForTimeout(4000);
    console.log(label, q, JSON.stringify(await page.evaluate(() => window.__atomicCamDbg)));
    await ctx.close();
  }
}
await b.close();
