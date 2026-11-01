/**
 * /api/skills/catalog/skillsets — WP6 (Skill Hub) filter chips for the dashboard
 * Skill Hub view.
 *
 * Returns the LIVE domain distribution of the visible catalog (builtin +
 * imported), so the sidebar always mirrors the catalog as it is on disk —
 * not the DB-snapshotted seed collections, which go stale when the catalog
 * is reorganized (e.g. a frontmatter domain reorg at import time). Each chip
 * carries the domain slug as `id`; clicking it filters the grid via the
 * search filter's `s.domain === skillset` fallback in searchCatalog().
 *
 * Same `requireManagementAuth` flow as the rest of /api/skills/catalog*.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { listSkillsetFilters } from "@omniroute/open-sse/services/skillDiscovery";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export async function GET(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const skillsets = listSkillsetFilters();
    return NextResponse.json({ count: skillsets.length, skillsets });
  } catch (err) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
