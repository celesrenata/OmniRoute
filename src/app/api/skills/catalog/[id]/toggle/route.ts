/**
 * /api/skills/catalog/[id]/toggle — per-skill enable/disable for catalog skills.
 *
 * Catalog skills (builtin:<name>, imported:<domain>/<slug>) are enabled by
 * default; toggling one off hides it from discovery (search/browse/load)
 * across the catalog until toggled back on. State is durable (WP6 table
 * `skill_catalog_state`) and survives restarts.
 *
 *   POST { enabled: boolean }   → toggle this skill's visibility
 *
 * Toggling invalidates the in-process visibility cache for immediate effect.
 * This is a visibility control, NOT a composition change — it deliberately
 * does not create a new catalog snapshot (snapshots track composition, which
 * only changes when a skill is added/updated/deleted).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { setCatalogSkillEnabled, isCatalogSkillEnabled } from "@/lib/db/skillHub";
import { invalidateCatalog } from "@omniroute/open-sse/services/skillDiscovery";
import { skillsServiceDisabled, skillServiceDisabledResponse } from "@/lib/skills/serviceGate";
import { z } from "zod";

const toggleSchema = z.object({
  enabled: z.boolean(),
});

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  if (await skillsServiceDisabled()) return skillServiceDisabledResponse();

  const { id } = await props.params;
  // Catalog ids are the URL-decoded skill id (e.g. "imported:devops/CI-CD").
  const skillId = decodeURIComponent(id);

  try {
    const body = await request.json();
    const parsed = toggleSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: "expected { enabled: boolean }",
          },
        },
        { status: 400 }
      );
    }

    const enabled = parsed.data.enabled;
    setCatalogSkillEnabled(skillId, enabled);
    invalidateCatalog();

    return NextResponse.json({
      success: true,
      skillId,
      enabled: isCatalogSkillEnabled(skillId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to toggle skill visibility";
    return NextResponse.json({ error: { code: "TOGGLE_FAILED", message } }, { status: 500 });
  }
}
