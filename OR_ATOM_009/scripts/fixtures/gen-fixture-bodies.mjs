#!/usr/bin/env node
/**
 * OR-ATOM-009 — bake the demo wire bodies into evidence fixtures.
 *
 * For every scenario of `src/plugins/atomic-topology/dev/demoHarness.ts` this
 * writes the EXACT body the real `GET /api/telemetry/fleet` endpoint would
 * return — `{ snapshot, reconciliation }` built by the app's real
 * `buildDemoSnapshot()` + `reconcileSnapshot()` — into
 * `OR_ATOM_009/scripts/fixtures/<scenarioId>.json`. These fixtures are the
 * evidence that the harness serves what the server would serve, and they are
 * what `soak.mjs` / `contextLoss.mjs` re-verify at runtime.
 *
 * Usage:
 *   node --import tsx OR_ATOM_009/scripts/fixtures/gen-fixture-bodies.mjs            # write JSON
 *   node --import tsx OR_ATOM_009/scripts/fixtures/gen-fixture-bodies.mjs --verify  # shape-check only
 *
 * Exit code 0 = all 9 bodies pass the poller shape check
 * (fleetTelemetryPoller.ts isFleetTelemetryResponse) + the canonical-id
 * rules (gpu:<host>:<uuid>, runtime:<host>:<rtId>, provider:<key>).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { buildFleetBody, capturedAtFor, DEMO_SCENARIO_IDS, isKnownScenario } =
  await import("../lib/atomicDemo.mjs");

const CANONICAL_ID_RE =
  /^(?:gpu|runtime):[A-Za-z0-9._-]+:[A-Za-z0-9-]+$|^provider:[A-Za-z0-9._-]+$/;
/** runtime_model edge targets are "model:<modelId>" (reconcile.ts:221) — a
 * model identity, NOT a canonical resource id; the regex below must accept
 * model names with "/" (e.g. "model:demo/tps20-chat"). */
const MODEL_TARGET_RE = /^model:[A-Za-z0-9._\/-]+$/;

/**
 * Check one id. Resource ids (nodes + sources + device targets) must be
 * canonical; only `runtime_model` edge TARGETS may be model identities.
 */
function isCanonical(id, { isModelTarget = false } = {}) {
  if (typeof id !== "string" || id.length === 0) return false;
  if (isModelTarget) return MODEL_TARGET_RE.test(id);
  return CANONICAL_ID_RE.test(id);
}

function shapeCheckBody(body, scenarioId) {
  const problems = [];
  const { snapshot, reconciliation } = body;
  // The poller's isFleetTelemetryResponse (fleetTelemetryPoller.ts:266).
  if (typeof snapshot !== "object" || snapshot === null) problems.push("snapshot missing");
  else {
    if (typeof snapshot.capturedAt !== "number") problems.push("snapshot.capturedAt not a number");
    if (!Array.isArray(snapshot.resources)) problems.push("snapshot.resources not an array");
  }
  if (typeof reconciliation !== "object" || reconciliation === null)
    problems.push("reconciliation missing");
  else {
    if (reconciliation.schemaVersion !== 1) problems.push("reconciliation.schemaVersion != 1");
    if (typeof reconciliation.capturedAt !== "number")
      problems.push("reconciliation.capturedAt not a number");
    if (!Array.isArray(reconciliation.gpuNodes))
      problems.push("reconciliation.gpuNodes not an array");
    if (!Array.isArray(reconciliation.edges)) problems.push("reconciliation.edges not an array");
  }
  // Canonical-id rule: every resource + node id is canonical, no display
  // labels / bare PCI indices / guessed identities. Only runtime_model edge
  // targets may be model identities ("model:<modelId>").
  const ids = [
    ...(snapshot?.resources ?? []).map((r) => ({ id: r.resourceId })),
    ...(reconciliation?.gpuNodes ?? []).map((n) => ({ id: n.resourceId })),
    ...(reconciliation?.runtimeNodes ?? []).map((n) => ({ id: n.resourceId })),
    ...(reconciliation?.providerNodes ?? []).map((n) => ({ id: n.resourceId })),
    ...(reconciliation?.edges ?? []).flatMap((e) => [
      { id: e.source },
      { id: e.target, isModelTarget: e.relation === "runtime_model" },
    ]),
  ];
  for (const { id, isModelTarget } of ids) {
    if (!isCanonical(id, { isModelTarget })) {
      problems.push(`non-canonical id: ${id}`);
    }
  }
  if (!isKnownScenario(scenarioId)) problems.push(`unknown scenario id ${scenarioId}`);
  // Zero vs unknown: `stale` resources must carry null values (unknown),
  // never a fabricated number; fresh explicit zeros carry value 0.
  for (const r of snapshot?.resources ?? []) {
    for (const field of ["outputTokensPerSecond", "queuedJobs", "activeJobs"]) {
      const o = r[field];
      if (!o) continue;
      if (o.stale === true && o.value !== null)
        problems.push(
          `${r.resourceId}.${field}: stale but value ${o.value} (must be null/unknown)`
        );
    }
  }
  return problems;
}

async function main() {
  const verifyOnly = process.argv.includes("--verify");
  const outDir = path.join(HERE, "..", "fixtures");
  let failures = 0;
  for (const id of DEMO_SCENARIO_IDS) {
    const body = await buildFleetBody(id, capturedAtFor(id));
    const problems = shapeCheckBody(body, id);
    if (problems.length > 0) {
      failures++;
      console.log(`FAIL ${id}:`);
      for (const p of problems) console.log(`   - ${p}`);
      continue;
    }
    if (!verifyOnly) {
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, `${id}.json`);
      fs.writeFileSync(outPath, JSON.stringify(body, null, 2));
    }
    const rec = body.reconciliation;
    console.log(
      `OK ${id}: capturedAt=${body.snapshot.capturedAt} resources=${body.snapshot.resources.length} ` +
        `gpu=${rec.gpuNodes.length} runtime=${rec.runtimeNodes.length} provider=${rec.providerNodes.length} ` +
        `edges=${rec.edges.length} fallback=${rec.providerCentricFallback} ` +
        `bytes=${JSON.stringify(body).length}`
    );
  }
  if (failures > 0) {
    console.log(`FIXTURE GEN FAILED (${failures}/9)`);
    process.exit(1);
  }
  console.log(
    verifyOnly ? "VERIFY PASSED (9/9)" : "WROTE 9 fixture bodies to OR_ATOM_009/scripts/fixtures/"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
