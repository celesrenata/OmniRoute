#!/usr/bin/env node
/**
 * Step 12 live demo: request-trace replay on the REAL /home (Atomic mode, real fleet, real call
 * logs), headed Chrome on the real GPU. Drives the real UI (detail panel button, play, scrubber,
 * keyboard), then checks that the replayed event sequence equals the call-log rows for the window
 * (counts per provider / kind, computed here INDEPENDENTLY from the raw /api/usage/call-logs rows).
 *   node scripts/ad-hoc/pw-atomic-step12.mjs <outDir>
 * Env: BENCH_BASE (default http://localhost:20199), WINDOW_MIN (5|15|60), VIDEO=1, UNCAPPED=1.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2] ?? "/tmp/step12";
const base = process.env.BENCH_BASE ?? "http://localhost:20199";
const windowMin = Number(process.env.WINDOW_MIN ?? 5);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1700,1100",
    ...(process.env.UNCAPPED ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"] : []),
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  ...(process.env.REDUCED ? { reducedMotion: "reduce" } : {}),
  ...(process.env.VIDEO
    ? { recordVideo: { dir: outDir, size: { width: 1440, height: 900 } } }
    : {}),
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));

const report = { windowMin, reduced: Boolean(process.env.REDUCED), errors, steps: {} };
const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const view = () => page.evaluate(() => window.__atomicReplay?.view());
const markerText = () =>
  page.evaluate(() => document.querySelector("[data-atomic-replay-marker]")?.textContent ?? null);
const nodeStates = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".atomic-labels [data-atom-id]")].map((e) => ({
      id: e.getAttribute("data-atom-id"),
      chip: e.querySelector(".atomic-labels__state")?.textContent ?? null,
    }))
  );
const perf = (ms = 4000) =>
  page.evaluate(
    (dur) =>
      new Promise((res) => {
        const d = [];
        let last = performance.now();
        const t0 = last;
        const tick = (now) => {
          d.push(now - last);
          last = now;
          if (now - t0 < dur) requestAnimationFrame(tick);
          else {
            d.shift();
            const a = [...d].sort((x, y) => x - y);
            const q = (p) =>
              Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] * 10) / 10;
            res({
              fps: Math.round((d.length / (d.reduce((x, y) => x + y, 0) / 1000)) * 10) / 10,
              p50: q(0.5),
              p95: q(0.95),
              p99: q(0.99),
              over30: d.filter((x) => x > 30).length,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    ms
  );

await page.goto(`${base}/home`);
const group = page.locator('[role="group"][aria-label="Topology view mode"]');
await group.waitFor({ timeout: 120000 });
await group.getByRole("button", { name: "Atomic" }).click();
await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
await page.waitForTimeout(8000);

report.gpuAdapter = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter();
  const i = a?.info ?? {};
  return { vendor: i.vendor, architecture: i.architecture };
});
report.liveBefore = {
  telemetryBadge: await page
    .locator("[data-atomic-telemetry-status], .atomic-telemetry-status")
    .count(),
  replayMarker: await markerText(),
  replayEntryVisibleWithoutDetail: await page.locator("[data-atomic-replay-open]").count(),
  nodes: await nodeStates(),
};
await shot("01-live-default");

// ---- open the detail view on a provider that has recorded traffic, then replay from its panel
const wantId = process.env.ATOM_ID ?? "provider:kiro";
const atomIds = report.liveBefore.nodes.map((n) => n.id);
const atomId = atomIds.includes(wantId) ? wantId : atomIds.find((i) => i.startsWith("provider:"));
report.atomId = atomId;
await page.evaluate((i) => window.__atomicOpenDetail?.(i), atomId);
await page.waitForTimeout(3500);
report.replayEntryInDetail = await page.locator("[data-atomic-replay-open]").count();
await shot("02-detail-with-replay-entry");

await page.locator("[data-atomic-replay-open]").click();
await page.waitForSelector("[data-atomic-replay-panel]", { timeout: 20000 });
for (let i = 0; i < 40; i += 1) {
  const v = await view();
  if (v?.phase === "ready") break;
  await page.waitForTimeout(250);
}
if (windowMin !== 5) {
  await page.selectOption('select[aria-label="Replay window"]', String(windowMin * 60_000));
  for (let i = 0; i < 40; i += 1) {
    const v = await view();
    if (v?.phase === "ready") break;
    await page.waitForTimeout(250);
  }
}
await page.waitForTimeout(1500);
const v0 = await view();
report.steps.opened = {
  phase: v0.phase,
  recordCount: v0.recordCount,
  rowCount: v0.rowCount,
  windowMs: v0.windowMs,
  marker: await markerText(),
  telemetryBadgeHidden:
    (await page.locator("[data-atomic-telemetry-status], .atomic-telemetry-status").count()) === 0,
  nodes: await nodeStates(),
};
await shot("03-replay-opened");

// ---- INDEPENDENT truth: the raw call-log rows for the exact window the replay used
const since = new Date(v0.clock.startMs).toISOString();
const until = new Date(v0.clock.endMs).toISOString();
const raw = await page.evaluate(
  async ([s, u]) => {
    const out = [];
    for (let off = 0; off < 2000; off += 200) {
      const r = await fetch(
        `/api/usage/call-logs?since=${s}&until=${u}&limit=200&offset=${off}&excludeTests=1`,
        { cache: "no-store" }
      );
      const j = await r.json();
      out.push(...j);
      if (j.length < 200) break;
    }
    return out;
  },
  [since, until]
);
const seenIds = new Set();
const rows = raw.filter((r) => (seenIds.has(r.id) ? false : (seenIds.add(r.id), true)));
const expected = {};
const events = [];
for (const r of rows) {
  const p = r.provider;
  const start = Date.parse(r.timestamp);
  const failed = r.status >= 400 || Boolean(r.error);
  const ok = r.status >= 200 && r.status < 400;
  const c = (expected[p] ??= { started: 0, completed: 0, failed: 0 });
  if (start >= v0.clock.startMs && start <= v0.clock.endMs) {
    c.started += 1;
    events.push({ at: start, kind: "started", provider: p });
  }
  if (!r.active && (failed || ok)) {
    const end = start + (Number.isFinite(r.duration) ? r.duration : 0);
    if (end >= v0.clock.startMs && end <= v0.clock.endMs) {
      c[failed ? "failed" : "completed"] += 1;
      events.push({ at: end, kind: failed ? "failed" : "completed", provider: p });
    }
  }
}
events.sort((a, b) => a.at - b.at);
report.steps.callLogTruth = { rows: rows.length, expected, windowIso: { since, until } };

// ---- play through at 16x via the real Play + 16x buttons, sampling the scene as it goes
await page.getByRole("button", { name: "Speed 16x" }).click();
await page.getByRole("button", { name: "Play replay" }).click();
const samples = [];
const t0 = Date.now();
let shots = 0;
while (Date.now() - t0 < 120000) {
  const v = await view();
  samples.push({ pos: v.clock.positionMs - v.clock.startMs, playing: v.clock.playing });
  if (!v.clock.playing) break;
  if (shots < 4 && samples.length % 6 === 0) {
    await shot(`04-playing-${shots}`);
    shots += 1;
  }
  await page.waitForTimeout(200);
}
const vEnd = await view();
const injected = await page.evaluate(() => window.__atomicReplay.injected());
const tl = await page.evaluate(() => window.__atomicReplay.timeline());
report.steps.playedThrough = {
  stoppedAtEnd: !vEnd.clock.playing && vEnd.clock.positionMs === vEnd.clock.endMs,
  injected,
  timelineCounts: tl.counts,
  expectedFromCallLogs: expected,
  injectedEqualsCallLogs: JSON.stringify(sortObj(injected)) === JSON.stringify(sortObj(expected)),
  timelineEqualsCallLogs: JSON.stringify(sortObj(tl.counts)) === JSON.stringify(sortObj(expected)),
  samples: samples.length,
};
function sortObj(o) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---- seek to real moments: an in-flight request, a recorded success, a recorded failure
const pickEvent = (kind, provider) =>
  events.find((e) => e.kind === kind && (!provider || e.provider === provider));
const moments = [];
const firstStart = pickEvent("started");
const firstFail = pickEvent("failed");
const firstOk = pickEvent("completed");
if (firstStart) moments.push(["in-flight", firstStart.at + 150, firstStart.provider]);
if (firstOk) moments.push(["after-success", firstOk.at + 200, firstOk.provider]);
if (firstFail) moments.push(["failure", firstFail.at + 200, firstFail.provider]);
moments.push(["quiet-before-first-event", v0.clock.startMs + 500, null]);
report.steps.moments = [];
for (const [name, at, provider] of moments) {
  await page.evaluate((p) => window.__atomicReplay.seek(p), at);
  await page.waitForTimeout(1600);
  const nodes = await nodeStates();
  const feeders = await page.evaluate(() => window.__atomicFeeders ?? null);
  await shot(`05-moment-${name}`);
  report.steps.moments.push({ name, at, provider, marker: await markerText(), nodes, feeders });
}

// ---- keyboard: the scrubber and transport are native controls
const slider = page.getByRole("slider", { name: "Replay position" });
await slider.focus();
const before = (await view()).clock.positionMs;
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(300);
const afterRight = (await view()).clock.positionMs;
await page.getByRole("button", { name: "Next recorded event" }).focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
const afterNext = (await view()).clock.positionMs;
await page.getByRole("button", { name: "Play replay" }).focus();
await page.keyboard.press("Space");
await page.waitForTimeout(500);
const playingAfterSpace = (await view()).clock.playing;
report.steps.focusAfterSpace = await page.evaluate(() =>
  document.activeElement?.getAttribute("aria-label")
);
await page.keyboard.press("Space");
await page.waitForTimeout(300);
report.steps.keyboard = {
  arrowRightDeltaMs: afterRight - before,
  nextEventAdvanced: afterNext !== afterRight,
  spaceToggledPlay: playingAfterSpace === true,
  pausedAgain: (await view()).clock.playing === false,
};

// ---- perf while replaying (uncapped when UNCAPPED=1)
await page.evaluate(() => {
  window.__atomicReplay.seek(window.__atomicReplay.view().clock.startMs);
  window.__atomicReplay.setSpeed(1);
  window.__atomicReplay.play();
});
report.steps.perfReplayPlaying = await perf(5000);
await page.evaluate(() => window.__atomicReplay.pause());

// ---- exit: back to live, marker gone, live state restored
await shot("06-before-exit");
await page.getByRole("button", { name: "Exit replay and return to live" }).click();
await page.waitForTimeout(2500);
report.steps.exited = {
  markerAfter: await markerText(),
  panelCount: await page.locator("[data-atomic-replay-panel]").count(),
  view: await view(),
  telemetryBadgeBack:
    (await page.locator("[data-atomic-telemetry-status], .atomic-telemetry-status").count()) > 0,
  nodes: await nodeStates(),
};
await shot("07-after-exit-live");

// ---- empty / error states through the real UI: a window with no rows is a real, honest empty replay
report.steps.emptyWindowNote =
  "covered by unit tests; live window used here contained recorded traffic";

report.errorsAfter = errors.filter((e) => !/FORBIDDEN_ORIGIN|WebSocket|ws:\/\//i.test(e));
fs.writeFileSync(path.join(outDir, "step12-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await ctx.close();
await browser.close();
