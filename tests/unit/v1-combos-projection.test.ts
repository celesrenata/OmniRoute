/**
 * Issue #2300 — Public projection of combo metadata for GET /v1/combos.
 * Verifies that internal routing details (connectionId, weights) are stripped
 * before being exposed to API-key callers.
 *
 * Issue #10968 — and that a step still reports *whether* it pins an account,
 * which is derivable from the stripped connectionId without exposing it.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { projectCombo, projectComboStep } =
  await import("../../src/app/api/v1/combos/projectCombo.ts");

test("#2300 projectComboStep keeps model + providerId, drops connectionId/weight/label", () => {
  const out = projectComboStep({
    id: "step_internal_id",
    kind: "model",
    model: "anthropic/claude-sonnet-4",
    providerId: "anthropic",
    connectionId: "conn_secret_xyz",
    weight: 0.7,
    label: "primary",
    tags: ["fast"],
  });

  assert.deepEqual(out, {
    kind: "model",
    model: "anthropic/claude-sonnet-4",
    providerId: "anthropic",
    accountPinned: true,
  });
});

test("#2300 projectComboStep keeps combo-ref's comboName, drops weight/label", () => {
  const out = projectComboStep({
    id: "step_internal",
    kind: "combo-ref",
    comboName: "fallback-combo",
    weight: 0.3,
    label: "secondary",
  });

  assert.deepEqual(out, { kind: "combo-ref", comboName: "fallback-combo" });
});

test("#2300 projectComboStep returns null for unknown kinds + malformed steps", () => {
  assert.equal(projectComboStep({ kind: "unknown" }), null);
  assert.equal(projectComboStep({ kind: "model" }), null); // missing model
  assert.equal(projectComboStep({ kind: "combo-ref" }), null); // missing comboName
  assert.equal(projectComboStep({}), null);
  assert.equal(projectComboStep({ not_a_kind: true }), null);
});

test("#2300 projectCombo preserves name/strategy/description, projects models", () => {
  const out = projectCombo({
    id: "internal_id",
    name: "my-combo",
    strategy: "priority",
    description: "primary route",
    sortOrder: 5,
    models: [
      {
        kind: "model",
        model: "openai/gpt-5",
        providerId: "openai",
        connectionId: "conn_X",
        weight: 1,
      },
    ],
    schemaVersion: 2,
    config: { secret: "should-not-leak" },
  });

  assert.deepEqual(out, {
    name: "my-combo",
    strategy: "priority",
    description: "primary route",
    models: [{ kind: "model", model: "openai/gpt-5", providerId: "openai", accountPinned: true }],
  });

  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes("conn_X"), "connection id must not leak");
  assert.ok(!serialized.includes("should-not-leak"), "config.secret must not leak");
  assert.ok(!serialized.includes("sortOrder"), "sortOrder must not leak");
});

test("#2300 projectCombo defaults strategy to 'priority' when missing", () => {
  const out = projectCombo({ name: "default-strategy", models: [] });
  assert.equal(out?.strategy, "priority");
});

test("#2300 projectCombo returns null for empty name", () => {
  assert.equal(projectCombo({ name: "", models: [] }), null);
  assert.equal(projectCombo({ name: "   ", models: [] }), null);
  assert.equal(projectCombo({ models: [] }), null);
});

test("#2300 projectCombo filters out malformed step entries silently", () => {
  const out = projectCombo({
    name: "noisy",
    strategy: "auto",
    models: [
      { kind: "model", model: "openai/gpt-5" },
      "not-an-object",
      null,
      { kind: "unknown" },
      { kind: "model" }, // missing model
    ],
  });
  assert.equal(out?.models.length, 1);
  assert.equal(out?.models[0].model, "openai/gpt-5");
});

test("#2300 projectCombo omits description when empty", () => {
  const out = projectCombo({ name: "no-desc", strategy: "priority", models: [] });
  assert.equal("description" in (out ?? {}), false);
});

/**
 * Issue #10968 — two steps that pin different accounts of the same provider are
 * indistinguishable in the projection, so a client reads a two-account failover
 * as one duplicated step. `accountPinned` says which it is; the connectionId it
 * is derived from must stay stripped.
 */
