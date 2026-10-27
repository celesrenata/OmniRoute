/**
 * /api/skills/service/toggle — master switch for the whole skill service
 * (settings.skillsEnabled).
 *
 *   GET            → { enabled: boolean }
 *   POST { enabled: boolean } → toggle the service on/off
 *
 * The Skill Hub page renders this as a switch so the operator can disable the
 * skill subsystem (discovery + execution + catalog) and re-enable it without
 * leaving the page.
 *
 * Deliberately NOT gated by skillsServiceDisabled(): a disabled service must
 * not be able to lock the operator out of the switch that re-enables it — the
 * same rationale the settings route follows (see src/lib/skills/serviceGate.ts).
 * Auth still requires management (requireManagementAuth).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getSettings, updateSettings } from "@/lib/db/settings";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { z } from "zod";

const toggleSchema = z.object({
  enabled: z.boolean(),
});

export async function GET(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const settings = await getSettings();
    return NextResponse.json({ enabled: settings.skillsEnabled !== false });
  } catch (err: unknown) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: { message } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "expected { enabled: boolean }" } },
      { status: 400 }
    );
  }
  const parsed = toggleSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "expected { enabled: boolean }" } },
      { status: 400 }
    );
  }

  try {
    await updateSettings({ skillsEnabled: parsed.data.enabled });
    return NextResponse.json({ success: true, enabled: parsed.data.enabled });
  } catch (err: unknown) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: { message } }, { status: 500 });
  }
}
