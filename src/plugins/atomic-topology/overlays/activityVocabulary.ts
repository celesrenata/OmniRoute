/**
 * One shared source for an atom's activity vocabulary (operator directive 34.3).
 *
 * The frozen label chip prints `descriptor.visualState.state`; the tooltip and the
 * detail panel print the energy-tier text (directive 30). Both are derived here so
 * they can never disagree: the descriptor builder derives device atoms' visual state
 * from the tier ({@link deviceVisualStateInput}), and every overlay renders
 * {@link activityLine} = "<state chip word> · <tier text>". Pure and three-free.
 */
export type EnergyTier = 0 | 1 | 2 | 3;
/** Tier text (directive 30): decorative vitality is never presented as live work. */
export function activityCopy(tier: EnergyTier, lastActivityAt: number | null, now: number): string {
  if (tier === 0) return "no data (stale or unknown health)";
  if (tier === 3) return "active (live or measured work)";
  if (tier === 2 && lastActivityAt != null && Number.isFinite(lastActivityAt)) {
    const mins = Math.max(0, Math.round((now - lastActivityAt) / 60_000));
    return mins < 1 ? "recent activity < 1m ago" : `recent activity ${mins}m ago`;
  }
  return "idle, no measured activity";
}
/**
 * Health/traffic input for a device (GPU / runtime) atom's visual state, derived
 * from its energy tier so the label chip, tooltip and panel agree: tier 3 is
 * "active", tier 1 / 2 is connected ("healthy"), tier 0 stays "idle".
 */
export function deviceVisualStateInput(tier: EnergyTier): {
  health: "healthy" | "unknown";
  traffic: "active" | "idle";
} {
  if (tier === 3) return { health: "healthy", traffic: "active" };
  if (tier === 0) return { health: "unknown", traffic: "idle" };
  return { health: "healthy", traffic: "idle" };
}
/** The shared one-line activity statement: the chip word plus the tier text. */
export function activityLine(
  state: string,
  tier: EnergyTier,
  lastActivityAt: number | null,
  now: number
): string {
  return `${state} · ${activityCopy(tier, lastActivityAt, now)}`;
}
