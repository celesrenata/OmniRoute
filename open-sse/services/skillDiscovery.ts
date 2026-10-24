/**
 * skillDiscovery.ts — WP4 (Skill Hub): SkillDiscoveryService.
 *
 * Search-and-selection layer for the Skill Hub catalog. Separate from
 * `SkillExecutor` (which runs registered handler skills). This service
 * produces ranked, permission-scoped *summaries* for agents to browse, and
 * loads full content only after explicit selection.
 *
 * Design (per spec §A2):
 *   - Candidate generation: weighted lexical scoring over name, description,
 *     tags, domain, and a bounded textual synopsis.
 *   - Rank: weighted lexical score + name-affinity boost + domain affinity.
 *     Component scores are explainable.
 *   - Reject: no-match/low-confidence hits; quarantined skills.
 *   - Return: 5–10 short results with opaque identifiers and score/reason.
 *
 * The catalog has two sources:
 *   1. Built-in curated Agent Skills (from `src/lib/agentSkills/catalog.ts`).
 *   2. Third-party skills imported via the WP3 importer (scanned from the
 *      agent skill root on disk).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { getCatalog } from "@/lib/agentSkills/catalog.ts";
import { parseSkillMarkdown } from "@/lib/agentSkills/importer.ts";
// WP6 durable skill tables. Imported statically — skillHub only calls
// getDbInstance() inside function bodies, so this module still loads in
// DB-free test contexts (the functions are simply no-ops when not called).
import { discoverDomainsForAgent, collectionMembers } from "@/lib/db/skillHub.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CatalogSkill {
  /** Stable opaque identifier (hash of source + slug). */
  id: string;
  name: string;
  description: string;
  /** Source domain (from frontmatter or pack-level default). */
  domain: string;
  /**
   * Tags for skillset filtering. Imported skills carry their frontmatter
   * tags; built-in skills are mapped from category/area.
   */
  tags: string[];
  /**
   * Origin: "builtin" (curated catalog) or "imported" (third-party pack).
   */
  source: "builtin" | "imported";
  /**
   * Revision / version string. "builtin" skills use their catalog version;
   * imported skills use frontmatter version or "0.0.0".
   */
  revision: string;
  /**
   * Whether this skill can be executed via `omr_catalog_execute`.
   * Built-in skills map to registered handler skills; imported instruction-
   * only skills return `false`.
   */
  executable: boolean;
  /**
   * Absolute path to the skill's SKILL.md (for loaded content).
   * Empty for built-in skills without a local SKILL.md file.
   */
  skillMdPath: string;
  /**
   * Quarantine flag (imported skills that tripped a hard-block pattern).
   * Quarantined skills are excluded from search results.
   */
  quarantined: boolean;
  /**
   * License if known.
   */
  license: string | null;
}

export interface SearchResult {
  id: string;
  name: string;
  description: string;
  domain: string;
  revision: string;
  tags: string[];
  source: CatalogSkill["source"];
  /** Total composite score (0–1). 0 for browse-all results (no ranking). */
  score: number;
  /** Explainable component scores. `null` for browse-all (no query) results. */
  reason: {
    nameMatch: number;
    descriptionMatch: number;
    tagMatch: number;
    domainAffinity: number;
  } | null;
}

export interface SearchOptions {
  /** Max results to return (default 10, max 20). */
  limit?: number;
  /** Filter by skillset / domain (exact match). */
  domain?: string;
  /**
   * Filter by a skillset (collection) id — e.g. a seed skillset slug
   * ("devops", "frontend", …). Skills in that collection are kept. Only
   * applied when collections are registered (WP6 durable tables).
   */
  skillset?: string;
  /** Filter by capability tag. */
  tag?: string;
  /** Only return executable skills. */
  executableOnly?: boolean;
  /** Minimum score threshold (0–1). Default 0.1. */
  minScore?: number;
  /**
   * Per-agent policy (WP6). When present, results are restricted to the
   * skillsets (domains) this agent has been GRANTED. Fail-closed: an agent
   * with no grants gets an empty result set — missing trusted scope means
   * reject, never global.
   *
   * Passing `agentId` is an explicit opt-in to the policy. The MCP / REST
   * boundary only resolves & passes the caller's agent id when the
   * `SKILL_HUB_AGENT_POLICY` flag is ON; with the flag OFF it omits `agentId`
   * entirely, preserving the legacy permissive (full-catalog) behavior.
   */
  agentId?: string;
}

// ── Tokenization & scoring ──────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * BM25-lite: score how well `query` matches `haystack`.
 * Returns a float in [0, 1]. 0 = no overlap.
 */
