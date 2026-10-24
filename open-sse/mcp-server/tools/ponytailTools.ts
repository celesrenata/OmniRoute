/**
 * MCP Ponytail Tools — 4 tools for the ponytail plugin (mode, band ledger).
 *
 * Thin parent-side access to the ponytail plugin's live DB config and its
 * JSONL band ledger. The ledger file is written by the plugin's child
 * process; these tools read/clear it in the parent so no plugin child needs
 * to be alive for inspection. Error shape mirrors pluginTools
 * (`{ success: false, error: "Plugin 'ponytail' not found" }`).
 *
 * @module mcp-server/tools/ponytailTools
 */

import { z } from "zod";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPluginByName, updatePluginConfig } from "../../../src/lib/db/plugins";
import { pluginManager } from "../../../src/lib/plugins/manager";

const PONYTAIL_NAME = "ponytail";
const MODES = ["off", "lite", "full", "ultra"] as const;
type PonytailMode = (typeof MODES)[number];

/**
 * The ponytail plugin defaults its ledger to `tmpdir()/omniroute/ponytail` when
 * config.ledgerDir is empty — the parent must compute the same path.
 */
function bandFile(config: Record<string, unknown>): string {
  const dir =
    (typeof config.ledgerDir === "string" && config.ledgerDir.trim()) ||
    join(tmpdir(), "omniroute", "ponytail");
  return join(dir, "band.jsonl");
}

function loadConfig(): Record<string, unknown> {
  const row = getPluginByName(PONYTAIL_NAME);
  if (!row) return {};
  try {
    return JSON.parse(row.config || "{}");
  } catch {
    return {};
  }
}

/** Read the ledger (if present) and parse the last `limit` JSONL rows. */
function readBandRows(config: Record<string, unknown>, limit: number): Record<string, unknown>[] {
  const file = bandFile(config);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        // A torn trailing line (concurrent append vs. read) is not worth failing the
        // whole read — skip it.
        return null;
      }
    })
    .filter((r): r is Record<string, unknown> => r !== null);
}

/** Aggregate the full ledger: per-model latency/ttft/tokens and totals. */
function aggregateBand(config: Record<string, unknown>) {
  const file = bandFile(config);
  const lines = existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
    : [];
  const byModel: Record<
    string,
    {
      count: number;
      totalLatencyMs: number;
      totalTtftMs: number;
      ttftSamples: number;
      promptTokens: number;
      completionTokens: number;
      lastSeenTs: string | null;
    }
  > = {};
  let rows = 0;
  let parseErrors = 0;
  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    rows += 1;
    const model = typeof row.model === "string" ? row.model : "unknown";
    const agg = byModel[model] ?? {
      count: 0,
      totalLatencyMs: 0,
      totalTtftMs: 0,
      ttftSamples: 0,
      promptTokens: 0,
      completionTokens: 0,
      lastSeenTs: null,
    };
    agg.count += 1;
    const latency = typeof row.latencyMs === "number" ? row.latencyMs : 0;
    agg.totalLatencyMs += latency;
    const ttft = typeof row.ttftMs === "number" ? row.ttftMs : 0;
    if (typeof row.ttftMs === "number") {
      agg.totalTtftMs += ttft;
      agg.ttftSamples += 1;
    }
    const usage = (row.usage ?? null) as Record<string, number> | null;
    if (usage) {
      agg.promptTokens += usage.prompt_tokens ?? 0;
      agg.completionTokens += usage.completion_tokens ?? 0;
    }
    if (typeof row.ts === "string") agg.lastSeenTs = row.ts;
    byModel[model] = agg;
  }
  const models: Record<string, unknown> = {};
  for (const [model, a] of Object.entries(byModel)) {
    models[model] = {
      count: a.count,
      avgLatencyMs: a.count ? Math.round((a.totalLatencyMs / a.count) * 100) / 100 : 0,
      avgTtftMs: a.ttftSamples ? Math.round((a.totalTtftMs / a.ttftSamples) * 100) / 100 : null,
      promptTokens: a.promptTokens,
      completionTokens: a.completionTokens,
      lastSeenTs: a.lastSeenTs,
    };
  }
  return { rows, parseErrors, models, file: file };
}

export const ponytailTools = [
  {
    name: "ponytail_status",
    description:
      "Status of the ponytail plugin: active state, live config, and band-ledger file path.",
    scopes: ["read:plugins"],
    inputSchema: z.object({}),
    handler: async () => {
      const plugin = getPluginByName(PONYTAIL_NAME);
      if (!plugin) return { success: false, error: `Plugin '${PONYTAIL_NAME}' not found` };
      const config = loadConfig();
      return {
        success: true,
        plugin: {
          name: plugin.name,
          status: plugin.status,
          enabled: plugin.enabled === 1,
          installedAt: plugin.installedAt,
          activatedAt: plugin.activatedAt,
        },
        config,
        bandFile: bandFile(config),
        bandExists: existsSync(bandFile(config)),
      };
    },
  },

  {
    name: "ponytail_set_mode",
    description:
      "Set the ponytail injection mode (off | lite | full | ultra). Applies to the next request without re-activation.",
    scopes: ["write:plugins"],
    inputSchema: z.object({
      mode: z.enum(MODES).describe("Ponytail intensity: off (no injection), lite, full, ultra"),
    }),
    handler: async (args: { mode: PonytailMode }) => {
      if (!getPluginByName(PONYTAIL_NAME)) {
        return { success: false, error: `Plugin '${PONYTAIL_NAME}' not found` };
      }
      const config = loadConfig();
      config.mode = args.mode;
      updatePluginConfig(PONYTAIL_NAME, config);
      // Push the fresh config into the live map so the next hook delivery sees it.
      await pluginManager.syncPluginConfig(PONYTAIL_NAME);
      return { success: true, mode: args.mode };
    },
  },

  {
    name: "ponytail_band",
    description:
      "Read the ponytail band ledger (JSONL): per-model latency/ttft/token aggregation plus the last N rows.",
    scopes: ["read:plugins"],
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .optional()
        .describe("Max rows to return (default 50, max 500). Aggregation covers the whole file."),
    }),
    handler: async (args: { limit?: number }) => {
      const plugin = getPluginByName(PONYTAIL_NAME);
      if (!plugin) return { success: false, error: `Plugin '${PONYTAIL_NAME}' not found` };
      const config = loadConfig();
      const limit = args.limit ?? 50;
      const summary = aggregateBand(config);
      return {
        success: true,
        file: summary.file,
        rows: summary.rows,
        parseErrors: summary.parseErrors,
        models: summary.models,
        tail: readBandRows(config, limit),
      };
    },
  },

  {
    name: "ponytail_clear_band",
    description: "Delete the ponytail band ledger file (band.jsonl) and all its rows.",
    scopes: ["write:plugins"],
    inputSchema: z.object({}),
    handler: async () => {
      const plugin = getPluginByName(PONYTAIL_NAME);
      if (!plugin) return { success: false, error: `Plugin '${PONYTAIL_NAME}' not found` };
      const file = bandFile(loadConfig());
      if (!existsSync(file)) return { success: true, cleared: 0, file: file };
      rmSync(file);
      return { success: true, cleared: 1, file: file };
    },
  },
];
