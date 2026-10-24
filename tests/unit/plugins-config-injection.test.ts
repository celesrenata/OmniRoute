// Feature test: plugin DB config must reach the child process through the hook
// payload. Plugin children are spawned with no env passthrough for operator
// config, so the only channel from the parent's DB row (plugins.config, a JSON
// string) into plugin code is the hook payload itself.
//
// The manager wraps every registered plugin handler with a non-mutating
// injector that reads a live `Map<name, config>` on each call;
// `pluginManager.syncPluginConfig(name)` re-reads the DB row after
// `updatePluginConfig` so config edits apply without deactivate/reactivate.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Temp dirs (DATA_DIR must be set before the DB modules load) ──

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-plugin-cfg-"));
process.env.DATA_DIR = TEST_DATA_DIR;

// ── Dynamic imports (after DATA_DIR set) ──

const core = await import("../../src/lib/db/core.ts");
const dbPlugins = await import("../../src/lib/db/plugins.ts");
const hooks = await import("../../src/lib/plugins/hooks.ts");
const { pluginManager } = await import("../../src/lib/plugins/manager.ts");

const { withPluginConfigPayload } = hooks;

// Shared DATA_DIR cleanup once for the whole file — individual test cleanups
// must not delete the directory a sibling test still writes its DB into.
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ── Pure helper: non-mutating config injection ──

test("withPluginConfigPayload: injects config into a flat payload without mutating the original", () => {
  const payload = { requestId: "r1", body: {}, metadata: {} };
  const out = withPluginConfigPayload(payload, { mode: "full" }) as Record<string, unknown>;
  assert.notEqual(out, payload, "must return a clone, not the original");
  assert.deepEqual(out.config, { mode: "full" });
  assert.equal(
    (payload as Record<string, unknown>).config,
    undefined,
    "original must stay untouched"
  );
  assert.equal(out.requestId, "r1", "existing fields preserved");
  assert.equal(out.body, payload.body, "shallow clone — field references preserved");
});

test("withPluginConfigPayload: injects into a nested ctx object when present", () => {
  const ctx = { requestId: "r2", body: {} };
  const payload = { ctx, response: "resp" };
  const out = withPluginConfigPayload(payload, { a: 1 }) as {
    ctx: Record<string, unknown>;
    response: string;
  };
  assert.notEqual(out, payload);
  assert.notEqual(out.ctx, ctx, "nested ctx must be cloned");
  assert.deepEqual(out.ctx.config, { a: 1 });
  assert.equal((ctx as Record<string, unknown>).config, undefined, "original ctx untouched");
  assert.equal(out.response, "resp");
});

test("withPluginConfigPayload: passes non-object payloads through unchanged", () => {
  const cfg = { a: 1 };
  assert.equal(withPluginConfigPayload(undefined, cfg), undefined);
  assert.equal(withPluginConfigPayload(null, cfg), null);
  assert.equal(withPluginConfigPayload(42, cfg), 42);
  assert.equal(withPluginConfigPayload("s", cfg), "s");
  const arr = [1, 2];
  assert.equal(withPluginConfigPayload(arr, cfg), arr, "arrays must not be augmented");
});

test("withPluginConfigPayload: undefined config → payload passed through unchanged", () => {
  const payload = { requestId: "r3" };
  assert.equal(withPluginConfigPayload(payload, undefined), payload);
});

// ── Real-child round trip ──

function writeConfigProbePlugin(name: string) {
  // Scanner expects: sourceDir/<plugin-name>/plugin.json + main entry.
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-plugin-cfg-src-"));
  const pluginDir = path.join(sourceDir, name);
  fs.mkdirSync(pluginDir, { recursive: true });

  const manifest = {
    name,
    version: "1.0.0",
    description: "Config injection probe",
    author: "test",
    main: "index.mjs",
    hooks: { onRequest: true, onStreamComplete: true },
    enabledByDefault: false,
    requires: { permissions: [] },
  };
  fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2));

  const indexMjs = `
import { writeFileSync } from "node:fs";
import path from "node:path";

export function onRequest(ctx) {
  const outDir = ctx && ctx.config && ctx.config.outDir;
  if (outDir) {
    writeFileSync(path.join(outDir, "saw-request.json"), JSON.stringify({ config: ctx.config ?? null }));
  }
  return { metadata: { sawConfig: (ctx && ctx.config) ?? null } };
}

export function onStreamComplete(payload) {
  const outDir = payload && payload.config && payload.config.outDir;
  if (outDir) {
    writeFileSync(path.join(outDir, "saw-stream.json"), JSON.stringify({ config: payload.config ?? null }));
  }
}
`;
  fs.writeFileSync(path.join(pluginDir, "index.mjs"), indexMjs);
  return { sourceDir, name };
}

