// tests/unit/bedrock-flex-tier-cost.test.ts
// Bedrock flex-tier cost discount + service-tier resolver generalization.
// AWS Bedrock flex tier is billed at a 50% token discount to Standard
// (https://aws.amazon.com/bedrock/pricing/). OmniRoute routes only "flex" and
// "default" — the two tiers the executor allowlist and cost calculator know about.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCodexFastCostMultiplier } from "../../src/lib/usage/costCalculator.ts";
import {
  resolveEffectiveServiceTier,
  resolveReportedServiceTier,
} from "../../open-sse/handlers/chatCore/serviceTier.ts";

// ── Cost multiplier ───────────────────────────────────────────────────────

test("getCodexFastCostMultiplier: bedrock flex returns 0.5", () => {
  assert.equal(getCodexFastCostMultiplier("bedrock", "anthropic.claude-sonnet-4-6", "flex"), 0.5);
});

test("getCodexFastCostMultiplier: bedrock default/standard/absent returns 1", () => {
  assert.equal(getCodexFastCostMultiplier("bedrock", "anthropic.claude-sonnet-4-6", "default"), 1);
  assert.equal(getCodexFastCostMultiplier("bedrock", "anthropic.claude-sonnet-4-6", "standard"), 1);
  assert.equal(getCodexFastCostMultiplier("bedrock", "anthropic.claude-sonnet-4-6", undefined), 1);
});

test("getCodexFastCostMultiplier: bedrock priority (we don't route) returns 1", () => {
  // Bedrock has a priority tier (75% premium), but OmniRoute does not route it.
  // If a client sends it, the cost calculator should not apply any discount.
  assert.equal(getCodexFastCostMultiplier("bedrock", "anthropic.claude-sonnet-4-6", "priority"), 1);
});

test("getCodexFastCostMultiplier: bedrock flex is model-independent", () => {
  // The AWS flex discount applies to all models, not just Claude.
  assert.equal(getCodexFastCostMultiplier("bedrock", "meta.llama-4-maverick", "flex"), 0.5);
  assert.equal(getCodexFastCostMultiplier("bedrock", "us.amazon.nova-pro-v1:0", "flex"), 0.5);
});

test("getCodexFastCostMultiplier: case-insensitive (Bedrock / FLEX)", () => {
  assert.equal(getCodexFastCostMultiplier("Bedrock", "anthropic.claude-sonnet-4-6", "FLEX"), 0.5);
  assert.equal(getCodexFastCostMultiplier("BEDROCK", "anthropic.claude-sonnet-4-6", "flex"), 0.5);
});

test("getCodexFastCostMultiplier: regression — codex flex still 0.5, other providers 1", () => {
  assert.equal(getCodexFastCostMultiplier("codex", "gpt-5.5", "flex"), 0.5);
  assert.equal(getCodexFastCostMultiplier("openai", "gpt-5", "flex"), 1);
  assert.equal(getCodexFastCostMultiplier("anthropic", "claude-sonnet-4-6", "flex"), 1);
});

// ── resolveEffectiveServiceTier ───────────────────────────────────────────

test("resolveEffectiveServiceTier: bedrock reads a valid request service_tier", () => {
  assert.equal(resolveEffectiveServiceTier("bedrock", undefined, { service_tier: "flex" }), "flex");
  assert.equal(
    resolveEffectiveServiceTier("bedrock", undefined, { service_tier: "default" }),
    "default"
  );
});

test("resolveEffectiveServiceTier: bedrock is case-insensitive", () => {
  assert.equal(resolveEffectiveServiceTier("bedrock", undefined, { service_tier: "Flex" }), "flex");
  assert.equal(
    resolveEffectiveServiceTier("bedrock", undefined, { service_tier: "DEFAULT" }),
    "default"
  );
});

test("resolveEffectiveServiceTier: bedrock rejects non-routable tiers → standard", () => {
  // "priority" is a real Bedrock tier we do not route; "fast" is a Codex alias.
  assert.equal(
    resolveEffectiveServiceTier("bedrock", undefined, { service_tier: "priority" }),
    "standard"
  );
  assert.equal(
    resolveEffectiveServiceTier("bedrock", undefined, { service_tier: "fast" }),
    "standard"
  );
});

test("resolveEffectiveServiceTier: bedrock with blank/absent service_tier → standard", () => {
  assert.equal(resolveEffectiveServiceTier("bedrock", undefined, {}), "standard");
  assert.equal(
    resolveEffectiveServiceTier("bedrock", undefined, { service_tier: "  " }),
    "standard"
  );
  assert.equal(resolveEffectiveServiceTier("bedrock", undefined, { service_tier: 7 }), "standard");
  assert.equal(resolveEffectiveServiceTier("bedrock", undefined, undefined), "standard");
});

test("resolveEffectiveServiceTier: regression — openai still standard", () => {
  assert.equal(
    resolveEffectiveServiceTier("openai", undefined, { service_tier: "flex" }),
    "standard"
  );
  assert.equal(
    resolveEffectiveServiceTier("anthropic", undefined, { service_tier: "flex" }),
    "standard"
  );
});

test("resolveEffectiveServiceTier: regression — codex still works", () => {
  assert.equal(
    resolveEffectiveServiceTier("codex", undefined, { service_tier: "priority" }),
    "priority"
  );
  assert.equal(resolveEffectiveServiceTier("codex", undefined, { service_tier: "flex" }), "flex");
});

// ── resolveReportedServiceTier ────────────────────────────────────────────

test("resolveReportedServiceTier: bedrock captures the reported tier", () => {
  assert.equal(resolveReportedServiceTier("bedrock", { service_tier: "flex" }), "flex");
  assert.equal(resolveReportedServiceTier("bedrock", { service_tier: "default" }), "default");
});

test("resolveReportedServiceTier: bedrock is case-insensitive", () => {
  assert.equal(resolveReportedServiceTier("bedrock", { service_tier: "Flex" }), "flex");
});

test("resolveReportedServiceTier: bedrock returns null when absent or invalid", () => {
  assert.equal(resolveReportedServiceTier("bedrock", {}), null);
  assert.equal(resolveReportedServiceTier("bedrock", null), null);
  assert.equal(resolveReportedServiceTier("bedrock", undefined), null);
});

test("resolveReportedServiceTier: bedrock recursive descent (nested response)", () => {
  assert.equal(
    resolveReportedServiceTier("bedrock", { response: { service_tier: "flex" } }),
    "flex"
  );
});

test("resolveReportedServiceTier: regression — codex still works", () => {
  assert.equal(resolveReportedServiceTier("codex", { service_tier: "flex" }), "flex");
  assert.equal(
    resolveReportedServiceTier("codex", { response: { service_tier: "priority" } }),
    "priority"
  );
});
