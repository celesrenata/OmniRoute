/**
 * /api/skills/catalog/refresh — trigger a new catalog snapshot.
 *
 *   POST (no body) → rescan built-in + imported skill roots from disk,
 *                    snapshot the resulting composition into the durable
 *                    `skill_snapshots` table (30-day retention), purge
 *                    expired snapshots, and return the summary + snapshot id.
 *
 * This is the operator/AI trigger for the snapshot lifecycle: skill
 * add/update/delete also create snapshots automatically, but an operator who
 * re-imports skill zips out-of-band (or wants a clean baseline) can force a
 * fresh snapshot without restarting the process.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  snapshotCatalog,
  catalogSummary,
  invalidateCatalog,
} from "@omniroute/open-sse/services/skillDiscovery";
import { purgeExpired } from "@/lib/db/skillSnapshots";
import { skillsServiceDisabled, skillServiceDisabledResponse } from "@/lib/skills/serviceGate";

export async function POST(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  if (await skillsServiceDisabled()) return skillServiceDisabledResponse();

  try {
    const snapshotId = snapshotCatalog("manual-refresh", { rescan: true });
    invalidateCatalog();
    const purged = purgeExpired();
    return NextResponse.json({
      success: true,
      snapshotId,
      purged,
      summary: catalogSummary(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "snapshot failed";
    return NextResponse.json({ error: { code: "SNAPSHOT_FAILED", message } }, { status: 500 });
  }
}
