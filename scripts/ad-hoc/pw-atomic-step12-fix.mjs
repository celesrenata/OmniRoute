#!/usr/bin/env node
/**
 * Step 12 fix round (directive 42) live checks on the REAL /home (Atomic mode, real fleet, real
 * call logs), headed Chrome on the real GPU.
 *   node scripts/ad-hoc/pw-atomic-step12-fix.mjs <outDir>
 * Env:
 *   MODE=moments  ATOM_ID=provider:kiro  MOMENTS=quiet,in-flight,completed  VIDEO=1
 *       replays the real recorded history and parks the playhead on each moment (stills + video).
 *   MODE=panels   loading cover (call-logs delayed by the script), collapsed / expanded transport
 *       bar in the card and in fullscreen, pairwise overlap checks, and a MOCKED capped history.
 *   MODE=windows  WINDOW_MIN=15|60  record count / injected counts vs raw call-log truth.
 *   TRAFFIC=1     first send real requests through the dev server's own /v1 (kiro 200, bedrock
 *       real 403 that takes ~30 s) so the last 5 minutes contain recorded traffic.
 *   BENCH_BASE (default http://localhost:20199)
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2] ?? "/tmp/step12-fix";
const base = process.env.BENCH_BASE ?? "http://localhost:20199";
const MODE = process.env.MODE ?? "moments";
const windowMin = Number(process.env.WINDOW_MIN ?? 5);
fs.mkdirSync(outDir, { recursive: true });

// ---- optional real traffic (the call-log DB is the truth the replay is compared with)
if (process.env.TRAFFIC) {
  const post = (model) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      }),
    }).then((r) => r.status);
  const bedrock = [
    post("bedrock/anthropic.claude-3-haiku"),
    post("bedrock/anthropic.claude-3-haiku"),
  ];
  const kiro = (async () => {
    const out = [];
    for (let i = 0; i < 3; i += 1) out.push(await post("kiro/claude-sonnet-4.5"));
    return out;
  })();
  console.log(
    "traffic:",
    JSON.stringify({ kiro: await kiro, bedrock: await Promise.all(bedrock) })
  );
}

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1700,1100",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  ...(process.env.VIDEO
    ? { recordVideo: { dir: outDir, size: { width: 1440, height: 900 } } }
    : {}),
});
const page = await ctx.newPage();
const pageStart = Date.now();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
const report = { mode: MODE, windowMin, errors, steps: {} };

const view = () => page.evaluate(() => window.__atomicReplay?.view());
const hostShot = (name) =>
  page
    .locator("[data-atomic-host]")
    .first()
    .screenshot({ path: path.join(outDir, `${name}.png`) });
const pageShot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);

async function overlapReport() {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
    };
    const items = {
      legend: rect(q("[data-atomic-legend]")),
      transportBar: rect(q("[data-atomic-replay-panel]")),
      detailPanel: rect(q("[data-atomic-detail]")),
      marker: rect(q("[data-atomic-replay-marker]")),
      controls: rect(q(".atomic-controls")),
      host: rect(q("[data-atomic-host]")),
    };
    const hit = (a, b) =>
      a && b && a.x < b.r - 0.5 && a.r > b.x + 0.5 && a.y < b.b - 0.5 && a.b > b.y + 0.5;
    const names = ["legend", "transportBar", "detailPanel", "marker", "controls"];
    const overlaps = [];
    for (let i = 0; i < names.length; i += 1)
      for (let j = i + 1; j < names.length; j += 1)
        if (hit(items[names[i]], items[names[j]])) overlaps.push(`${names[i]} x ${names[j]}`);
    const h = items.host;
    const bar = items.transportBar;
    return {
      items,
      overlaps,
      barHeightPct: bar && h ? Math.round((bar.h / h.h) * 1000) / 10 : null,
      barInsideHost: bar && h ? bar.x >= h.x && bar.r <= h.r && bar.b <= h.b : null,
      inset: q(".atomic-overlays")?.style.getPropertyValue("--atomic-replay-inset") ?? null,
    };
  });
}

async function momentState() {
  return page.evaluate(() => {
    const slider = document.querySelector('input[aria-label="Replay position"]');
    const chip = document.querySelector("[data-atomic-replay-moment]");
    const act = document.querySelector('[data-detail="activity"]');
    const v = window.__atomicReplay?.view();
    return {
      marker: document.querySelector("[data-atomic-replay-marker]")?.textContent ?? null,
      scrubberValue: slider ? Number(slider.value) : null,
      scrubberFraction: slider
        ? Math.round(
            ((Number(slider.value) - Number(slider.min)) /
              Math.max(1, Number(slider.max) - Number(slider.min))) *
              1000
          ) / 1000
        : null,
      scrubberText: slider?.getAttribute("aria-valuetext") ?? null,
      clock: document.querySelector("[data-atomic-replay-time]")?.textContent ?? null,
      momentChip: chip?.textContent ?? null,
      momentState: chip?.getAttribute("data-atomic-replay-moment") ?? null,
      detailActivity: act?.textContent ?? null,
      positionMs: v?.clock?.positionMs ?? null,
      chips: [...document.querySelectorAll(".atomic-labels [data-atom-id]")].map((e) => ({
        id: e.getAttribute("data-atom-id"),
        chip: e.querySelector(".atomic-labels__state")?.textContent ?? null,
      })),
    };
  });
}

async function openAtomicDetail(wantId) {
  await page.goto(`${base}/home`);
  const group = page.locator('[role="group"][aria-label="Topology view mode"]');
  await group.waitFor({ timeout: 120000 });
  await group.getByRole("button", { name: "Atomic" }).click();
  await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
  await page.waitForTimeout(7000);
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll(".atomic-labels [data-atom-id]")].map((e) =>
      e.getAttribute("data-atom-id")
    )
  );
  const atomId = ids.includes(wantId) ? wantId : ids.find((i) => i.startsWith("provider:"));
  report.atomId = atomId;
  await page.evaluate((i) => window.__atomicOpenDetail?.(i), atomId);
  await page.waitForTimeout(3500);
  return atomId;
}

async function waitReady() {
  for (let i = 0; i < 80; i += 1) {
    const v = await view();
    if (v?.phase === "ready" || v?.phase === "error") return v;
    await page.waitForTimeout(250);
  }
  return view();
}

async function rawTruth(v) {
  const since = new Date(v.clock.startMs).toISOString();
  const until = new Date(v.clock.endMs).toISOString();
  const raw = await page.evaluate(
    async ([s, u]) => {
      const out = [];
      for (let off = 0; off < 4000; off += 200) {
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
  const seen = new Set();
  const rows = raw.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const expected = {};
  const requests = [];
  for (const r of rows) {
    const p = r.provider;
    const start = Date.parse(r.timestamp);
    const failed = r.status >= 400 || Boolean(r.error);
    const ok = r.status >= 200 && r.status < 400;
    const c = (expected[p] ??= { started: 0, completed: 0, failed: 0 });
    let end = null;
    if (start >= v.clock.startMs && start <= v.clock.endMs) c.started += 1;
    if (!r.active && (failed || ok)) {
      end = start + (Number.isFinite(r.duration) ? r.duration : 0);
      if (end >= v.clock.startMs && end <= v.clock.endMs) c[failed ? "failed" : "completed"] += 1;
    }
    requests.push({
      provider: p,
      start,
      end,
      outcome: end == null ? null : failed ? "failed" : "ok",
    });
  }
  return { rows: rows.length, expected, requests };
}
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/* ---------------------------------------------------------------- moments */
if (MODE === "moments") {
  const atomId = await openAtomicDetail(process.env.ATOM_ID ?? "provider:kiro");
  const provider = atomId.replace(/^provider:/, "");
  await hostShot("00-detail-live");
  const liveDetailActivity = await text('[data-detail="activity"]');
  await page.locator("[data-atomic-replay-open]").click();
  const v0 = await waitReady();
  const truth = await rawTruth(v0);
  // The provider's own replayed state at t, by the same rules as scene/replaySnapshot.ts
  // (failure in the 4 s hold wins, then in flight, then a success in the hold, else quiet).
  const HOLD = 4000;
  const reqs = truth.requests.filter((r) => r.provider === provider);
  const provState = (t) => {
    let inFlight = 0;
    let failed = false;
    let ok = false;
    for (const r of reqs) {
      if (r.start > t) continue;
      const ended = r.end != null && r.end <= t;
      if (!ended && r.end !== r.start) inFlight += 1;
      if (ended && t - r.end < HOLD) {
        if (r.outcome === "failed") failed = true;
        else if (r.outcome === "ok") ok = true;
      }
    }
    return failed ? "failed" : inFlight > 0 ? "in-flight" : ok ? "completed" : "quiet";
  };
  // Longest contiguous run of each state (250 ms scan); park the playhead in its middle.
  const runs = { quiet: [], "in-flight": [], completed: [], failed: [] };
  let cur = null;
  for (let t = v0.clock.startMs; t <= v0.clock.endMs; t += 250) {
    const st = provState(t);
    if (cur && cur.st === st) cur.to = t;
    else {
      cur = { st, from: t, to: t };
      runs[st].push(cur);
    }
  }
  const at = {};
  for (const [st, rs] of Object.entries(runs)) {
    const best = rs.sort((x, y) => y.to - y.from - (x.to - x.from))[0];
    at[st] = best ? Math.round((best.from + best.to) / 2) : null;
  }
  report.chosenRuns = Object.fromEntries(
    Object.entries(runs).map(([k, rs]) => [
      k,
      rs.length ? Math.max(...rs.map((r) => r.to - r.from)) : null,
    ])
  );
  report.liveDetailActivity = liveDetailActivity;
  report.window = { startMs: v0.clock.startMs, endMs: v0.clock.endMs, rows: truth.rows };
  // Visit the moments in recorded-time order so the scrubber sweeps forward through the video.
  const wanted = (process.env.MOMENTS ?? "quiet,in-flight,completed")
    .split(",")
    .sort((x, y) => (at[x] ?? Infinity) - (at[y] ?? Infinity));
  report.videoOffsetSec = Math.round(((Date.now() - pageStart) / 1000 - 0.5) * 10) / 10;
  report.moments = [];
  // Opening state: the replay (collapsed bar) before any seeking.
  await page.waitForTimeout(1500);
  for (const name of wanted) {
    const t = at[name];
    if (t == null) {
      report.moments.push({ name, skipped: "no matching recorded request for this provider" });
      continue;
    }
    await page.evaluate((p) => window.__atomicReplay.seek(p), t);
    await page.waitForTimeout(450);
    await hostShot(`moment-${name}-early`);
    await page.waitForTimeout(1350);
    await hostShot(`moment-${name}`);
    report.moments.push({ name, at: t, state: await momentState() });
    await page.waitForTimeout(1300);
  }
  report.videoDurationSec =
    Math.round(((Date.now() - pageStart) / 1000 - report.videoOffsetSec) * 10) / 10;
  report.overlap = await overlapReport();
}

