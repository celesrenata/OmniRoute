import test from "node:test";
import assert from "node:assert/strict";

import {
  getSkillReviewPolicy,
  reviewedSkillPolicyIds,
} from "../../open-sse/services/skillContentPolicy.ts";

test("quarantined skills are not presented as ready-to-use", () => {
  const policy = getSkillReviewPolicy("imported:security/zeroize-audit");

  assert.equal(policy.status, "quarantine");
  assert.match(policy.reason ?? "", /external agent files/i);
});

test("chain policies expose required companions or external prerequisites", () => {
  const panel = getSkillReviewPolicy("imported:security/panel-review");
  const signed = getSkillReviewPolicy("imported:security/signed-audit-trails-recipe");

  assert.equal(panel.status, "chain");
  assert.deepEqual(panel.requiredCompanions, [
    "review-panel/naming-auditor",
    "review-panel/todo-auditor",
  ]);
  assert.equal(signed.status, "chain");
  assert.deepEqual(signed.externalPrerequisites, ["protect-mcp", "review-agent-governance"]);
});

test("review manifest covers the complete corpus and unknown skills remain compatible", () => {
  const reviewed = getSkillReviewPolicy(
    "imported:algorithmic-trading/adaptive-batch-size-tuning-under-load"
  );
  const unknown = getSkillReviewPolicy("imported:unknown/not-in-review");

  assert.equal(reviewed.status, "approved");
  assert.equal(unknown.status, "approved");
  assert.ok(reviewedSkillPolicyIds().length >= 943);
});
