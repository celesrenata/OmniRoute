/**
 * catalogTools.ts — WP4 (Skill Hub): four fixed `omr_catalog_*` MCP tools.
 *
 * Per spec §A3 the tool surface is constant regardless of catalog size:
 *   - omr_catalog_search   (read:catalog)
 *   - omr_catalog_load     (read:catalog)
 *   - omr_catalog_resource (read:catalog)
 *   - omr_catalog_execute  (execute:skills)
 *
 * These delegate to `SkillDiscoveryService` (open-sse/services/skillDiscovery.ts)
 * for search/load, and to the existing `SkillExecutor` for execute (only for
 * registered built-in skills — instruction-only imported skills return a
 * clear non-executable result).
 */
import { z } from "zod";
import {
  searchCatalog,
  loadSkill,
  getCatalogSkill,
  listDomains,
  resolveContainedResource,
  type SearchOptions,
} from "../../services/skillDiscovery.ts";
import { skillExecutor } from "@/lib/skills/executor";
import { GLOBAL_SKILL_OWNER_ID } from "@/lib/skills/registry.ts";
import { resolveMcpToolOwnerId } from "../mcpCallerIdentity.ts";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
import type { McpToolExtraLike } from "../scopeEnforcement.ts";

// ── Schemas ─────────────────────────────────────────────────────────────────

export const CatalogSearchSchema = z.object({
  query: z.string().min(1).max(500),
  project: z.string().optional(),
  language: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  skillset: z.string().optional(),
  /**
   * Optional explicit per-agent principal id to scope results by (WP6). When
   * set, results are restricted to the skillsets granted to this agent
   * (fail-closed). When omitted, the caller's own principal is used if the
   * SKILL_HUB_AGENT_POLICY flag is on, otherwise the full catalog.
   */
  agentId: z.string().optional(),
});

export const CatalogLoadSchema = z.object({
  id: z.string().min(1),
  revision: z.string().optional(),
});

export const CatalogResourceSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).max(500),
  revision: z.string().optional(),
});

export const CatalogExecuteSchema = z.object({
  id: z.string().min(1),
  revision: z.string().optional(),
  operation: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  apiKeyId: z.string().optional(),
});

// ── Tools ───────────────────────────────────────────────────────────────────

