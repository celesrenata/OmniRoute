#!/usr/bin/env node
/**
 * atomic-telemetry-soak.mjs — S6 live-telemetry soak for the fleet gateway.
 *
 * WHAT IT DOES
 *   Polls `GET /api/telemetry/fleet` (src/app/api/telemetry/fleet/route.ts)
 *   at the matrix-documented cadence for a fixed duration (default 15 min)
 *   and records, per poll: HTTP status, latency, response size, the
 *   reconciliation node counts, health-freshness / TTL conformance, and any
 *   warnings the soak derives from the response.
 *
 *   Endpoint contract (every field traced, none invented):
 *     - Route: `export const dynamic = "force-dynamic"` — no Next cache
 *       (src/app/api/telemetry/fleet/route.ts:38).
 *     - Success body: `NextResponse.json({ snapshot, reconciliation })`
 *       (route.ts:56). `snapshot` is the merged FleetTelemetrySnapshot
 *       { schemaVersion: 1, capturedAt, resources[] }
 *       (src/shared/topology/telemetry/types.ts). `reconciliation` is the
 *       ReconciliationResult { schemaVersion, capturedAt, gpuNodes,
 *       runtimeNodes, providerNodes, edges, providerCentricFallback }
 *       (src/shared/topology/telemetry/reconcile.ts).
 *     - Error body: `buildErrorBody(status, message)` → `{ error: {
 *       message, type, code, ... } }` (route.ts:48,60,66,72;
 *       open-sse/utils/error.ts). Statuses: 400 bad query, 408 aborted,
 *       503 backend unavailable, plus management-auth statuses (401/403)
 *       from requireManagementAuth (route.ts:41-42).
 *     - Polling cadence: the shipped UI poller defaults to 3500 ms —
 *       "UI cadence in ms. Default 3500 (the task's 2–5 s band)"
 *       (src/shared/topology/telemetry/fleetTelemetryPoller.ts:87,96) — and
 *       the matrix documents the endpoint's freshness semantics rather than
 *       a fixed UI rate: gateway cache TTL 10 s / LRU 16
 *       (src/shared/topology/telemetry/gateway.ts:34-35), per-field
 *       staleness "age > 3 × windowMs → stale: true"
 *       (src/shared/topology/telemetry/mergeSnapshots.ts:21,87;
 *       docs/specs/atomic-topology-telemetry-matrix.md §4, `GET
 *       /api/telemetry/fleet` row). This soak uses 3500 ms by default.
 *     - Query params (all optional): `windowMs` (default 300000 = 5 min,
 *       bounds [1, 777600000]) and `providers`/`hosts`/`gpus` lists
 *       (src/shared/topology/telemetry/httpQuery.ts:28,31;
 *       src/shared/topology/telemetry/provenance.ts:50-51).
 *     - Response "warnings": the body carries NO warnings array — gateway
 *       provider warnings are server-side only
 *       (src/shared/topology/telemetry/gateway.ts:86, onWarning sink at
 *       :78-80). The `warnings` column below is therefore always SOAK-DERIVED
 *       (derived checks on the body), never claimed as a response field.
 *
 *   Freshness / TTL conformance checks per poll:
 *     - `freshCapturedAt`: snapshot.capturedAt age <= 10 s gateway cache
 *       TTL (gateway.ts:34).
 *     - Per-resource Observed fields (types.ts `Observed<T>`:
 *       value/source/sampledAt/windowMs/stale): where the field carries
 *       `windowMs` and `sampledAt`, expected stale = age(sampledAt) >
 *       3 × windowMs (mergeSnapshots.ts:87); conformance counts
 *       expected===actual across all such fields.
 *     - Reconciliation node `stale` flags are recorded (ReconciledGpuNode
 *       etc. carry `stale: boolean`, reconcile.ts).
 *
 * USAGE
 *   node scripts/ad-hoc/atomic-telemetry-soak.mjs [flags]
 *
 *   Flags:
 *     --minutes N          soak duration in minutes (default: 15)
 *     --interval-ms N      poll interval ms (default: 3500 — the shipped
 *                          poller default, fleetTelemetryPoller.ts:96)
 *     --window-ms N        observation window query param (default: the
 *                          endpoint default 300000, httpQuery.ts:28)
 *     --out DIR            output root (default: <repo>/_cache/atomic-soak)
 *     --help               show this header
 *
 *   Env (URLs/tokens ONLY from env — never read from repo files, never
 *   printed):
 *     OMNIROUTE_FLEET_METRICS_URL      full endpoint URL (default:
 *                          $OMNIROUTE_DASH_URL/api/telemetry/fleet,
 *                          base default http://localhost:20128)
 *     OMNIROUTE_DASH_URL               dashboard base when the URL above
 *                          is not set (default http://localhost:20128)
 *     OMNIROUTE_FLEET_METRICS_TOKEN   management credential (management
 *                          API key, oma_ access token, or CLI token)
 *     OMNIROUTE_FLEET_METRICS_TOKEN_HEADER
 *                          header to send the token in: "authorization"
 *                          (sent as `Bearer <token>`), "x-api-key", or any
 *                          raw header name (default: "authorization")
 *     OMNIROUTE_SOAK_MINUTES           same as --minutes
 *     OMNIROUTE_SOAK_INTERVAL_MS       same as --interval-ms
 *     OMNIROUTE_SOAK_OUT_DIR           same as --out
 *
 *   Output (private gitignored root — `_cache/` per .gitignore):
 *     <out>/<YYYYMMDD-HHMMSS>/soak.json     aggregate report (per-poll rows
 *                                          + conformance summary + verdict)
 *     <out>/<YYYYMMDD-HHMMSS>/soak-polls.csv
 *      columns: seq,t_epoch_ms,ok,http_status,latency_ms,response_bytes,
 *               gpu_nodes,runtime_nodes,provider_nodes,resources,
 *               fresh_captured_at,stale_checked,stale_conform,warnings
 *
 * EXIT CODES
 *   0  soak completed; at least one successful poll (report written even
 *      when some polls failed — failures are counted in the report)
 *   1  invalid arguments
 *   2  EXTERNAL BLOCKER: no reachable fleet backend — the endpoint
 *      answered 404, timed out, or was unreachable on the initial probe
 *      (documented expected outcome while no fleet backend is running;
 *      no soak data is reported in that case)
 *   3  endpoint reachable on probe but EVERY soak poll failed (backend
 *      died mid-run) — verdict recorded in the report
 *
 * HONESTY CONTRACT: the script never fabricates counts — every number in
 * the reports is read from a response body that was actually received.
 * Live verification is currently a documented EXTERNAL BLOCKER (no
 * reachable fleet backend; the local process at 127.0.0.1:20128 predates
 * the fleet route and returns 404 for /api/telemetry/fleet).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DASH_BASE = process.env.OMNIROUTE_DASH_URL || "http://localhost:20128";
const DEFAULT_ENDPOINT =
  process.env.OMNIROUTE_FLEET_METRICS_URL || join(DASH_BASE, "/api/telemetry/fleet");
const DEFAULT_INTERVAL_MS = 3_500; // fleetTelemetryPoller.ts:96 (2–5 s band)
const DEFAULT_WINDOW_MS = 300_000; // httpQuery.ts:28 (5 min)
const DEFAULT_MINUTES = 15;
const GATEWAY_CACHE_TTL_MS = 10_000; // gateway.ts:34 — freshness ceiling
const STALE_FACTOR = 3; // mergeSnapshots.ts:21 — age > 3 × windowMs → stale

const REPO_ROOT = dirname(dirname(dirname(process.argv[1] ?? ".")));
const OUT_ROOT = process.env.OMNIROUTE_SOAK_OUT_DIR || join(REPO_ROOT, "_cache", "atomic-soak");

const BLOCKER_VERDICT = "EXTERNAL BLOCKER: no reachable fleet backend";

function fail(code, verdict, detail = "") {
  console.error(`[soak] EXIT ${code}: ${verdict}`);
  if (detail) console.error(`[soak]   ${detail}`);
  process.exit(code);
}

// Log the endpoint WITHOUT credentials: origin + pathname only, query
// params and any embedded userinfo are dropped.
function redactedEndpoint(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<unparseable URL>";
  }
}

function parseArgs(argv) {
  const a = {
    minutes: Number(process.env.OMNIROUTE_SOAK_MINUTES || DEFAULT_MINUTES),
    intervalMs: Number(process.env.OMNIROUTE_SOAK_INTERVAL_MS || DEFAULT_INTERVAL_MS),
    windowMs: DEFAULT_WINDOW_MS,
    out: process.env.OMNIROUTE_SOAK_OUT_DIR || OUT_ROOT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log("see the usage header block at the top of this file");
      process.exit(0);
    } else if (arg === "--minutes") {
      a.minutes = Number(argv[++i]);
    } else if (arg === "--interval-ms") {
      a.intervalMs = Number(argv[++i]);
    } else if (arg === "--window-ms") {
      a.windowMs = Number(argv[++i]);
    } else if (arg === "--out") {
      a.out = argv[++i];
    } else {
      fail(1, `unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(a.minutes) || a.minutes <= 0) fail(1, "invalid --minutes");
  if (!Number.isFinite(a.intervalMs) || a.intervalMs < 100)
    fail(1, "invalid --interval-ms (must be >= 100 ms)");
  if (!Number.isInteger(a.windowMs) || a.windowMs < 1 || a.windowMs > 777_600_000)
    fail(1, "invalid --window-ms (endpoint bounds 1..777600000, provenance.ts:50-51)");
  return a;
}

// ---------------------------------------------------------------------------
// Auth headers (env-only; token never logged)
// ---------------------------------------------------------------------------

function buildAuthHeaders() {
  const token = process.env.OMNIROUTE_FLEET_METRICS_TOKEN || "";
  if (!token) return {};
  const header = (
    process.env.OMNIROUTE_FLEET_METRICS_TOKEN_HEADER || "authorization"
  ).toLowerCase();
  if (header === "authorization" || header === "bearer") {
    return { authorization: `Bearer ${token}` };
  }
  // x-api-key, x-omniroute-cli-token, or any raw header name: value as-is.
  return { [header]: token };
}

// ---------------------------------------------------------------------------
// One poll
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * One GET. Returns a row of RAW facts only — every value is read from the
 * received body (or `null` when the body did not carry it). Throws on
 * network failure / timeout so callers can distinguish unreachable from
 * HTTP-level failures.
 */
