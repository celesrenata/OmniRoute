/**
 * Reviewed Skill Hub content policy.
 *
 * The manifest is generated from the complete per-skill content review. It is
 * intentionally checked in as data so discovery remains deterministic and does
 * not depend on the audit workspace or a live review service.
 */
import { REVIEWED_SKILL_POLICY } from "./skillReviewManifest.ts";

export type SkillReviewStatus = "approved" | "edit" | "chain" | "quarantine";

export interface SkillReviewPolicy {
  status: SkillReviewStatus;
  reason?: string;
  requiredCompanions?: string[];
  externalPrerequisites?: string[];
}

export function getSkillReviewPolicy(id: string): SkillReviewPolicy {
  // Test fixtures and operator-added skills may not be in the completed
  // imported corpus. Preserve historical permissive behavior for unknown IDs;
  // only reviewed quarantine entries are hidden.
  return REVIEWED_SKILL_POLICY[id] ?? { status: "approved" };
}

export function reviewedSkillPolicyIds(): string[] {
  return Object.keys(REVIEWED_SKILL_POLICY);
}
