/**
 * src/lib/skills/serviceGate.ts — whole-skill-service on/off gate.
 *
 * `settings.skillsEnabled` (default true) is the operator's master switch for
 * the skill subsystem: discovery, execution and catalog management. When off,
 * the skill routes answer 503 with a structured body so clients can tell a
 * disabled service apart from a real failure. The settings route itself is
 * NOT gated (the toggle must stay reachable to switch the service back on).
 */
import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db/settings";

export async function skillsServiceDisabled(): Promise<boolean> {
  try {
    const settings = await getSettings();
    return settings.skillsEnabled === false;
  } catch {
    // Settings read failure is not the same as "disabled" — fall through to
    // normal behavior (fail-open: the executor keeps its own gate).
    return false;
  }
}

export function skillServiceDisabledResponse(): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: "SKILLS_DISABLED",
        message: "Skills service is disabled. Enable it in Settings (skillsEnabled) to use skills.",
      },
    },
    { status: 503 }
  );
}
