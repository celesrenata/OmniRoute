/**
 * /api/skills/catalog — WP4 (Skill Hub) REST surface for Skill Discovery.
 *
 * Mirrors the four fixed MCP tools (`omr_catalog_*`) as additive REST:
 *
 *   GET  ?query=...&limit=...&skillset=...   → omr_catalog_search
 *   POST { action: "load",     id, revision? }   → omr_catalog_load
 *   POST { action: "resource", id, path, revision? } → omr_catalog_resource
 *   POST { action: "execute",  id, operation?, input? } → omr_catalog_execute
 *
 * MCP remains the primary server-owned interface; this REST layer is additive
 * for clients that need a plain HTTP endpoint. Authentication uses the same
 * `requireManagementAuth` flow as the rest of /api/skills/*.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { extractApiKey } from "@/sse/services/auth";
import {
  catalogSummary,
  searchCatalog,
  loadSkill,
  getCatalogSkill,
  resolveContainedResource,
} from "@omniroute/open-sse/services/skillDiscovery";
import { skillExecutor } from "@/lib/skills/executor";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

const MAX_LIMIT = 20;
const MAX_RESOURCE_BYTES = 1_000_000;

// ── GET: search ──────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { searchParams } = new URL(request.url);
  // An empty/absent `query` is a valid "browse all" request (dashboard catalog
  // view). It returns the whole (filterable) catalog rather than a lexical
  // search, so a higher cap applies than for relevance-ranked search results.
  const query = searchParams.get("query")?.trim() ?? "";
  // Browse-all must be able to return the whole catalog (operator imports
  // can hold ~1k skills); relevance-ranked search stays at MAX_LIMIT.
  const maxLimit = query ? MAX_LIMIT : 2000;

  try {
    const limitRaw = searchParams.get("limit");
    const limit = limitRaw
      ? Math.min(Math.max(parseInt(limitRaw, 10) || 10, 1), maxLimit)
      : query
        ? 10
        : 2000;
    const domain = searchParams.get("domain");
    const skillset = searchParams.get("skillset");
    const tag = searchParams.get("tag");
    const agentId = searchParams.get("agentId");

    const results = searchCatalog(query, {
      limit,
      domain: domain || undefined,
      skillset: skillset || undefined,
      tag: tag || undefined,
      agentId: agentId || undefined,
      executableOnly: searchParams.get("executableOnly") === "true",
    });
    // The count should reflect the actual total in the catalog, not the truncated
    // number of results returned (which is bounded by `limit`). This matches the
    // dashboard's expectation that `count` is the full catalog size. Use
    // `catalogSummary()` which already computes and returns `total`.
    const total = catalogSummary().total;
    return NextResponse.json({ query, count: total, results });
  } catch (err) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── POST: load / resource / execute ─────────────────────────────────────────

export async function POST(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body.action;
  const id = typeof body.id === "string" ? body.id : undefined;
  if (!id) {
    return NextResponse.json({ error: "Missing required 'id' field" }, { status: 400 });
  }

  try {
    if (action === "load") {
      const loaded = loadSkill(id);
      if (!loaded)
        return NextResponse.json(
          { found: false, error: `Skill not found: ${id}` },
          { status: 404 }
        );
      const { skill, content } = loaded;
      return NextResponse.json({
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
      });
    }

    if (action === "resource") {
      const path = typeof body.path === "string" ? body.path : undefined;
      if (!path)
        return NextResponse.json({ error: "Missing required 'path' field" }, { status: 400 });

      const skill = getCatalogSkill(id);
      if (!skill)
        return NextResponse.json(
          { found: false, error: `Skill not found: ${id}` },
          { status: 404 }
        );
      if (!skill.skillMdPath) {
        return NextResponse.json({
          found: false,
          error: `No local file tree for this skill (source=${skill.source})`,
        });
      }

      const fs = await import("node:fs");
      const requested = resolveContainedResource(skill.skillMdPath, path);
      if (requested === null) {
        return NextResponse.json({ error: "Path traversal denied" }, { status: 400 });
      }
      if (!fs.existsSync(requested)) {
        return NextResponse.json({ error: `File not found: ${path}` }, { status: 404 });
      }
      const stat = fs.statSync(requested);
      if (stat.isDirectory()) {
        return NextResponse.json({ path, type: "directory", entries: fs.readdirSync(requested) });
      }
      if (stat.size > MAX_RESOURCE_BYTES) {
        return NextResponse.json({ error: "File exceeds 1MB limit" }, { status: 400 });
      }
      return NextResponse.json({ path, type: "file", content: fs.readFileSync(requested, "utf8") });
    }

    if (action === "execute") {
      const skill = getCatalogSkill(id);
      if (!skill)
        return NextResponse.json(
          { executed: false, error: `Skill not found: ${id}` },
          { status: 404 }
        );
      if (!skill.executable) {
        return NextResponse.json({
          executed: false,
          reason:
            skill.source === "imported"
              ? "Imported skills are instruction-only and not registered for execution."
              : "This skill is not registered as executable.",
        });
      }

      const apiKeyId = extractApiKey(request) ?? "system";
      const skillName = skill.id.replace(/^builtin:/, "");
      const input = (body.input as Record<string, unknown>) ?? {};

      try {
        const execution = await skillExecutor.execute(skillName, input, { apiKeyId });
        return NextResponse.json({
          executed: true,
          id: skill.id,
          name: skill.name,
          status: execution.status,
          output: execution.output,
          error: execution.errorMessage,
          durationMs: execution.durationMs,
        });
      } catch (err) {
        // The catalog `executable` flag is a per-process claim; the registry is
        // the source of truth. If the executor can't resolve the name (no
        // registered skill, or one that's disabled) that is a 404 for the
        // caller, not a server fault — never fall through to the outer 500.
        // `skillName` is a sanitized catalog slug, safe to echo verbatim.
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Skill not found:") || message.startsWith("Skill is disabled:")) {
          return NextResponse.json(
            {
              executed: false,
              found: false,
              error: `Skill not found: ${skillName}`,
            },
            { status: 404 }
          );
        }
        return NextResponse.json(
          { executed: false, error: sanitizeErrorMessage(message) },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ error: `Unknown action: ${String(action)}` }, { status: 400 });
  } catch (err) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