/* ----------------------------------------------------------------- panels */
if (MODE === "panels") {
  const atomId = await openAtomicDetail(process.env.ATOM_ID ?? "provider:kiro");
  // Loading: delay the history request so the neutral cover can be captured deterministically.
  await page.route("**/api/usage/call-logs**", async (route) => {
    await new Promise((r) => setTimeout(r, 3500));
    await route.continue().catch(() => {});
  });
  await page.locator("[data-atomic-replay-open]").click();
  await page.waitForTimeout(1200);
  const cover = await page.evaluate(() => {
    const c = document.querySelector("[data-atomic-replay-cover]");
    return c
      ? {
          phase: c.getAttribute("data-atomic-replay-cover"),
          text: c.textContent,
          bg: getComputedStyle(c).backgroundColor,
        }
      : null;
  });
  // Is the cover really opaque over the canvas centre? Sample the topmost element there.
  const topAtCentre = await page.evaluate(() => {
    const h = document.querySelector("[data-atomic-host]").getBoundingClientRect();
    const el = document.elementFromPoint(h.x + h.width * 0.5, h.y + h.height * 0.5);
    return el?.getAttribute("data-atomic-replay-cover") ?? el?.tagName ?? null;
  });
  await hostShot("10-loading-cover");
  report.steps.loading = { cover, topAtCentre, marker: await text("[data-atomic-replay-marker]") };
  await waitReady();
  await page.unroute("**/api/usage/call-logs**");
  await page.waitForTimeout(1500);
  report.steps.coverGoneWhenReady =
    (await page.locator("[data-atomic-replay-cover]").count()) === 0;
  // Collapsed (default) and expanded transport bar in the card.
  const v = await view();
  const mid = v.clock.startMs + (v.clock.endMs - v.clock.startMs) * 0.5;
  await page.evaluate((p) => window.__atomicReplay.seek(p), mid);
  await page.waitForTimeout(1500);
  await hostShot("11-card-collapsed");
  await pageShot("11-card-collapsed-page");
  report.steps.cardCollapsed = await overlapReport();
  await page.getByRole("button", { name: "Expand replay options" }).click();
  await page.waitForTimeout(800);
  await hostShot("12-card-expanded");
  report.steps.cardExpanded = await overlapReport();
  await page.getByRole("button", { name: "Collapse replay options" }).click();
  // Keyboard: Tab order reaches the bar controls; Space / Enter work on the toggle.
  await page.getByRole("button", { name: "Expand replay options" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  report.steps.keyboardToggleExpanded =
    (await page.locator('[data-atomic-replay-panel][data-expanded="true"]').count()) === 1;
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  report.steps.keyboardToggleCollapsed =
    (await page.locator('[data-atomic-replay-panel][data-expanded="false"]').count()) === 1;
  // Fullscreen.
  await page.bringToFront();
  await page.mouse.click(1000, 40);
  await page.locator('[data-atomic-control="fullscreen"]').click();
  await page.waitForTimeout(2500);
  report.steps.fullscreenActive = await page.evaluate(() => Boolean(document.fullscreenElement));
  await page.waitForTimeout(1200);
  await pageShot("13-fullscreen-collapsed");
  report.steps.fullscreenCollapsed = await overlapReport();
  await page.getByRole("button", { name: "Expand replay options" }).click();
  await page.waitForTimeout(800);
  await pageShot("14-fullscreen-expanded");
  report.steps.fullscreenExpanded = await overlapReport();
  await page.getByRole("button", { name: "Collapse replay options" }).click();
  await page.locator('[data-atomic-control="fullscreen"]').click();
  await page.waitForTimeout(1500);
  // Mocked capped history: the live DB is far below the 2000-row cap, so the capped UI is shown
  // against a SYNTHETIC response (explicitly a mock, not real data).
  await page.route("**/api/usage/call-logs**", async (route) => {
    const u = new URL(route.request().url());
    if (!u.searchParams.get("since")) return route.continue().catch(() => {});
    const off = Number(u.searchParams.get("offset") ?? 0);
    const since = Date.parse(u.searchParams.get("since"));
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: `mock-${off + i}`,
      timestamp: new Date(since + 1000 + (off + i) * 120).toISOString(),
      provider: "kiro",
      model: "mock-model",
      status: 200,
      duration: 400,
    }));
    await route.fulfill({ json: rows }).catch(() => {});
  });
  await page.getByRole("button", { name: "Expand replay options" }).click();
  await page.selectOption('select[aria-label="Replay window"]', String(60 * 60_000));
  const vm = await waitReady();
  await page.waitForTimeout(800);
  await hostShot("15-mock-capped");
  report.steps.mockCapped = {
    note: "SYNTHETIC responses (page.route), 10 full pages of 200 rows; shows the capped path only",
    truncated: vm.truncated,
    rowCount: vm.rowCount,
    recordCount: vm.recordCount,
    badge: await page.locator("[data-atomic-replay-truncated]").count(),
    status: await text("[data-atomic-replay-status]"),
  };
  await page.unroute("**/api/usage/call-logs**");
  await page.getByRole("button", { name: "Exit replay and return to live" }).click();
  await page.waitForTimeout(1500);
  report.steps.exited = {
    marker: await text("[data-atomic-replay-marker]"),
    inset: await page.evaluate(
      () =>
        document
          .querySelector(".atomic-overlays")
          ?.style.getPropertyValue("--atomic-replay-inset") ?? ""
    ),
  };
}