test("#10968 projectComboStep reports a pinned account without the connectionId", () => {
  const out = projectComboStep({
    kind: "model",
    model: "jina-ai/some-embed",
    providerId: "jina-ai",
    connectionId: "conn_secret_xyz",
  });

  assert.deepEqual(out, {
    kind: "model",
    model: "jina-ai/some-embed",
    providerId: "jina-ai",
    accountPinned: true,
  });
  assert.ok(!JSON.stringify(out).includes("conn_secret_xyz"), "connection id must not leak");
});

test("#10968 projectComboStep reports false for an unpinned model step", () => {
  assert.equal(
    projectComboStep({ kind: "model", model: "jina-ai/some-embed", providerId: "jina-ai" })
      ?.accountPinned,
    false
  );
});

test("#10968 an empty or non-string connectionId is not a pin", () => {
  // Same shape test providerId gets: present but empty pins nothing, and a
  // non-string cannot be a connection id at all.
  for (const connectionId of ["", null, 0, false, {}, []]) {
    assert.equal(
      projectComboStep({ kind: "model", model: "openai/gpt-5", connectionId })?.accountPinned,
      false,
      `connectionId ${JSON.stringify(connectionId)} must not read as a pin`
    );
  }
});

test("#10968 a combo-ref carries no accountPinned", () => {
  const out = projectComboStep({
    kind: "combo-ref",
    comboName: "fallback-combo",
    connectionId: "conn_ignored",
  });

  assert.deepEqual(out, { kind: "combo-ref", comboName: "fallback-combo" });
  assert.equal("accountPinned" in (out ?? {}), false);
});

test("#10968 malformed steps stay null rather than gaining the flag", () => {
  assert.equal(projectComboStep({ kind: "model", connectionId: "conn_X" }), null);
  assert.equal(projectComboStep({ kind: "unknown", connectionId: "conn_X" }), null);
});

test("#10968 two pinned accounts of one provider are no longer identical", () => {
  const out = projectCombo({
    name: "failover",
    strategy: "priority",
    models: [
      {
        kind: "model",
        model: "jina-ai/some-embed",
        providerId: "jina-ai",
        connectionId: "conn_wallet_a",
      },
      {
        kind: "model",
        model: "jina-ai/some-embed",
        providerId: "jina-ai",
        connectionId: "conn_wallet_b",
      },
      { kind: "model", model: "jina-ai/some-embed", providerId: "jina-ai" },
    ],
  });

  assert.deepEqual(
    out?.models.map((m) => m.accountPinned),
    [true, true, false]
  );

  const serialized = JSON.stringify(out);
  for (const id of ["conn_wallet_a", "conn_wallet_b"]) {
    assert.ok(!serialized.includes(id), `${id} must not leak`);
  }
});

/**
 * Fleet-topology task 12.1 — additively publish route metadata on the combo
 * projection (consumed by the VS Code combos endpoint): `kind`, `contextWindow`,
 * and for a Public_Route `routeCapacity` + `capabilityLane`. The fields are
 * additive and body-free; older clients ignore them, and they only appear when
 * `includeRouteMetadata` is set.
 *
 * Validates: Requirements 4.11, 13.1, 14.1, 14.2, 14.3
 */
const { deriveComboKind } = await import("../../src/app/api/v1/combos/projectCombo.ts");

test("12.1 route metadata is absent unless includeRouteMetadata is set (additive)", () => {
  const out = projectCombo({
    name: "my-route",
    strategy: "priority",
    isHidden: false,
    models: [{ kind: "combo-ref", comboName: "pool_abc" }],
  });
  assert.equal("kind" in (out ?? {}), false);
  assert.equal("contextWindow" in (out ?? {}), false);
  assert.equal("routeCapacity" in (out ?? {}), false);
  assert.equal("capabilityLane" in (out ?? {}), false);
});