export const catalogTools = {
  omr_catalog_search: {
    name: "omr_catalog_search",
    description:
      "Search the unified skill catalog (built-in + imported) with weighted lexical ranking. " +
      "Returns 5–10 short summaries with opaque IDs, score, and explainable reason. " +
      "No full skill content is included — use omr_catalog_load to fetch full instructions.",
    scopes: ["read:catalog"],
    inputSchema: CatalogSearchSchema,
    handler: async (args: z.infer<typeof CatalogSearchSchema>) => {
      const opts: SearchOptions = {
        limit: args.limit,
        domain: args.skillset,
        tag: args.capabilities?.[0],
      };
      // Per-agent policy (WP6) — scope results to granted skillsets.
      //   1. An explicit `agentId` in the args always applies the policy.
      //   2. Otherwise the caller's own principal is used, but only when the
      //      operator opted in via SKILL_HUB_AGENT_POLICY. Flag OFF and no
      //      explicit agentId → legacy permissive full-catalog search.
      const policyOn = isFeatureFlagEnabled("SKILL_HUB_AGENT_POLICY");
      if (args.agentId) {
        opts.agentId = args.agentId;
      } else if (policyOn) {
        const { resolveMcpCallerApiKeyId } = await import("../mcpCallerIdentity.ts");
        const caller = await resolveMcpCallerApiKeyId();
        if (caller) opts.agentId = caller;
      }
      const results = searchCatalog(args.query, opts);
      return {
        query: args.query,
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          domain: r.domain,
          revision: r.revision,
          tags: r.tags,
          source: r.source,
          score: r.score,
          reason: r.reason,
        })),
      };
    },
  },

  omr_catalog_load: {
    name: "omr_catalog_load",
    description:
      "Load the full SKILL.md content and safe metadata for a skill by its catalog ID. " +
      "Content is bounded to 50KB. Use omr_catalog_search to find the ID first.",
    scopes: ["read:catalog"],
    inputSchema: CatalogLoadSchema,
    handler: async (args: z.infer<typeof CatalogLoadSchema>) => {
      // Per-agent policy (WP6) — a caller with the SKILL_HUB_AGENT_POLICY flag
      // on can only load skills in skillsets they've been granted. We look up
      // the skill's domain first so we can scope the grant check.
      if (isFeatureFlagEnabled("SKILL_HUB_AGENT_POLICY")) {
        const skill = getCatalogSkill(args.id);
        if (skill) {
          const { resolveMcpCallerApiKeyId } = await import("../mcpCallerIdentity.ts");
          const caller = await resolveMcpCallerApiKeyId();
          if (caller) {
            const { discoverDomainsForAgent } = await import("@/lib/db/skillHub.ts");
            const granted = discoverDomainsForAgent(caller);
            // Fail-closed: a resolved caller with NO grants (null) can load
            // nothing, and one with grants is limited to those skillsets.
            if (granted === null) {
              return { error: "No accessible skillsets for this agent", found: false };
            }
            if (!granted.includes(skill.domain) && !granted.includes(skill.id)) {
              return { error: "Skill not in an accessible skillset for this agent", found: false };
            }
          }
        }
      }

      const loaded = loadSkill(args.id);
      if (!loaded) {
        return { error: `Skill not found: ${args.id}`, found: false };
      }
      const { skill, content } = loaded;
      return {
        found: true,
        id: skill.id,
        name: skill.name,
        description: skill.description,
        domain: skill.domain,
        revision: skill.revision,
        tags: skill.tags,
        source: skill.source,
        license: skill.license,
        executable: skill.executable,
        content,
      };
    },
  },

  omr_catalog_resource: {
    name: "omr_catalog_resource",
    description:
      "Access a path-contained text/reference/asset file inside a skill package. " +
      "Path must be relative to the skill directory (no traversal). " +
      "Only applies to imported skills that have a local file tree.",
    scopes: ["read:catalog"],
    inputSchema: CatalogResourceSchema,
    handler: async (args: z.infer<typeof CatalogResourceSchema>) => {
      const skill = getCatalogSkill(args.id);
      if (!skill) {
        return { error: `Skill not found: ${args.id}`, found: false };
      }
      if (!skill.skillMdPath) {
        return {
          error: `No local file tree for this skill (source=${skill.source})`,
          found: false,
        };
      }

      const fs = await import("node:fs");

      // Path containment check (shared with the REST route — no drift).
      const requested = resolveContainedResource(skill.skillMdPath, args.path);
      if (requested === null) {
        return { error: "Path traversal denied", found: false };
      }

      if (!fs.existsSync(requested)) {
        return { error: `File not found: ${args.path}`, found: false };
      }

      const stat = fs.statSync(requested);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(requested);
        return { found: true, path: args.path, type: "directory", entries };
      }

      // Size limit: 1MB
      if (stat.size > 1_000_000) {
        return { error: "File exceeds 1MB limit", found: false };
      }

      const content = fs.readFileSync(requested, "utf8");
      return { found: true, path: args.path, type: "file", content };
    },
  },

  omr_catalog_execute: {
    name: "omr_catalog_execute",
    description:
      "Execute a registered, approved skill operation. Only built-in skills mapped to " +
      "registered handlers are executable; instruction-only imported skills return a " +
      "clear non-executable result. Requires execute:skills scope.",
    scopes: ["execute:skills"],
    inputSchema: CatalogExecuteSchema,
    handler: async (args: z.infer<typeof CatalogExecuteSchema>, extra?: McpToolExtraLike) => {
      const skill = getCatalogSkill(args.id);
      if (!skill) {
        return { error: `Skill not found: ${args.id}`, executed: false };
      }

      if (!skill.executable) {
        return {
          executed: false,
          reason:
            skill.source === "imported"
              ? "Imported skills are instruction-only and not registered for execution. Use omr_catalog_load to read the instructions."
              : "This skill is not registered as executable.",
          id: skill.id,
          name: skill.name,
        };
      }

      const ownerId = (await resolveMcpToolOwnerId(extra, args.apiKeyId)) ?? GLOBAL_SKILL_OWNER_ID;
      const skillName = skill.id.replace(/^builtin:/, "");
      const input = args.input ?? {};

      try {
        const execution = await skillExecutor.execute(skillName, input, {
          apiKeyId: ownerId,
        });
        return {
          executed: true,
          id: skill.id,
          name: skill.name,
          status: execution.status,
          output: execution.output,
          error: execution.errorMessage,
          durationMs: execution.durationMs,
        };
      } catch (err) {
        return {
          executed: false,
          id: skill.id,
          name: skill.name,
          error: err instanceof Error ? err.message : "Execution failed",
        };
      }
    },
  },
};

export function listCatalogDomains() {
  return listDomains();
}
