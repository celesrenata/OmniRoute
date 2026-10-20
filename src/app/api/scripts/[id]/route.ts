/**
 * GET /api/scripts/[id] - Get a specific script by ID
 * PUT /api/scripts/[id] - Update a script
 * DELETE /api/scripts/[id] - Delete a script
 */
import { NextResponse } from "next/server";
import { isLocalOnlyPath } from "@/server/authz/routeGuard";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { ScriptVaultManager } from "@/lib/scripts/scriptVault";

export async function GET(request: Request, { params }: { params: { id: string } }) {
  // Check if this is a local-only endpoint
  if (isLocalOnlyPath(new URL(request.url).pathname, "GET")) {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
  }

  try {
    const script = await ScriptVaultManager.getScriptById(params.id);

    if (!script) {
      return NextResponse.json({ error: "Script not found" }, { status: 404 });
    }

    return NextResponse.json(script);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch script", details: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  // Check if this is a local-only endpoint
  if (isLocalOnlyPath(new URL(request.url).pathname, "PUT")) {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
  }

  try {
    const updates = await request.json();

    const updatedScript = await ScriptVaultManager.updateScript(params.id, updates);

    if (!updatedScript) {
      return NextResponse.json({ error: "Script not found" }, { status: 404 });
    }

    return NextResponse.json(updatedScript);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update script", details: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  // Check if this is a local-only endpoint
  if (isLocalOnlyPath(new URL(request.url).pathname, "DELETE")) {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
  }

  try {
    const deleted = await ScriptVaultManager.deleteScript(params.id);

    if (!deleted) {
      return NextResponse.json({ error: "Script not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Script deleted successfully" });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to delete script", details: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}