test("12.1 (4.11) a visible combo-ref route derives kind=public", () => {
  const out = projectCombo(
    {
      name: "public-route",
      strategy: "priority",
      isHidden: false,
      models: [{ kind: "combo-ref", comboName: "pool_abc" }],
    },
    { includeRouteMetadata: true }
  );
  assert.equal(out?.kind, "public");
});

test("12.1 (4.11) a hidden pool of model steps derives kind=internal", () => {
  const out = projectCombo(
    {
      name: "pool_abc",
      strategy: "priority",
      isHidden: true,
      models: [
        { kind: "model", model: "glm/glm-5.2" },
        { kind: "model", model: "glm/glm-5.1" },
      ],
    },
    { includeRouteMetadata: true }
  );
  assert.equal(out?.kind, "internal");
});

test("12.1 (4.11) a hidden combo-ref (no model step) derives kind=diagnostic", () => {
  const out = projectCombo(
    {
      name: "diag-route",
      strategy: "priority",
      isHidden: true,
      models: [{ kind: "combo-ref", comboName: "pool_device_x" }],
    },
    { includeRouteMetadata: true }
  );
  assert.equal(out?.kind, "diagnostic");
});

test("12.1 (4.11) an explicit kind/routeKind marker wins over the structural guess", () => {
  // A Route_Alias is structurally identical to its Public_Route (visible combo-ref),
  // so it only reads as `alias` when the record carries an explicit marker.
  const viaTop = projectCombo(
    {
      name: "alias-route",
      strategy: "priority",
      isHidden: false,
      kind: "alias",
      models: [{ kind: "combo-ref", comboName: "pool_abc" }],
    },
    { includeRouteMetadata: true }
  );
  assert.equal(viaTop?.kind, "alias");

  const viaConfig = projectCombo(
    {
      name: "alias-route-2",
      strategy: "priority",
      isHidden: false,
      config: { routeKind: "alias" },
      models: [{ kind: "combo-ref", comboName: "pool_abc" }],
    },
    { includeRouteMetadata: true }
  );
  assert.equal(viaConfig?.kind, "alias");
});

test("12.1 (4.11) deriveComboKind: without an explicit marker an alias reads as public (documented gap)", () => {
  // No alias-vs-public discriminator exists on OmniRoute's combo record, so a
  // visible combo-ref falls back to `public`.
  assert.equal(
    deriveComboKind({
      name: "would-be-alias",
      isHidden: false,
      models: [{ kind: "combo-ref", comboName: "pool_abc" }],
    }),
    "public"
  );
  // An invalid explicit marker is ignored, not trusted.
  assert.equal(
    deriveComboKind({ name: "x", isHidden: true, kind: "bogus", models: [] }),
    "internal"
  );
});

test("12.1 (13.1) contextWindow comes from the injected resolver, omitted when unknown/non-positive", () => {
  const withWindow = projectCombo(
    { name: "r1", isHidden: false, models: [{ kind: "combo-ref", comboName: "p" }] },
    { includeRouteMetadata: true, resolveContextWindow: () => 128000 }
  );
  assert.equal(withWindow?.contextWindow, 128000);

  for (const value of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const out = projectCombo(
      { name: "r2", isHidden: false, models: [{ kind: "combo-ref", comboName: "p" }] },
      { includeRouteMetadata: true, resolveContextWindow: () => value as number | undefined }
    );
    assert.equal(
      "contextWindow" in (out ?? {}),
      false,
      `contextWindow ${String(value)} must be omitted`
    );
  }
});

