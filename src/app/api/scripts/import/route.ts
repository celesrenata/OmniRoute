/**
 * POST /api/scripts/import - Import a script from zip file
 */
import { NextResponse } from "next/server";
import { isLocalOnlyPath } from "@/server/authz/routeGuard";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { ScriptVaultManager } from "@/lib/scripts/scriptVault";
import { z } from "zod";

const importSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(20),
  description: z.string().max(500),
  zipContent: z.string(), // Base64 encoded zip content
  metadata: z.any().optional(),
  createdBy: z.string().min(1).max(100).optional(),
});

export async function POST(request: Request) {
  // Check if this is a local-only endpoint
  if (isLocalOnlyPath(new URL(request.url).pathname, "POST")) {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
  }

  try {
    const body = await request.json();

    const validationResult = importSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Invalid import request", details: validationResult.error.flatten() },
        { status: 400 }
      );
    }

    const { name, version, description, zipContent, metadata, createdBy } = validationResult.data;

    // Convert base64 zip content to buffer
    const zipBuffer = Buffer.from(zipContent, "base64");

    // Import the script from zip file
    const script = await ScriptVaultManager.importFromZip(zipBuffer, {
      ...metadata,
      name,
      version,
      description,
      createdBy: createdBy || "system",
    });

    return NextResponse.json(script);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to import script", details: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}