async function pollOnce(endpoint, windowMs, headers) {
  const url = `${endpoint}${endpoint.includes("?") ? "&" : "?"}windowMs=${windowMs}`;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (err) {
    const latency = Date.now() - t0;
    const timedOut = err && (err.name === "TimeoutError" || /abort|timeout/i.test(String(err)));
    throw { kind: timedOut ? "timeout" : "unreachable", latency, err };
  }
  const latency = Date.now() - t0;
  const text = await res.text().catch(() => "");
  const row = {
    ok: res.ok,
    httpStatus: res.status,
    latencyMs: latency,
    responseBytes: Buffer.byteLength(text, "utf8"),
    gpuNodes: null,
    runtimeNodes: null,
    providerNodes: null,
    resources: null,
    freshCapturedAt: null,
    staleChecked: 0,
    staleConform: 0,
    warnings: [],
  };

  if (!res.ok || !text) {
    if (res.status === 404) row.warnings.push("404-not-found");
    else if (res.status === 401 || res.status === 403)
      row.warnings.push(`auth-rejected:${res.status}`);
    else row.warnings.push(`http-${res.status}`);
    return row;
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    row.warnings.push("body-not-json");
    return row;
  }

  const snapshot = body && typeof body.snapshot === "object" ? body.snapshot : null;
  const recon = body && typeof body.reconciliation === "object" ? body.reconciliation : null;
  if (!snapshot) row.warnings.push("missing-snapshot-block");
  if (!recon) row.warnings.push("missing-reconciliation-block");

  if (snapshot) {
    row.resources = Array.isArray(snapshot.resources) ? snapshot.resources.length : null;
    // Freshness ceiling: the merged snapshot should be no older than the
    // 10 s gateway cache TTL (gateway.ts:34).
    if (typeof snapshot.capturedAt === "number") {
      row.freshCapturedAt = Date.now() - snapshot.capturedAt <= GATEWAY_CACHE_TTL_MS;
    } else {
      row.warnings.push("snapshot-capturedAt-missing");
    }
    if (!Array.isArray(snapshot.resources)) {
      row.warnings.push("snapshot-resources-not-array");
    } else {
      // Per-field stale conformance (mergeSnapshots.ts:87):
      // expected stale = age(sampledAt) > 3 × windowMs, only for fields
      // that carry BOTH windowMs and sampledAt (unknown interval → never
      // stale by rule, mergeSnapshots.ts:84).
      for (const r of snapshot.resources) {
        if (!r || typeof r !== "object") continue;
        for (const value of Object.values(r)) {
          if (!value || typeof value !== "object") continue;
          const obs = value;
          if (typeof obs.sampledAt !== "number" || obs.windowMs == null) continue;
          row.staleChecked += 1;
          const expectedStale = Date.now() - obs.sampledAt > STALE_FACTOR * obs.windowMs;
          if (expectedStale === (obs.stale === true)) row.staleConform += 1;
        }
      }
    }
  }

  if (recon) {
    row.gpuNodes = Array.isArray(recon.gpuNodes) ? recon.gpuNodes.length : null;
    row.runtimeNodes = Array.isArray(recon.runtimeNodes) ? recon.runtimeNodes.length : null;
    row.providerNodes = Array.isArray(recon.providerNodes) ? recon.providerNodes.length : null;
  }

  return row;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = DEFAULT_ENDPOINT;
  const headers = buildAuthHeaders();
  const endpointShown = redactedEndpoint(endpoint);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(args.out, stamp);
  mkdirSync(outDir, { recursive: true });

  console.log(
    `[soak] endpoint=${endpointShown} windowMs=${args.windowMs} interval=${args.intervalMs}ms duration=${args.minutes}m out=${outDir}`
  );
  if (!process.env.OMNIROUTE_FLEET_METRICS_TOKEN) {
    console.log(
      "[soak] note: no OMNIROUTE_FLEET_METRICS_TOKEN set — management-gated routes will 401/403 (documented: route.ts:41-42)"
    );
  }

  // --- Probe before the soak so an unreachable backend is a loud, explicit
  // verdict rather than 15 minutes of failures.
  let probe;
  try {
    probe = await pollOnce(endpoint, args.windowMs, headers);
  } catch (thrown) {
    fail(
      2,
      BLOCKER_VERDICT,
      `probe ${thrown.kind} after ${thrown.latency}ms — no reachable fleet backend at ${endpointShown}. This is the documented expected outcome while no fleet backend runs.`
    );
  }
  if (probe.httpStatus === 404) {
    fail(
      2,
      BLOCKER_VERDICT,
      `probe got HTTP 404 at ${endpointShown} — the route does not exist on this server (the local process predates the fleet route). This is the documented expected outcome, not a hidden failure.`
    );
  }
  console.log(
    `[soak] probe ok: HTTP ${probe.httpStatus} in ${probe.latencyMs}ms (${probe.responseBytes}B)`
  );

  // --- Soak loop.
  const durationMs = Math.round(args.minutes * 60_000);
  const startedAt = Date.now();
  const rows = [];
  let seq = 0;
  while (Date.now() - startedAt < durationMs) {
    await sleep(args.intervalMs);
    if (Date.now() - startedAt >= durationMs) break;
    seq += 1;
    const row = { seq, tEpochMs: Date.now() };
    try {
      Object.assign(row, await pollOnce(endpoint, args.windowMs, headers));
    } catch (thrown) {
      Object.assign(row, {
        ok: false,
        httpStatus: null,
        latencyMs: thrown.latency ?? null,
        responseBytes: null,
        gpuNodes: null,
        runtimeNodes: null,
        providerNodes: null,
        resources: null,
        freshCapturedAt: null,
        staleChecked: 0,
        staleConform: 0,
        warnings: [thrown.kind === "timeout" ? "poll-timeout" : "poll-unreachable"],
      });
    }
    rows.push(row);
    console.log(
      `[soak] poll ${seq}: HTTP ${row.httpStatus ?? "-"} ${row.latencyMs ?? "-"}ms ` +
        `nodes g/r/p=${row.gpuNodes ?? "-"}/${row.runtimeNodes ?? "-"}/${row.providerNodes ?? "-"} ` +
        `fresh=${row.freshCapturedAt ?? "-"} stale=${row.staleConform}/${row.staleChecked}` +
        (row.warnings.length ? ` warnings=[${row.warnings.join(",")}]` : "")
    );
  }

  const okRows = rows.filter((r) => r.ok);
  const verdict =
    okRows.length === 0
      ? "BACKEND DOWN DURING SOAK — every poll failed after a successful probe"
      : `OK — ${okRows.length}/${rows.length} polls succeeded`;

  const report = {
    generatedAt: new Date().toISOString(),
    endpoint: endpointShown,
    windowMs: args.windowMs,
    intervalMs: args.intervalMs,
    minutesRequested: args.minutes,
    polls: rows.length,
    pollsOk: okRows.length,
    pollsFailed: rows.length - okRows.length,
    freshness: {
      gatewayCacheTtlMs: GATEWAY_CACHE_TTL_MS,
      staleFactor: STALE_FACTOR,
      freshCapturedAtCount: rows.filter((r) => r.freshCapturedAt === true).length,
      freshCapturedAtFalse: rows.filter((r) => r.freshCapturedAt === false).length,
      staleFieldsChecked: rows.reduce((a, r) => a + r.staleChecked, 0),
      staleFieldsConform: rows.reduce((a, r) => a + r.staleConform, 0),
    },
    counts: {
      maxGpuNodes: maxOf(rows.map((r) => r.gpuNodes)),
      maxRuntimeNodes: maxOf(rows.map((r) => r.runtimeNodes)),
      maxProviderNodes: maxOf(rows.map((r) => r.providerNodes)),
      maxResources: maxOf(rows.map((r) => r.resources)),
    },
    latencyMs: {
      min: minOf(okRows.map((r) => r.latencyMs)),
      p50: percentile(
        okRows.map((r) => r.latencyMs).sort((a, b) => a - b),
        50
      ),
      p95: percentile(
        okRows.map((r) => r.latencyMs).sort((a, b) => a - b),
        95
      ),
      p99: percentile(
        okRows.map((r) => r.latencyMs).sort((a, b) => a - b),
        99
      ),
    },
    warningCounts: countWarnings(rows),
    rows,
    verdict,
    notes: [
      "All numbers are read from response bodies actually received; nothing is fabricated.",
      "The response body carries no warnings array (gateway warnings are server-side, gateway.ts:86) — the warnings column is soak-derived only.",
      "Token values are never written to any report or log line.",
    ],
  };
  writeFileSync(join(outDir, "soak.json"), JSON.stringify(report, null, 2) + "\n");

  const csvHeader =
    "seq,t_epoch_ms,ok,http_status,latency_ms,response_bytes,gpu_nodes,runtime_nodes,provider_nodes,resources,fresh_captured_at,stale_checked,stale_conform,warnings";
  const csvRows = rows.map((r) =>
    [
      r.seq,
      r.tEpochMs,
      r.ok ? 1 : 0,
      r.httpStatus ?? "",
      r.latencyMs ?? "",
      r.responseBytes ?? "",
      r.gpuNodes ?? "",
      r.runtimeNodes ?? "",
      r.providerNodes ?? "",
      r.resources ?? "",
      r.freshCapturedAt === null ? "" : r.freshCapturedAt ? 1 : 0,
      r.staleChecked,
      r.staleConform,
      (r.warnings || []).join("|"),
    ].join(",")
  );
  writeFileSync(join(outDir, "soak-polls.csv"), [csvHeader, ...csvRows].join("\n") + "\n");

  console.log(`[soak] verdict: ${verdict}`);
  console.log(`[soak] report -> ${join(outDir, "soak.json")}`);

  if (okRows.length === 0) {
    fail(
      3,
      verdict,
      "every soak poll failed after the probe succeeded — the backend went down mid-run."
    );
  }
}

function maxOf(values) {
  const v = values.filter((x) => typeof x === "number");
  return v.length ? Math.max(...v) : null;
}
function minOf(values) {
  const v = values.filter((x) => typeof x === "number");
  return v.length ? Math.min(...v) : null;
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1)))
  );
  return sorted[rank];
}
function countWarnings(rows) {
  const out = {};
  for (const r of rows) for (const w of r.warnings || []) out[w] = (out[w] || 0) + 1;
  return out;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  fail(1, "unexpected error", String(err && err.stack ? err.stack : err));
});
