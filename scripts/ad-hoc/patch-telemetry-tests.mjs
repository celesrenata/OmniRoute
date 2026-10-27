// One-shot patcher for the OR-ATOM-005 telemetry test updates (worker-2).
// Applies exact string replacements with a single-occurrence guard.
// Run: node scripts/ad-hoc/patch-telemetry-tests.mjs
import fs from "node:fs";

function patch(file, edits) {
  let src = fs.readFileSync(file, "utf8");
  for (const [i, [old, replacement, label]] of edits.entries()) {
    if (old === "") {
      // Append-to-end edit (new top-level describe blocks). The replacement
      // string must start with a newline; the file must already end with one.
      if (!replacement.startsWith("\n")) {
        console.error(`FAIL ${file} edit #${i} (${label}): append must start with \\n`);
        process.exit(1);
      }
      if (!src.endsWith("\n")) src += "\n";
      src = src + replacement;
      console.log(`  + ${file} edit #${i} (${label}): appended`);
      continue;
    }
    const count = src.split(old).length - 1;
    if (count !== 1) {
      console.error(`FAIL ${file} edit #${i} (${label}): expected 1 occurrence, found ${count}`);
      process.exit(1);
    }
    src = src.replace(old, replacement);
  }
  fs.writeFileSync(file, src);
  console.log(`OK ${file}: ${edits.length} edit(s)`);
}

