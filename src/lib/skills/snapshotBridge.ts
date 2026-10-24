/**
 * src/lib/skills/snapshotBridge.ts — helper for skill mutation routes.
 *
 * After any skill add/update/delete, routes call `snapshotAfterMutation()` so
 * a durable snapshot (30-day retention) always reflects the new skill
 * universe: discovery catalog + registered executable skills. Snapshotting
 * happens best-effort — a snapshot failure must never fail the mutation
 * itself (the mutation already succeeded; the snapshot is an observability
 * concern, not a correctness one).
 */
import { skillRegistry } from "@/lib/skills/registry";
import { snapshotCatalog, invalidateCatalog } from "@omniroute/open-sse/services/skillDiscovery";

/**
 * Create a snapshot reflecting the current skill universe after a mutation.
 * `origin` should describe what happened ("skill-added", "skill-updated",
 * "skill-deleted", …). Returns the snapshot id, or null when snapshotting
 * failed (logged, never thrown).
 */
export function snapshotAfterMutation(origin: string): string | null {
  try {
    const registered = skillRegistry
      .list()
      .filter((s) => s.enabled)
      .map((s) => ({ name: s.name, version: s.version }));
    const id = snapshotCatalog(origin, { registered });
    invalidateCatalog();
    return id;
  } catch {
    return null; // snapshot failure is non-fatal to the mutation
  }
}
