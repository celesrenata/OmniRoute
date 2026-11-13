/**
 * /api/skills/hub — REST client path for Skill Hub management (mirrors the MCP
 * tools omr_skill_install / omr_skill_remove; both call src/lib/skills/skillAdmin.ts).
 *
 *   POST   { name, description, content, domain?, version?, tags?, overwrite? }
 *            → install an instruction-only SKILL.md skill (never executable)
 *   DELETE ?id=imported:<domain>/<slug>  → remove an imported skill
 *
 * Auth: `write:skills` (or manage/admin). A least-privilege secondary management
 * key is [mcp:connect, read:catalog, write:skills]. Enable/disable stays on
 * POST /api/skills/catalog/[id]/toggle. Executable skills (handlerCode) are NOT
 * accepted here — they remain on LOCAL_ONLY /api/skills/install with `manage`.
 */
import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { skillsServiceDisabled, skillServiceDisabledResponse } from "@/lib/skills/serviceGate";
import { SkillAdminError, installSkill, removeSkill } from "@/lib/skills/skillAdmin";
import { errorResponse } from "@omniroute/open-sse/utils/error";

function toErrorResponse(err: unknown): Response {
  if (err instanceof SkillAdminError) return errorResponse(err.status, err.message);
  return errorResponse(500, "Skill operation failed");
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { acceptSkillsScope: "write" });
  if (authError) return authError;
  if (await skillsServiceDisabled()) return skillServiceDisabledResponse();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  try {
    return NextResponse.json(installSkill(body));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request, { acceptSkillsScope: "write" });
  if (authError) return authError;
  if (await skillsServiceDisabled()) return skillServiceDisabledResponse();
  const id = new URL(request.url).searchParams.get("id") ?? "";
  try {
    return NextResponse.json(removeSkill({ id }));
  } catch (err) {
    return toErrorResponse(err);
  }
}