const PROM = "tests/unit/telemetry/telemetry-provider-prometheus.test.ts";
patch(PROM, [
  [
    " *   - exactly the 6 allowlisted metrics are queried (version-controlled set).",
    " *   - exactly the 11 allowlisted metrics are queried (version-controlled set:\n *     5 DCGM gauges + vLLM counter + 2 vLLM scheduler gauges + 3 macmon gauges).",
    "header count",
  ],
  [
    'import { createCounterRateEngine } from "../../../src/shared/topology/telemetry/providers/metricMapping";',
    'import {\n  ALLOWLISTED_METRIC_NAMES,\n  createCounterRateEngine,\n  mappingForMetric,\n} from "../../../src/shared/topology/telemetry/providers/metricMapping";',
    "metricMapping imports",
  ],
  [
    ' * Unknown metrics default to a 404 (so a snapshot always "sees" all six).',
    ' * Unknown metrics default to a 404 (so a snapshot always "sees" all eleven).',
    "prom fake fetch comment",
  ],
  [
    "/** All six allowlisted metrics, each one series on the shared GPU. */",
    "/** The DCGM gauges + the vLLM counter (a subset of the allowlist): one\n * series on the shared GPU each. */",
    "allMetrics comment",
  ],
  [
    '  it("queries exactly the six allowlisted metrics, one bounded request each", async () => {',
    '  it("queries exactly the eleven allowlisted metrics, one bounded request each", async () => {',
    "count test title",
  ],
  ["    assert.equal(calls.length, 6);", "    assert.equal(calls.length, 11);", "count assertion"],
  [
    '    assert.deepEqual(names, [\n      "DCGM_FI_DEV_FB_TOTAL",\n      "DCGM_FI_DEV_FB_USED",\n      "DCGM_FI_DEV_GPU_TEMP",\n      "DCGM_FI_DEV_GPU_UTIL",\n      "DCGM_FI_DEV_POWER_USAGE",\n      "vllm:generation_tokens_total",\n    ]);',
    '    assert.deepEqual(names, [\n      "DCGM_FI_DEV_FB_TOTAL",\n      "DCGM_FI_DEV_FB_USED",\n      "DCGM_FI_DEV_GPU_TEMP",\n      "DCGM_FI_DEV_GPU_UTIL",\n      "DCGM_FI_DEV_POWER_USAGE",\n      "macmon_gpu_power_watts",\n      "macmon_gpu_scaled_ratio",\n      "macmon_gpu_temp_celsius",\n      "vllm:generation_tokens_total",\n      "vllm:num_requests_running",\n      "vllm:num_requests_waiting",\n    ]);',
    "allowlist name list",
  ],
  [
    "",
    '\ndescribe("prometheus provider: snapshot — scheduler gauges + macmon (name-keyed allowlist)", () => {\n  it("maps the vLLM scheduler gauges onto ONE runtime row (queuedJobs / activeJobs)", async () => {\n    const { fetchImpl } = makeFakeFetch({\n      "vllm:num_requests_waiting": { body: { data: { result: series(RUNTIME_LABELS, 7) } } },\n      "vllm:num_requests_running": { body: { data: { result: series(RUNTIME_LABELS, 11) } } },\n    });\n    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });\n\n    const snapshot = await provider.snapshot(QUERY);\n\n    assert.equal(snapshot.resources.length, 1);\n    const row = findBy(snapshot, "runtime:h1:rt-0");\n    assert.ok(row);\n    assert.equal(row.kind, "runtime");\n    assert.equal(row.hostId, "h1");\n    assert.equal(row.runtimeId, "rt-0");\n    assert.equal(row.queuedJobs?.value, 7);\n    assert.equal(row.queuedJobs?.source, "prometheus");\n    assert.equal(row.queuedJobs?.basis, "vllm:num_requests_waiting");\n    assert.equal(row.activeJobs?.value, 11);\n    assert.equal(row.activeJobs?.basis, "vllm:num_requests_running");\n  });\n\n  it("scales the macmon scaled ratio (0..1) to 0..100 percent on a gpu row (no VRAM)", async () => {\n    const { fetchImpl } = makeFakeFetch({\n      macmon_gpu_scaled_ratio: { body: { data: { result: series(GPU_LABELS, 0.5) } } },\n    });\n    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });\n\n    const snapshot = await provider.snapshot(QUERY);\n\n    assert.equal(snapshot.resources.length, 1);\n    const row = snapshot.resources[0];\n    assert.equal(row.resourceId, "gpu:h1:uuid-0");\n    assert.equal(row.utilizationPercent?.value, 50);\n    assert.equal(row.utilizationPercent?.source, "prometheus");\n    assert.equal(row.utilizationPercent?.basis, "macmon_gpu_scaled_ratio");\n    // macmon exposes NO discrete VRAM — absent, never a fabricated zero.\n    assert.equal(row.vramUsedBytes, undefined);\n    assert.equal(row.vramTotalBytes, undefined);\n  });\n\n  it("reports an out-of-range macmon ratio as UNKNOWN (never clamped, never fabricated)", async () => {\n    const { fetchImpl } = makeFakeFetch({\n      macmon_gpu_scaled_ratio: { body: { data: { result: series(GPU_LABELS, 1.5) } } },\n    });\n    const provider = createPrometheusProvider({ config: config(), fetchImpl, now: fixtureNow });\n\n    const snapshot = await provider.snapshot(QUERY);\n\n    const row = snapshot.resources[0];\n    assert.ok(row);\n    assert.equal(row.resourceId, "gpu:h1:uuid-0");\n    assert.equal(row.utilizationPercent?.value, null);\n    assert.equal(row.utilizationPercent?.source, "prometheus");\n    assert.equal(row.utilizationPercent?.basis, "macmon_gpu_scaled_ratio");\n  });\n\n  it("allowlist is name-keyed: DCGM + macmon collisions survive (all 11 names resolve)", () => {\n    // Regression guard for the old field-keyed Map: the macmon entries shared\n    // the gpu_util / gpu_temperature_c / gpu_power_w fields with DCGM, and a\n    // field-keyed map silently dropped the DCGM names (5 of 11 never queried).\n    assert.equal(ALLOWLISTED_METRIC_NAMES.size, 11);\n    assert.deepEqual([...ALLOWLISTED_METRIC_NAMES.keys()].sort(), [\n      "DCGM_FI_DEV_FB_TOTAL",\n      "DCGM_FI_DEV_FB_USED",\n      "DCGM_FI_DEV_GPU_TEMP",\n      "DCGM_FI_DEV_GPU_UTIL",\n      "DCGM_FI_DEV_POWER_USAGE",\n      "macmon_gpu_power_watts",\n      "macmon_gpu_scaled_ratio",\n      "macmon_gpu_temp_celsius",\n      "vllm:generation_tokens_total",\n      "vllm:num_requests_running",\n      "vllm:num_requests_waiting",\n    ]);\n    assert.equal(mappingForMetric("DCGM_FI_DEV_GPU_UTIL")?.field, "gpu_util");\n    assert.equal(mappingForMetric("macmon_gpu_scaled_ratio")?.field, "gpu_util");\n    assert.equal(mappingForMetric("vllm:num_requests_waiting")?.field, "runtime_scheduler_waiting");\n    assert.equal(mappingForMetric("vllm:num_requests_running")?.field, "runtime_scheduler_running");\n    assert.equal(mappingForMetric("not_a_metric"), null);\n  });\n});',
    "append regression block",
  ],
]);

