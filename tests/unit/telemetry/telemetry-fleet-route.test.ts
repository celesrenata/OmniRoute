/**
 * Fleet telemetry gateway endpoint — source-scan invariants (T005 / M2, OR-ATOM-001 v2).
 *
 * `GET /api/telemetry/fleet` is the ONE management-authenticated, server-side
 * bounded snapshot endpoint. Behavioral auth coverage lives in the DB-backed
 * sibling test; here we pin the SECURITY shape of the route + wiring source so
 * a refactor cannot silently:
 *   - drop the management gate (or move it AFTER data access),
 *   - leak raw err.stack / err.message into responses (hard rule #12),
 *   - add a second (external) telemetry backend or an upstream fetch fan-out,
 *   - become a static/cached route, or add write methods.
 *
 * No DB, no Next runtime — the whole file is readFileSync + string asserts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const routePath = path.join("src", "app", "api", "telemetry", "fleet", "route.ts");
const wiringPath = path.join("src", "shared", "topology", "telemetry", "gatewayServer.ts");
const mappingPath = path.join("src", "shared", "topology", "telemetry", "httpQuery.ts");

function readRoute(): string {
  return fs.readFileSync(routePath, "utf8");
}

test("fleet telemetry route: management gate runs BEFORE any data access", () => {
  const src = readRoute();
  const authIdx = src.indexOf("requireManagementAuth(request)");
  assert.ok(
    authIdx !== -1,
    "route must call requireManagementAuth(request) (the repo management gate)"
  );

  const dataIdx = src.indexOf("fetchFleetTelemetrySnapshot(");
  assert.ok(dataIdx !== -1, "route must delegate to the server-side gateway");
  assert.ok(authIdx < dataIdx, "requireManagementAuth must run BEFORE fetchFleetTelemetrySnapshot");

  assert.match(
    src,
    /const\s+authError\s*=\s*await\s+requireManagementAuth\(request\);\s*if\s*\(\s*authError\s*\)\s*return\s+authError;/,
    "route must short-circuit on the authError response"
  );
});

test("fleet telemetry route: errors never leak raw stack/message (hard rule #12)", () => {
  const src = readRoute();
  assert.match(
    src,
    /import\s*\{\s*buildErrorBody\s*\}\s*from\s*["@']@omniroute\/open-sse\/utils\/error/,
    "route must import buildErrorBody from the shared error helper"
  );
  assert.match(
    src,
    /import\s*\{\s*requireManagementAuth\s*\}\s*from\s*["@']@\/lib\/api\/requireManagementAuth/,
    "route must import requireManagementAuth from @/lib/api"
  );
  assert.ok(
    !/buildErrorBody\([^)]*\berr\.(stack|message)/.test(src),
    "route must not pass err.stack / err.message into buildErrorBody"
  );
  assert.ok(
    !/message:\s*error\.(stack|message)/.test(src),
    "route must not echo error.stack / error.message into a response body"
  );
  assert.ok(!src.includes("err.stack"), "no raw stack reference in the route source");
});

test("fleet telemetry route: single native backend, no external fan-out, server-side only", () => {
  const src = readRoute();
  assert.match(
    src,
    /import\s*\{\s*fetchFleetTelemetrySnapshot\s*\}\s*from\s*["@']@\/shared\/topology\/telemetry\/gatewayServer/,
    "route must use the server-side gatewayServer module"
  );
  assert.match(
    src,
    /import\s*\{\s*mapFleetTelemetryQuery\s*\}\s*from\s*["@']@\/shared\/topology\/telemetry\/httpQuery/,
    "route must validate the query via mapFleetTelemetryQuery"
  );
  assert.ok(
    !/import\s+[^;]*from\s*["'][^"']*(prometheus|influx|grafana)/i.test(src),
    "route must not import an external telemetry backend"
  );
  assert.ok(!/\bfetch\(/.test(src), "route must not issue its own upstream fetch");
  assert.ok(
    !/window\.location|document\.|localStorage/.test(src),
    "route must not reference browser APIs (server-side only)"
  );
});

test("fleet telemetry route: forced-dynamic and a single GET handler", () => {
  const src = readRoute();
  assert.match(src, /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  assert.match(src, /export\s+async\s+function\s+GET\s*\(\s*request:\s*Request\s*\)/);
  assert.ok(
    !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/.test(src),
    "endpoint is read-only: GET only"
  );
});

test("fleet telemetry route: 400 bad query, 408 abort, 503 backend failure", () => {
  const src = readRoute();
  assert.match(src, /buildErrorBody\(\s*400\s*,/);
  assert.match(src, /buildErrorBody\(\s*408\s*,/);
  assert.match(src, /buildErrorBody\(\s*503\s*,/);
  assert.match(src, /TelemetryQueryError/);
  assert.match(src, /TelemetryAbortedError/);
});

test("fleet telemetry server wiring: native adapter mandatory, external optional (OR-ATOM-005)", () => {
  const wiring = fs.readFileSync(wiringPath, "utf8");

  // Native adapter is ALWAYS registered (mandatory backend).
  assert.match(wiring, /createProductionOmnirouteProvider/);
  assert.match(
    wiring,
    /await\s+import\s*\(\s*["']\.\/providers\/omniroute\.ts["']\s*\)/,
    "native provider must be imported dynamically (keeps DB out of the static import graph)"
  );

  // Optional external adapters: imported from the provider factories,
  // registered conditionally via readFleetMetricsConfig(). A misconfigured
  // or down external source must never 503 the endpoint.
  assert.match(
    wiring,
    /readFleetMetricsConfig/,
    "external adapter registration must be gated by readFleetMetricsConfig"
  );
  assert.match(
    wiring,
    /registerExternalAdapter/,
    "external adapter registration must be isolated in a dedicated function"
  );

  // ONE bounded counter engine per stateful external adapter (prometheus /
  // grafana): without cross-snapshot state the vLLM counter rate is always
  // null (the engine lives in the shared metricMapping.ts).
  assert.match(wiring, /createCounterRateEngine/);

  // At most two providers may be registered (native + one external).
  const registerCalls = wiring.match(/\.register\(/g) ?? [];
  assert.ok(
    registerCalls.length >= 1 && registerCalls.length <= 2,
    `at most two providers may be registered (native + optional external), found ${registerCalls.length}`
  );

  // The wiring may import external backend factories (they are optional).
  // But it must NOT issue its own upstream fetch — all network goes through
  // the providers' fleetMetricsFetch (SSRF-safe).
  assert.ok(!/\bfetch\(/.test(wiring), "wiring must not issue its own upstream fetch");

  assert.match(
    wiring,
    /export\s+function\s+resetFleetTelemetryGatewayForTests/,
    "wiring must expose a test reset hook"
  );
});

test("fleet telemetry query mapping: pure module, no DB/Next imports", () => {
  const mapping = fs.readFileSync(mappingPath, "utf8");
  assert.ok(
    !/import\s+[^;]*from\s*["']@\/(lib|app)\//.test(mapping),
    "query mapping must stay dependency-free (no @/lib or @/app imports)"
  );
  assert.match(mapping, /export\s+function\s+mapFleetTelemetryQuery/);
  assert.match(mapping, /export\s+const\s+FLEET_TELEMETRY_DEFAULT_WINDOW_MS/);
});