test(
  "plugin config reaches the child through the hook payload and stays live",
  { timeout: 60_000 },
  async (t) => {
    const { sourceDir, name } = writeConfigProbePlugin("config-probe");
    const marker1 = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-plugin-cfg-m1-"));
    const marker2 = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-plugin-cfg-m2-"));

    t.after(async () => {
      try {
        await pluginManager.uninstall(name);
      } catch {
        // already gone — cleanup is best-effort
      }
      for (const d of [sourceDir, marker1, marker2]) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    });

    await pluginManager.install(sourceDir);
    await pluginManager.activate(name);

    const mkCtx = () => ({
      requestId: "req-1",
      body: { model: "test-model", messages: [] },
      model: "test-model",
      provider: "test-provider",
      metadata: {},
    });

    // 1. Initial config (seeded "{}" at install) reaches the child.
    const ctx1 = mkCtx();
    const res1 = await hooks.runOnRequest(ctx1);
    assert.deepEqual(res1.metadata?.sawConfig ?? null, {}, "child saw the seeded empty config");
    assert.equal("config" in ctx1, false, "the caller's ctx must not be mutated by the injector");

    // 2. updatePluginConfig + syncPluginConfig → next delivery sees the new
    //    config WITHOUT a deactivate/reactivate cycle.
    assert.ok(
      dbPlugins.updatePluginConfig(name, { outDir: marker1, mode: "full" }),
      "config written to DB"
    );
    const live = await pluginManager.syncPluginConfig(name);
    assert.deepEqual(
      live,
      { outDir: marker1, mode: "full" },
      "sync returns the freshly read config"
    );
    assert.equal(await pluginManager.syncPluginConfig("no-such-plugin"), undefined);

    const res2 = await hooks.runOnRequest(mkCtx());
    assert.deepEqual(res2.metadata?.sawConfig, { outDir: marker1, mode: "full" });
    const sawRequest = JSON.parse(fs.readFileSync(path.join(marker1, "saw-request.json"), "utf-8"));
    assert.deepEqual(sawRequest.config, { outDir: marker1, mode: "full" });

    // 3. onStreamComplete payloads carry the same live config.
    await hooks.runOnStreamComplete({
      status: 200,
      model: "test-model",
      provider: "test-provider",
      requestId: "req-1",
    });
    const sawStream = JSON.parse(fs.readFileSync(path.join(marker1, "saw-stream.json"), "utf-8"));
    assert.deepEqual(sawStream.config, { outDir: marker1, mode: "full" });

    // 4. A second DB write + sync replaces the live value (live re-read, not a
    //    captured value from activate time).
    assert.ok(dbPlugins.updatePluginConfig(name, { outDir: marker2, mode: "lite" }));
    await pluginManager.syncPluginConfig(name);
    const res4 = await hooks.runOnRequest(mkCtx());
    assert.deepEqual(res4.metadata?.sawConfig, { outDir: marker2, mode: "lite" });
    assert.ok(
      fs.existsSync(path.join(marker2, "saw-request.json")),
      "marker written with the second config"
    );
  }
);

test(
  "deactivate drops the live config entry (no stale config after re-activate)",
  { timeout: 60_000 },
  async (t) => {
    const { sourceDir, name } = writeConfigProbePlugin("config-probe-2");
    const markerA = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-plugin-cfg-mA-"));
    const markerB = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-plugin-cfg-mB-"));

    t.after(async () => {
      try {
        await pluginManager.uninstall(name);
      } catch {
        // already gone
      }
      for (const d of [sourceDir, markerA, markerB]) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    });

    await pluginManager.install(sourceDir);
    await pluginManager.activate(name);
    dbPlugins.updatePluginConfig(name, { outDir: markerA });
    await pluginManager.syncPluginConfig(name);

    await pluginManager.deactivate(name);

    // While inactive nothing is registered — the child cannot observe config.
    const resIdle = await hooks.runOnRequest({
      requestId: "req-2",
      body: {},
      model: "test-model",
      provider: "test-provider",
      metadata: {},
    });
    assert.equal(resIdle.metadata?.sawConfig, undefined, "no plugin handler while deactivated");

    // Re-activate: config must be re-seeded from the DB row, not a stale entry.
    dbPlugins.updatePluginConfig(name, { outDir: markerB });
    await pluginManager.activate(name);
    const resLive = await hooks.runOnRequest({
      requestId: "req-3",
      body: {},
      model: "test-model",
      provider: "test-provider",
      metadata: {},
    });
    assert.deepEqual(resLive.metadata?.sawConfig, { outDir: markerB });
  }
);