function lexScore(query: string, haystack: string, fieldWeight: number): number {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return 0;
  const hTokens = new Set(tokenize(haystack));
  if (hTokens.size === 0) return 0;

  // Count overlap.
  let hits = 0;
  for (const t of qTokens) {
    if (hTokens.has(t)) hits++;
  }

  // Coverage: fraction of query tokens found in haystack.
  const coverage = hits / qTokens.size;
  // Weighted by field importance and dampened by haystack size (avoid
  // keyword-stuffed long descriptions inflating score).
  const sizeDamp = Math.min(1, 20 / Math.max(hTokens.size, 1));
  return Math.min(1, coverage * fieldWeight * sizeDamp);
}

// ── Catalog loading ─────────────────────────────────────────────────────────

const DEFAULT_SKILL_ROOT = path.join(os.homedir(), ".opencode", "skills");

/**
 * Load the full unified catalog (built-in + imported).
 * Results are cached per-process; call `refreshCatalogIndex()` after imports.
 */
let _cache: CatalogSkill[] | null = null;

function loadBuiltInSkills(): CatalogSkill[] {
  const catalog = getCatalog();
  return catalog.map((s) => ({
    id: `builtin:${s.id}`,
    name: s.name,
    description: s.description,
    domain: s.area,
    tags: [s.category, s.area],
    source: "builtin" as const,
    revision: "1.0.0",
    executable: true, // built-in skills map to registered handler skills
    skillMdPath: "", // loaded from URL or generated
    quarantined: false,
    license: null,
  }));
}

function loadImportedSkills(root: string): CatalogSkill[] {
  if (!fs.existsSync(root)) return [];

  const results: CatalogSkill[] = [];
  let count = 0;

  const walk = (dir: string, domain: string) => {
    if (count >= 5000) return; // cap for safety
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("__MACOSX") || entry.name.startsWith(".")) continue;

      const skillDir = path.join(dir, entry.name);
      const skillMd = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillMd)) {
        // Recurse (skill may be nested one level deeper)
        walk(skillDir, domain);
        continue;
      }

      count++;
      try {
        const raw = fs.readFileSync(skillMd, "utf8");
        const { frontmatter } = parseSkillMarkdown(raw);
        const name = frontmatter?.name || entry.name;
        const description = frontmatter?.description || "";
        const skillDomain = frontmatter?.domain || domain;
        const tags = frontmatter?.tags?.filter((t): t is string => typeof t === "string") ?? [];
        const version = frontmatter?.version || "0.0.0";
        const license = frontmatter?.license || null;
        const slug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");

        results.push({
          id: `imported:${skillDomain}/${slug}`,
          name,
          description,
          domain: skillDomain,
          tags,
          source: "imported",
          revision: version,
          executable: false, // imported skills are instruction-only until registered
          skillMdPath: skillMd,
          quarantined: false,
          license,
        });
      } catch {
        // Skip unparseable skills
      }
    }
  };

  walk(root, "general");
  return results;
}

function ensureCache(): CatalogSkill[] {
  if (_cache) return _cache;
  const builtIn = loadBuiltInSkills();
  const imported = loadImportedSkills(DEFAULT_SKILL_ROOT);
  _cache = [...builtIn, ...imported];
  return _cache;
}