/* ---------------------------------------------------------------- windows */
if (MODE === "windows") {
  const atomId = await openAtomicDetail(process.env.ATOM_ID ?? "provider:kiro");
  await page.locator("[data-atomic-replay-open]").click();
  await waitReady();
  await page.getByRole("button", { name: "Expand replay options" }).click();
  await page.selectOption('select[aria-label="Replay window"]', String(windowMin * 60_000));
  const t0 = Date.now();
  const v0 = await waitReady();
  report.loadMs = Date.now() - t0;
  await page.waitForTimeout(1200);
  await hostShot(`20-window-${windowMin}min-opened`);
  const truth = await rawTruth(v0);
  // Real Play at 16x for a few seconds, then the same clock path in large ticks to the end.
  await page.getByRole("button", { name: "Speed 16x" }).click();
  await page.getByRole("button", { name: "Play replay" }).click();
  await page.waitForTimeout(4000);
  await page.evaluate(async () => {
    const r = window.__atomicReplay;
    for (let i = 0; i < 2000 && r.view().clock.playing; i += 1) r.tick(250);
  });
  const vEnd = await view();
  const injected = await page.evaluate(() => window.__atomicReplay.injected());
  const tl = await page.evaluate(() => window.__atomicReplay.timeline());
  report.windowResult = {
    windowMin,
    phase: v0.phase,
    rows: v0.rowCount,
    records: v0.recordCount,
    truncated: v0.truncated,
    truncationHit: v0.truncated,
    rowCap: 2000,
    rawRowsFromApi: truth.rows,
    expectedFromCallLogs: truth.expected,
    injected,
    timelineCounts: tl.counts,
    injectedEqualsCallLogs:
      JSON.stringify(sortObj(injected)) === JSON.stringify(sortObj(truth.expected)),
    timelineEqualsCallLogs:
      JSON.stringify(sortObj(tl.counts)) === JSON.stringify(sortObj(truth.expected)),
    stoppedAtEnd: !vEnd.clock.playing && vEnd.clock.positionMs === vEnd.clock.endMs,
    status: await text("[data-atomic-replay-status]"),
  };
  // A few notable moments inside the window (longest recorded failure and success).
  const longest = (o) =>
    truth.requests
      .filter((r) => r.outcome === o && r.end > r.start)
      .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  report.windowMoments = [];
  for (const [name, r, off] of [
    ["failure", longest("failed"), 300],
    ["success", longest("ok"), 300],
  ]) {
    if (!r) continue;
    await page.evaluate((p) => window.__atomicReplay.seek(p), r.end + off);
    await page.waitForTimeout(1800);
    await hostShot(`21-window-${windowMin}min-${name}`);
    report.windowMoments.push({ name, request: r, state: await momentState() });
  }
}

report.errorsAfter = errors.filter((e) => !/FORBIDDEN_ORIGIN|WebSocket|ws:\/\//i.test(e));
fs.writeFileSync(
  path.join(outDir, `step12-fix-${MODE}${MODE === "windows" ? windowMin : ""}.json`),
  JSON.stringify(report, null, 2)
);
console.log(JSON.stringify(report, null, 2));
const video = page.video();
await ctx.close();
if (video) {
  const name = `step12-fix-${MODE}-${(report.atomId ?? "x").replace(/\W/g, "_")}.webm`;
  fs.renameSync(await video.path(), path.join(outDir, name));
}
await browser.close();
