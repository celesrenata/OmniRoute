/**
 * GET /api/scripts/search - Search scripts by query
 */
import { NextResponse } from "next/server";
import { isLocalOnlyPath } from "@/server/authz/routeGuard";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { ScriptVaultManager } from "@/lib/scripts/scriptVault";

export async function GET(request: Request) {
  // Check if this is a local-only endpoint
  if (isLocalOnlyPath(new URL(request.url).pathname, "GET")) {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
  }

  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q") || "";
    const limit = parseInt(searchParams.get("limit") || "20", 10);

    if (!query.trim()) {
      return NextResponse.json({ scripts: [], total: 0 });
    }

    const scripts = await ScriptVaultManager.search(query, limit);

    return NextResponse.json({ scripts, total: scripts.length });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to search scripts", details: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}
