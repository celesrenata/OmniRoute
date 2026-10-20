/**
 * GET /api/scripts - List all scripts in the vault
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
    const tags = searchParams.getAll("tag") || [];
    const status = searchParams.get("status") as "active" | "deprecated" | "archived" | null;
    const limit = parseInt(searchParams.get("limit") || "20", 10);
    const offset = parseInt(searchParams.get("offset") || "0", 10);

    const { scripts, total } = await ScriptVaultManager.listScripts({
      query,
      tags,
      status,
      limit,
      offset,
    });

    return NextResponse.json({ scripts, total });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch scripts", details: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}
