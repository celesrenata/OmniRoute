/**
 * skillDiscoveryTools.ts — AI-side skill discovery + catalog refresh (WP6).
 *
 * Fixed, constant tool surface (independent of catalog size):
 *   - omr_skill_search   (read:catalog) — full-text search over the skill
 *     catalog (built-in + imported), returns concise summaries only.
 *   - omr_skill_get      (read:catalog) — one skill's metadata + SKILL.md
 *     (bounded to 50KB).
 *   - omr_skill_list     (read:catalog) — browse the catalog: by domain /
 *     skillset / tag, with count and the available domains.
 *   - omr_catalog_refresh (write:skills) — force a re-scan of the skill roots
 *     and create a durable catalog snapshot (30-day retention).
 *
 * These complement `omr_catalog_*` (WP4): the catalog_* tools are the
 * execution-focused bridge (search/load/resource/execute); the skill_* tools
 * are the discovery-first surface an AI uses to *find* what is available
 * before asking for load or execute. Search results never include full skill
 * content — call omr_skill_get (or omr_catalog_load) for the body.
 */
import { z } from "zod";
import {
  searchCatalog,
  loadSkill,
  catalogSummary,
  listDomains,
  invalidateCatalog,
  type SearchResult,
} from "../../services/skillDiscovery.ts";
import { snapshotCatalog } from "../../services/skillDiscovery.ts";
import { skillRegistry } from "@/lib/skills/registry";
import { purgeExpired } from "@/lib/db/skillSnapshots";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
import type { McpToolExtraLike } from "../scopeEnforcement.ts";

// ── Schemas ─────────────────────────────────────────────────────────────────

export const SkillSearchSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe("Free-text query against skill name/description/tags/domain"),
  domain: z
    .string()
    .optional()
    .describe("Restrict to one skillset/domain (e.g. 'devops', 'security')"),
  skillset: z
    .string()
    .optional()
    .describe("Restrict to one skillset collection slug (WP6 durable skillsets)"),
  tag: z.string().optional().describe("Restrict to one capability tag"),
  limit: z.number().int().min(1).max(20).optional(),
  agentId: z
    .string()
    .optional()
    .describe(
      "Optional explicit per-agent principal id (WP6 per-agent skillset grants, fail-closed)"
    ),
});

export const SkillGetSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("Catalog skill id, e.g. 'builtin:omni-inference' or 'imported:devops/CI-CD'"),
});

export const SkillListSchema = z.object({
  domain: z.string().optional().describe("List only skills in this domain"),
  skillset: z.string().optional().describe("List only skills in this skillset collection"),
  tag: z.string().optional().describe("List only skills with this capability tag"),
  limit: z.number().int().min(1).max(200).optional(),
  agentId: z
    .string()
    .optional()
    .describe(
      "Optional explicit per-agent principal id (WP6 per-agent skillset grants, fail-closed)"
    ),
});

export const CatalogRefreshSchema = z.object({
  origin: z
    .string()
    .max(100)
    .optional()
    .describe('Provenance label for the snapshot (default "ai-refresh")'),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function summarize(results: SearchResult[]) {
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    domain: r.domain,
    source: r.source,
    executable: r.executable,
    score: r.score,
  }));
}

/**
 * Resolve the per-agent principal for WP6 grants: an explicit `agentId`
 * wins; otherwise the caller's own API key principal when the
 * SKILL_HUB_AGENT_POLICY flag is on. No flag + no explicit agentId → the
 * full catalog (legacy permissive behavior).
 */
