/**
 * /api/skills/catalog/skillsets — WP6 (Skill Hub) list of visible skillsets
 * (seed + named collections) with membership counts. Additive, read-only; used
 * by the dashboard Skill Hub view to render the skillset filter chips.
 *
 * Same `requireManagementAuth` flow as the rest of /api/skills/catalog*.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { listSkillsets } from "@/lib/db/skillHub";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export async function GET(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const skillsets = listSkillsets();
    return NextResponse.json({ count: skillsets.length, skillsets });
  } catch (err) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
