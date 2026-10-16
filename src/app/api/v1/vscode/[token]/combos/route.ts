/**
 * VS Code Combos endpoint — re-export base Ollama-compatible routes
 * and intercept GET to return combo metadata.
 *
 * The VS Code extension expects a standard Ollama server at the base URL,
 * so we re-export /api/version, /api/tags, etc. from the [token] parent route.
 */
import { getCombos } from "@/lib/db/combos";
import { projectCombo, type PublicCombo } from "@/app/api/v1/combos/projectCombo";
import { computeComboContextLength } from "@/lib/combos/comboContext";

// Re-export Ollama-compatible endpoints from the parent [token] route
// so VS Code can validate the server version and list models normally
export { OPTIONS } from "@/app/api/v1/vscode/[token]/route";
export async function GET(request: Request) {
  // If client requests /api/version or other Ollama endpoints, delegate to parent
  const url = new URL(request.url);
  if (url.pathname.includes("/api/version") || url.pathname.includes("/api/tags")) {
    const { GET: parentGET } = await import("@/app/api/v1/vscode/[token]/route");
    return parentGET(request);
  }

  // Default: return combos metadata
  try {
    const combos = await getCombos();
    const allCombos = Array.isArray(combos) ? combos : [];
    // Fleet-topology (task 13.1): the context-window resolver reuses the catalog's
    // own computeComboContextLength over the full collection, so nested combo-refs
    // resolve the same way the routing runtime and /api/combos do.
    const contextCombos = allCombos as Array<{ models?: unknown[]; name?: string }>;
    const data = allCombos
      // #3979: advertise resolved capabilities so importing clients enable them
      // #14232: pass the collection so combo-ref steps expand the same way the
      // routing runtime resolves them.
      // Task 12.1: additively publish route metadata (kind/contextWindow and,
      // for a Public_Route, routeCapacity + capabilityLane).
      .map((combo) =>
        projectCombo(combo as Record<string, unknown>, {
          includeCapabilities: true,
          allCombos,
          includeRouteMetadata: true,
          resolveContextWindow: (c) =>
            computeComboContextLength(c as { models?: unknown[]; name?: string }, contextCombos),
        })
      )
      .filter((combo): combo is PublicCombo => combo !== null);

    return new Response(JSON.stringify({ object: "list", data, combos: data }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Failed to fetch combos" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