async function resolveAgentId(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  if (!isFeatureFlagEnabled("SKILL_HUB_AGENT_POLICY")) return undefined;
  try {
    const { resolveMcpCallerApiKeyId } = await import("../mcpCallerIdentity.ts");
    return await resolveMcpCallerApiKeyId();
  } catch {
    return undefined;
  }
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const skillDiscoveryTools = {
  omr_skill_search: {
    name: "omr_skill_search",
    description:
      "Full-text search over the OmniRoute skill catalog (built-in + imported skills) with weighted lexical ranking. " +
      "Returns up to `limit` concise summaries (id, name, description, domain, source, executable flag, score) — NO skill content. " +
      "Use omr_skill_get to fetch the full SKILL.md for a result, or omr_catalog_execute to run an executable skill.",
    scopes: ["read:catalog"],
    inputSchema: SkillSearchSchema,
    handler: async (args: z.infer<typeof SkillSearchSchema>, _extra?: McpToolExtraLike) => {
      const agentId = await resolveAgentId(args.agentId);
      const results = searchCatalog(args.query, {
        limit: args.limit,
        domain: args.domain,
        skillset: args.skillset,
        tag: args.tag,
        agentId,
      });
      return { count: results.length, results: summarize(results) };
    },
  },

  omr_skill_get: {
    name: "omr_skill_get",
    description:
      "Get one skill from the OmniRoute skill catalog by catalog id: metadata (name, description, domain, tags, source, executable, revision) " +
      "plus its full SKILL.md content bounded to 50KB. Returns found:false when the skill does not exist or is hidden by the operator.",
    scopes: ["read:catalog"],
    inputSchema: SkillGetSchema,
    handler: async (args: z.infer<typeof SkillGetSchema>, _extra?: McpToolExtraLike) => {
      const agentId = await resolveAgentId();
      if (agentId) {
        // Per-agent policy on: the skill must be in a granted skillset.
        const { getCatalogSkill } = await import("../../services/skillDiscovery.ts");
        const skill = getCatalogSkill(args.id);
        if (!skill) return { found: false, error: `Skill not found: ${args.id}` };
        const { discoverDomainsForAgent } = await import("@/lib/db/skillHub.ts");
        const granted = discoverDomainsForAgent(agentId);
        if (granted === null) {
          return { found: false, error: "No accessible skillsets for this agent" };
        }
        if (!granted.includes(skill.domain) && !granted.includes(skill.id)) {
          return { found: false, error: "Skill not in an accessible skillset for this agent" };
        }
      }
      const loaded = loadSkill(args.id);
      if (!loaded) return { found: false, error: `Skill not found: ${args.id}` };
      const { skill, content } = loaded;
      return {
        found: true,
        id: skill.id,
        name: skill.name,
        description: skill.description,
        domain: skill.domain,
        tags: skill.tags,
        source: skill.source,
        executable: skill.executable,
        revision: skill.revision,
        markdown: content,
      };
    },
  },

  omr_skill_list: {
    name: "omr_skill_list",
    description:
      "Browse the OmniRoute skill catalog (no query required). Optionally filter by domain / skillset / tag. " +
      "Returns the available domains (with counts), the total composition (builtin vs imported), and up to `limit` skill summaries.",
    scopes: ["read:catalog"],
    inputSchema: SkillListSchema,
    handler: async (args: z.infer<typeof SkillListSchema>, _extra?: McpToolExtraLike) => {
      const agentId = await resolveAgentId(args.agentId);
      const results = searchCatalog("", {
        limit: args.limit ?? 100,
        domain: args.domain,
        skillset: args.skillset,
        tag: args.tag,
        agentId,
      });
      return {
        domains: listDomains(),
        summary: catalogSummary(),
        count: results.length,
        results: summarize(results),
      };
    },
  },

  omr_catalog_refresh: {
    name: "omr_catalog_refresh",
    description:
      "Re-scan the skill roots (built-in + imported) and create a durable catalog snapshot with 30-day retention. " +
      "Also purges expired snapshots. Use after out-of-band skill imports or to establish a clean baseline. " +
      "Returns the snapshot id, the purged count, and the fresh composition summary.",
    scopes: ["write:skills"],
    inputSchema: CatalogRefreshSchema,
    handler: async (args: z.infer<typeof CatalogRefreshSchema>, _extra?: McpToolExtraLike) => {
      const registered = skillRegistry
        .list()
        .filter((s) => s.enabled)
        .map((s) => ({ name: s.name, version: s.version }));
      const snapshotId = snapshotCatalog(args.origin ?? "ai-refresh", {
        rescan: true,
        registered,
      });
      invalidateCatalog();
      const purged = purgeExpired();
      return {
        success: true,
        snapshotId,
        purged,
        summary: catalogSummary(),
      };
    },
  },
};
