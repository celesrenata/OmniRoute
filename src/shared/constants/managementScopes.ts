/**
 * Management API key scopes — the set of API key scopes that authorize a
 * Bearer key on management routes (`/api/*` excluding `/api/v1/*` and the
 * public allowlist).
 *
 * Single source of truth shared by:
 *   - `src/lib/api/requireManagementAuth.ts` (`hasManageScope`)
 *   - `src/shared/utils/apiAuth.ts` (`validateBearerApiKeyForManagement`)
 *
 * Keep both helpers in sync by importing `MANAGEMENT_API_KEY_SCOPES` from
 * here — never re-declare the list inline.
 */

/** Canonical scope name granted to the default environment key. */
export const MANAGE_SCOPE = "manage";

/**
 * Set of scopes that grant access to management API routes.
 * `admin` is treated as a superset of `manage`.
 */
export const MANAGEMENT_API_KEY_SCOPES = new Set<string>(["manage", "admin"]);

/**
 * Narrow, additive scope (#7895) that grants a non-loopback caller ONLY the
 * `/api/mcp/` LOCAL_ONLY carve-out (see `LOCAL_ONLY_MANAGE_SCOPE_BYPASS_PREFIXES`
 * in `src/server/authz/routeGuard.ts`) — it does NOT grant broader management
 * API access. Deliberately kept OUT of `MANAGEMENT_API_KEY_SCOPES`, mirroring the
 * existing narrow-additive-scope precedent (`SELF_USAGE_SCOPE`,
 * `API_KEY_BYPASS_PROVIDER_QUOTA_SCOPE`). A key holding `manage`/`admin` still
 * passes the carve-out unchanged; `mcp:connect` is an alternative, lower-privilege
 * path for remote MCP-only callers.
 */
export const MCP_CONNECT_SCOPE = "mcp:connect";

/**
 * Check whether any of the given scopes authorizes the `/api/mcp/` LOCAL_ONLY
 * carve-out specifically — i.e. either a full management scope (`manage`/`admin`)
 * or the narrow `mcp:connect` scope. Use this ONLY for the `/api/mcp/` bypass
 * check; every other management route must keep using `hasManageScope`.
 */
export function hasMcpConnectOrManageScope(scopes: readonly string[] = []): boolean {
  if (hasManageScope(scopes)) return true;
  return scopes.includes(MCP_CONNECT_SCOPE);
}

/**
 * Narrow, additive Skill Hub scopes. These are the same names the MCP tools
 * already use (`omr_skill_*`: `read:catalog`, `write:skills`). They authorize ONLY
 * the explicit REST allowlist in `resolveSkillsHubRouteLevel` — never any other
 * management route — and are deliberately kept OUT of `MANAGEMENT_API_KEY_SCOPES`
 * (same precedent as `MCP_CONNECT_SCOPE`).
 *
 * Secondary (least-privilege) Skill Hub management key =
 *   [`mcp:connect`, `read:catalog`, `write:skills`].
 */
export const SKILLS_READ_SCOPE = "read:catalog";
export const SKILLS_WRITE_SCOPE = "write:skills";
export type SkillsHubLevel = "read" | "write";
/**
 * Whether the scopes authorize the given Skill Hub level. `manage`/`admin`
 * always pass. `write:skills` does NOT imply `read:catalog` (and vice versa).
 */
export function hasSkillsHubScope(scopes: readonly string[] = [], level: SkillsHubLevel): boolean {
  if (hasManageScope(scopes)) return true;
  return scopes.includes(level === "read" ? SKILLS_READ_SCOPE : SKILLS_WRITE_SCOPE);
}
/**
 * Explicit REST allowlist for the Skill Hub scopes. Returns the level a request
 * needs, or `null` when the route is NOT carved out (it then needs manage/admin).
 *
 * `POST /api/skills/catalog` is listed as `read` because the policy layer cannot
 * see the body; the route handler re-checks `action: "execute"` against
 * manage/admin. `/api/skills/install`, `/api/skills/[id]`, `/api/skills/executions`
 * and `/api/skills/collect/` are intentionally absent.
 */
export function resolveSkillsHubRouteLevel(method: string, path: string): SkillsHubLevel | null {
  const m = method.toUpperCase();
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (p === "/api/skills/catalog") return m === "GET" || m === "POST" ? "read" : null;
  if (p === "/api/skills/hub") return m === "POST" || m === "DELETE" ? "write" : null;
  if (p === "/api/skills/catalog/refresh") return m === "POST" ? "write" : null;
  if (m === "POST" && /^\/api\/skills\/catalog\/[^/]+\/toggle$/.test(p)) return "write";
  return null;
}
/**
 * Check whether any of the given scopes authorizes management API access.
 */
export function hasManageScope(scopes: readonly string[] = []): boolean {
  for (const scope of scopes) {
    if (MANAGEMENT_API_KEY_SCOPES.has(scope)) return true;
  }
  return false;
}