const GRAF = "tests/unit/telemetry/telemetry-provider-grafana.test.ts";
patch(GRAF, [
  [
    " *   - exactly the 6 allowlisted metrics are queried (no user PromQL);",
    " *   - exactly the 11 allowlisted metrics are queried (no user PromQL);",
    "header count",
  ],
  [
    ' * "sees" all six allowlisted queries).',
    ' * "sees" all eleven allowlisted queries).',
    "fake fetch comment",
  ],
  [
    '  it("queries exactly the six allowlisted metrics via POST /api/ds/query", async () => {',
    '  it("queries exactly the eleven allowlisted metrics via POST /api/ds/query", async () => {',
    "count test title",
  ],
  ["    assert.equal(calls.length, 6);", "    assert.equal(calls.length, 11);", "count assertion"],
  [
    "",
    '\ndescribe("grafana provider: snapshot — scheduler gauges + macmon (name-keyed allowlist)", () => {\n  it("maps the vLLM scheduler gauges onto ONE runtime row (queuedJobs / activeJobs)", async () => {\n    const payloads = resultsFor({\n      "vllm:num_requests_waiting": [frame(RUNTIME_LABELS, [T0_ISO], [7])],\n      "vllm:num_requests_running": [frame(RUNTIME_LABELS, [T0_ISO], [11])],\n    });\n    const { fetchImpl } = makeFakeFetch(payloads);\n    const provider = createGrafanaProvider({\n      config: config(),\n      datasourceUid: DS_UID,\n      fetchImpl,\n      now: fixtureNow,\n    });\n\n    const snapshot = await provider.snapshot(QUERY);\n\n    assert.equal(snapshot.resources.length, 1);\n    const row = findBy(snapshot, "runtime:h1:rt-0");\n    assert.ok(row);\n    assert.equal(row.kind, "runtime");\n    assert.equal(row.runtimeId, "rt-0");\n    assert.equal(row.queuedJobs?.value, 7);\n    assert.equal(row.queuedJobs?.source, "grafana");\n    assert.equal(row.queuedJobs?.basis, BASIS);\n    assert.equal(row.activeJobs?.value, 11);\n  });\n\n  it("scales the macmon scaled ratio (0..1) to 0..100 percent on a gpu row (no VRAM)", async () => {\n    const payloads = resultsFor({\n      macmon_gpu_scaled_ratio: [frame(GPU_LABELS, [T0_ISO], [0.5])],\n    });\n    const { fetchImpl } = makeFakeFetch(payloads);\n    const provider = createGrafanaProvider({\n      config: config(),\n      datasourceUid: DS_UID,\n      fetchImpl,\n      now: fixtureNow,\n    });\n\n    const snapshot = await provider.snapshot(QUERY);\n\n    const row = snapshot.resources[0];\n    assert.ok(row);\n    assert.equal(row.resourceId, "gpu:h1:uuid-0");\n    assert.equal(row.utilizationPercent?.value, 50);\n    assert.equal(row.utilizationPercent?.basis, BASIS);\n    // macmon exposes NO discrete VRAM — absent, never a fabricated zero.\n    assert.equal(row.vramUsedBytes, undefined);\n    assert.equal(row.vramTotalBytes, undefined);\n  });\n});',
    "append regression block",
  ],
]);

const INFLUX = "tests/unit/telemetry/telemetry-provider-influx.test.ts";
patch(INFLUX, [
  [
    "",
    '\ndescribe("influx provider: snapshot — runtime gauges (vLLM scheduler counts)", () => {\n  it("maps queued_jobs + active_jobs gauges onto the runtime row (activeJobs emitted)", async () => {\n    const { fetchImpl } = makeFakeFetch({\n      [INFLUX_QUERIES.gpu]: { body: { results: [] } },\n      [INFLUX_QUERIES.runtime]: {\n        body: {\n          results: [\n            {\n              statementId: "_0",\n              name: "runtime",\n              series: [\n                {\n                  columns: ["time", "host_id", "runtime_id", "queued_jobs", "active_jobs"],\n                  values: [[T0_ISO, "h1", "rt-0", 3, 9]],\n                },\n              ],\n            },\n          ],\n        },\n      },\n    });\n    const provider = createInfluxProvider({ config: config(), fetchImpl, now: fixtureNow });\n\n    const snapshot = await provider.snapshot(QUERY);\n\n    assert.equal(snapshot.resources.length, 1);\n    const row = snapshot.resources[0];\n    assert.equal(row.resourceId, "runtime:h1:rt-0");\n    assert.equal(row.kind, "runtime");\n    assert.equal(row.runtimeId, "rt-0");\n    assert.equal(row.queuedJobs?.value, 3);\n    assert.equal(row.queuedJobs?.basis, "field:queued_jobs");\n    assert.equal(row.activeJobs?.value, 9);\n    assert.equal(row.activeJobs?.source, "influxdb2");\n    assert.equal(row.activeJobs?.basis, "field:active_jobs");\n    assert.equal(row.outputTokensPerSecond, undefined); // no counter column → no TPS\n  });\n});',
    "append active_jobs test",
  ],
]);

const ROUTE = "tests/unit/telemetry/telemetry-fleet-route.test.ts";
patch(ROUTE, [
  [
    '  assert.match(\n    wiring,\n    /registerExternalAdapter/,\n    "external adapter registration must be isolated in a dedicated function"\n  );',
    '  assert.match(\n    wiring,\n    /registerExternalAdapter/,\n    "external adapter registration must be isolated in a dedicated function"\n  );\n\n  // ONE bounded counter engine per stateful external adapter (prometheus /\n  // grafana): without cross-snapshot state the vLLM counter rate is always\n  // null (the engine lives in the shared metricMapping.ts).\n  assert.match(wiring, /createCounterRateEngine/);',
    "counter engine wiring assertion",
  ],
]);

console.log("All patches applied.");
