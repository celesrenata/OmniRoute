/**
 * Secure (strict isolation) combos.
 *
 * A combo with `config.secure === true` must never receive server-side injected context
 * (memory, skills/tools, output styles, custom/global system prompts, compression) and must
 * never persist request or response content (memory extraction, semantic cache, call-log bodies).
 *
 * Secure is contagious: a combo is treated as secure when it, or any combo it references
 * (transitively), is secure. A fallback hop therefore can never escape into a looser path.
 */
type ComboLike = {
  name?: string | null;
  config?: Record<string, unknown> | null;
  models?: unknown;
};

export function isComboSecureFlag(combo: ComboLike | null | undefined): boolean {
  return combo?.config?.secure === true;
}

export function isComboTreeSecure(
  combo: ComboLike | null | undefined,
  allCombos: readonly ComboLike[],
  seen: Set<string> = new Set()
): boolean {
  if (!combo) return false;
  if (isComboSecureFlag(combo)) return true;
  const key = combo.name ?? "";
  if (key) {
    if (seen.has(key)) return false;
    seen.add(key);
  }
  const steps = Array.isArray(combo.models) ? (combo.models as Array<Record<string, unknown>>) : [];
  for (const step of steps) {
    if (!step || typeof step !== "object" || step.kind !== "combo-ref") continue;
    const refName = typeof step.comboName === "string" ? step.comboName : null;
    if (!refName) continue;
    const nested = allCombos.find((c) => c.name === refName);
    if (isComboTreeSecure(nested, allCombos, seen)) return true;
  }
  return false;
}

/** Looks a combo up by (optionally `combo/`-prefixed) name and evaluates its whole tree. */
export function isComboNameSecure(
  comboName: string | null | undefined,
  allCombos: readonly ComboLike[]
): boolean {
  if (!comboName) return false;
  const bare = comboName.startsWith("combo/") ? comboName.substring(6) : comboName;
  const combo = allCombos.find((c) => c.name === comboName || c.name === bare);
  return isComboTreeSecure(combo, allCombos);
}