test("12.1 (14.1) routeCapacity is read for a Public_Route from the record or config", () => {
  const fromTop = projectCombo(
    {
      name: "cap-route",
      isHidden: false,
      models: [{ kind: "combo-ref", comboName: "p" }],
      routeCapacity: { route: "cap-route", capacity: 3 },
    },
    { includeRouteMetadata: true }
  );
  assert.deepEqual(fromTop?.routeCapacity, { route: "cap-route", capacity: 3 });

  // route name defaults to the combo name when the stamped record omits it.
  const fromConfig = projectCombo(
    {
      name: "cap-route-2",
      isHidden: false,
      models: [{ kind: "combo-ref", comboName: "p" }],
      config: { routeCapacity: { capacity: 0 } },
    },
    { includeRouteMetadata: true }
  );
  assert.deepEqual(fromConfig?.routeCapacity, { route: "cap-route-2", capacity: 0 });
});

test("12.1 (14.1) routeCapacity is omitted when absent or malformed (OmniRoute does not re-derive it)", () => {
  const none = projectCombo(
    { name: "no-cap", isHidden: false, models: [{ kind: "combo-ref", comboName: "p" }] },
    { includeRouteMetadata: true }
  );
  assert.equal("routeCapacity" in (none ?? {}), false);

  const malformed = projectCombo(
    {
      name: "bad-cap",
      isHidden: false,
      models: [{ kind: "combo-ref", comboName: "p" }],
      routeCapacity: { route: "bad-cap", capacity: "lots" },
    },
    { includeRouteMetadata: true }
  );
  assert.equal("routeCapacity" in (malformed ?? {}), false);
});

test("12.1 (14.2) capabilityLane map is read for a Public_Route, string→string entries only", () => {
  const out = projectCombo(
    {
      name: "lane-route",
      isHidden: false,
      models: [{ kind: "combo-ref", comboName: "p" }],
      capabilityLane: { vision: "lane-route", embed: "lane-route", bogus: 42 },
    },
    { includeRouteMetadata: true }
  );
  assert.deepEqual(out?.capabilityLane, { vision: "lane-route", embed: "lane-route" });

  const none = projectCombo(
    { name: "no-lane", isHidden: false, models: [{ kind: "combo-ref", comboName: "p" }] },
    { includeRouteMetadata: true }
  );
  assert.equal("capabilityLane" in (none ?? {}), false);
});

test("12.1 (14.1/14.2) routeCapacity + capabilityLane are Public_Route-only", () => {
  // A hidden internal pool must not carry route-only metadata even if stamped.
  const internal = projectCombo(
    {
      name: "pool_abc",
      isHidden: true,
      models: [{ kind: "model", model: "glm/glm-5.2" }],
      routeCapacity: { route: "pool_abc", capacity: 9 },
      capabilityLane: { vision: "pool_abc" },
    },
    { includeRouteMetadata: true }
  );
  assert.equal(internal?.kind, "internal");
  assert.equal("routeCapacity" in (internal ?? {}), false);
  assert.equal("capabilityLane" in (internal ?? {}), false);
});

test("12.1 route metadata rides alongside existing projection fields without replacing them", () => {
  const out = projectCombo(
    {
      name: "full-route",
      strategy: "priority",
      description: "primary route",
      isHidden: false,
      models: [{ kind: "combo-ref", comboName: "pool_abc" }],
      routeCapacity: { route: "full-route", capacity: 2 },
      capabilityLane: { vision: "full-route" },
    },
    { includeRouteMetadata: true, resolveContextWindow: () => 200000 }
  );
  assert.equal(out?.name, "full-route");
  assert.equal(out?.strategy, "priority");
  assert.equal(out?.description, "primary route");
  assert.deepEqual(out?.models, [{ kind: "combo-ref", comboName: "pool_abc" }]);
  assert.equal(out?.kind, "public");
  assert.equal(out?.contextWindow, 200000);
  assert.deepEqual(out?.routeCapacity, { route: "full-route", capacity: 2 });
  assert.deepEqual(out?.capabilityLane, { vision: "full-route" });
});
