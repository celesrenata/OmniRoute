import { chromium } from "playwright";
const b = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
    "--window-size=1700,1100",
  ],
});
async function run(base) {
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${base}/dev/atomic-bench?atoms=32&paused=0`);
  await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
  await page.waitForTimeout(2500);
  await page.mouse.move(800, 500);
  for (let i = 0; i < 7; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(1500);
  const r = await page.evaluate(
    () =>
      new Promise((res) => {
        const d = [];
        let last = performance.now();
        const end = last + 5000;
        const t = (n) => {
          d.push(n - last);
          last = n;
          if (n < end) requestAnimationFrame(t);
          else {
            d.sort((a, b) => a - b);
            const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
            res({
              fps: +(d.length / 5).toFixed(1),
              p50: +q(0.5).toFixed(1),
              p95: +q(0.95).toFixed(1),
            });
          }
        };
        requestAnimationFrame(t);
      })
  );
  await ctx.close();
  return r;
}
for (let i = 0; i < 3; i++) {
  for (const [n, u] of [
    ["before(9805665e6)", "http://localhost:20198"],
    ["now", "http://localhost:20199"],
  ])
    console.log(n, JSON.stringify(await run(u)));
}
await b.close();