export function refreshCatalogIndex(): void {
  _cache = null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Search the unified catalog with weighted lexical scoring.
 * Returns ranked, bounded results (5–10 by default).
 */
export function searchCatalog(query: string, options: SearchOptions = {}): SearchResult[] {
  const trimmed = query.trim();
  const { domain, skillset, tag, executableOnly, minScore = 0.1, agentId } = options;
  // Empty query = "browse all" (dashboard catalog view). Instead of scoring,
  // return the filtered catalog (agent policy + domain/skillset/tag/executable
  // still apply) in a stable name order, with no lexical min-score gate. A
  // higher default cap applies since there is no relevance ranking to prune by.
  const browsing = trimmed.length === 0;
  const limit = options.limit ?? (browsing ? 200 : 10);
  const effectiveLimit = Math.min(limit, browsing ? 200 : 20);

  const catalog = ensureCache().filter((s) => !s.quarantined);

  // Per-agent policy (WP6) — applied FIRST, fail-closed. An agent that has
  // grants sees only the skillsets it was granted; an agent with no grants gets
  // nothing (missing trusted scope = reject, not global). No agentId → legacy
  // permissive behavior (no policy applied).
  let scoped = catalog;
  if (agentId) {
    const granted = discoverDomainsForAgent(agentId);
    if (granted === null) return [];
    const allowed = new Set(granted);
    scoped = scoped.filter((s) => allowed.has(s.domain) || allowed.has(s.id));
  }

  // Pre-filter by domain / skillset / tag / executable before scoring.
  let candidates = scoped;
  if (domain) {
    candidates = candidates.filter((s) => s.domain === domain);
  }
  if (skillset) {
    // A skillset (collection) maps to a domain slug for the seed skillsets;
    // named collections hold explicit members matched by skill id.
    const memberIds = new Set(collectionMembers(skillset));
    candidates = candidates.filter((s) => memberIds.has(s.id) || s.domain === skillset);
  }
  if (tag) {
    candidates = candidates.filter((s) => s.tags.includes(tag));
  }
  if (executableOnly) {
    candidates = candidates.filter((s) => s.executable);
  }

  if (browsing) {
    // No relevance ranking — stable name order, full (capped) set. Agent
    // policy + domain/skillset/tag/executable filters still applied above.
    return [...candidates]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, effectiveLimit)
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description.slice(0, 300),
        domain: skill.domain,
        revision: skill.revision,
        tags: skill.tags,
        source: skill.source,
        score: 0,
        reason: null,
      }));
  }

  const scored: SearchResult[] = [];
  for (const skill of candidates) {
    const nameMatch = lexScore(query, skill.name, 0.4);
    const descriptionMatch = lexScore(query, skill.description, 0.35);
    const tagMatch = lexScore(query, skill.tags.join(" "), 0.15);
    const domainAffinity = domain ? (skill.domain === domain ? 0.1 : 0) : 0;

    const total = nameMatch + descriptionMatch + tagMatch + domainAffinity;
    if (total < minScore) continue;

    scored.push({
      id: skill.id,
      name: skill.name,
      description: skill.description.slice(0, 300),
      domain: skill.domain,
      revision: skill.revision,
      tags: skill.tags,
      source: skill.source,
      score: Math.min(1, total),
      reason: {
        nameMatch: Math.round(nameMatch * 100) / 100,
        descriptionMatch: Math.round(descriptionMatch * 100) / 100,
        tagMatch: Math.round(tagMatch * 100) / 100,
        domainAffinity: Math.round(domainAffinity * 100) / 100,
      },
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, effectiveLimit);
}

/**
 * Load a skill's full content by ID. Returns the full SKILL.md text and
 * metadata. Bounded to ~50KB to avoid context bloat.
 */
export function loadSkill(id: string): { content: string; skill: CatalogSkill } | null {
  const catalog = ensureCache();
  const skill = catalog.find((s) => s.id === id);
  if (!skill) return null;

  let content: string;
  if (skill.source === "imported" && skill.skillMdPath) {
    try {
      content = fs.readFileSync(skill.skillMdPath, "utf8");
    } catch {
      content = `[error reading skill file: ${skill.skillMdPath}]`;
    }
  } else {
    // Built-in: fetch from URL is out of scope for this sync method.
    // Return the catalog description as a placeholder.
    content = `# ${skill.name}\n\n${skill.description}\n\n(domain: ${skill.domain}, tags: ${skill.tags.join(", ")})`;
  }

  // Bound to 50KB
  if (content.length > 50_000) {
    content = content.slice(0, 50_000) + "\n\n[truncated at 50KB]";
  }

  return { content, skill };
}

/**
 * Get a skill by ID (metadata only, no full content).
 */
export function getCatalogSkill(id: string): CatalogSkill | null {
  return ensureCache().find((s) => s.id === id) ?? null;
}

/**
 * Resolve a requested resource path to an absolute path contained within the
 * skill's directory. Returns `null` when the path escapes the skill directory
 * (traversal attempt) — callers must fail closed on null.
 *
 * This is shared by both the MCP `omr_catalog_resource` tool and the REST
 * catalog route so the containment rule cannot drift between the two.
 */
export function resolveContainedResource(skillMdPath: string, requestPath: string): string | null {
  const skillDir = path.dirname(skillMdPath);
  const requested = path.resolve(skillDir, requestPath);
  if (requested !== skillDir && !requested.startsWith(skillDir + path.sep)) {
    return null;
  }
  return requested;
}

/**
 * List available domains / skillsets in the catalog.
 */
export function listDomains(): { domain: string; count: number }[] {
  const catalog = ensureCache().filter((s) => !s.quarantined);
  const map = new Map<string, number>();
  for (const s of catalog) {
    map.set(s.domain, (map.get(s.domain) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count);
}
