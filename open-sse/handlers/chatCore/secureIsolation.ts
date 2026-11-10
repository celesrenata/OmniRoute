import { isComboNameSecure } from "@/lib/combos/secure";
import { getHeaderValueCaseInsensitive } from "./headers.ts";
import { getCombosCached } from "./comboContextCache.ts";

/**
 * Per-request opt-in to strict isolation via `x-omniroute-secure`. Headers can only make a
 * request stricter: this can turn isolation ON, never OFF.
 */
export function isSecureRequested(
  headers: Record<string, unknown> | Headers | null | undefined
): boolean {
  const value = (getHeaderValueCaseInsensitive(headers, "x-omniroute-secure") || "")
    .trim()
    .toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

/**
 * Resolves whether this dispatch runs under strict isolation.
 *
 * secure = caller already resolved the top-level combo tree as secure
 *       OR the header opted in
 *       OR the combo named on this dispatch (or anything it references) is secure.
 * Fail-closed: when a combo is named but the lookup throws, isolation is applied.
 */
export async function resolveSecureIsolation(input: {
  requested?: boolean;
  comboName?: string | null;
  headers?: Record<string, unknown> | Headers | null;
}): Promise<boolean> {
  if (input.requested === true) return true;
  if (isSecureRequested(input.headers ?? null)) return true;
  if (!input.comboName) return false;
  try {
    const all = (await getCombosCached()) as Array<{
      name?: string | null;
      config?: Record<string, unknown> | null;
      models?: unknown;
    }>;
    return isComboNameSecure(input.comboName, all);
  } catch {
    return true;
  }
}
