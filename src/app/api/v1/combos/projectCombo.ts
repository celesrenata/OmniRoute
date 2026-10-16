/**
 * Public projection helpers for GET /v1/combos (issue #2300).
 *
 * Strip internal routing details (connectionId, weights, labels, etc.) before
 * returning combo metadata to API-key callers. Kept in a separate module so
 * the projection can be unit-tested without spinning up the Next.js route.
 *
 * #10968: the projection also reports `accountPinned` per model step — a boolean
 * derived from the stripped `connectionId`, so callers can distinguish a combo
 * that fails over between two accounts of one provider from a duplicated step.
 *
 * #3979: client-facing combo catalogs (the `/v1/combos`, VS Code and LobeHub /
 * OpenCode import surfaces) can opt into advertising the combo's resolved
 * capabilities (multimodal / reasoning / caching) so importing clients enable
 * those features instead of requiring manual config after import.
 */
import { getResolvedModelCapabilities } from "@/lib/modelCapabilities";
import { resolveNestedComboTargets } from "@omniroute/open-sse/services/combo/comboStructure.ts";
// The shapes live in the combo type module; comboStructure.ts only re-uses them
// internally, so importing them from there is a TS2459/TS2724 at build time.
import type {
  ComboCollectionLike,
  ComboLike,
  ResolvedComboTarget,
} from "@omniroute/open-sse/services/combo/types.ts";

export interface PublicComboStep {
  kind: "model" | "combo-ref";
  model?: string;
  comboName?: string;
  providerId?: string;
  /**
   * #10968: whether this step pins one specific account of its provider.
   *
   * Two steps that pin different accounts of the same provider project to
   * identical `{kind, model, providerId}` objects, so a client cannot tell a
   * two-account failover from the same step listed twice. This says which it
   * is without exposing the `connectionId` the flag is derived from — not even
   * a prefix, per the issue.
   *
   * Set on every `model` step. Absent on `combo-ref`, which routes through
   * another combo and has no account of its own.
   */
  accountPinned?: boolean;
}

/**
 * #3979: capabilities a combo can be safely imported with. A combo advertises
 * a capability only when EVERY concrete model step proves it (the routing
 * strategy may dispatch to any member, so the weakest member is the ceiling).
 */
export interface PublicComboCapabilities {
  multimodal: boolean;
  reasoning: boolean;
  caching: boolean;
}

/**
 * Fleet-topology (task 12.1): the kind of a combo in the Desired_Route_State a
 * fleet compiler publishes.
 *
 * - `public`     — a client-selectable Public_Route (a visible combo-ref to an
 *                  Internal_Pool).
 * - `alias`      — a Route_Alias: structurally identical to its Public_Route (a
 *                  visible combo-ref to the same pool). OmniRoute cannot tell an
 *                  alias from its Public_Route by shape alone, so it is only
 *                  reported when the combo record carries an explicit `kind`
 *                  marker (see `deriveComboKind`); otherwise a visible combo
 *                  reads as `public`.
 * - `internal`   — a hidden Internal_Pool: the model steps a route fans out to.
 * - `diagnostic` — a hidden Diagnostic_Route (a hidden combo-ref), outside the
 *                  client-selectable catalog.
 */
export type PublicComboKind = "public" | "alias" | "internal" | "diagnostic";

/**
 * Fleet-topology (task 14.1): the per-route capacity record a fleet compiler
 * publishes for a Public_Route — the number of distinct local Slots compiled as
 * its targets on the primary instance. Mirrors the Menagerie fleet compiler's
 * `RouteCapacity` ({ route, capacity }). Only surfaced when the combo record
 * carries it (OmniRoute does not re-derive it from live routing state).
 */
export interface PublicComboRouteCapacity {
  route: string;
  capacity: number;
}

export interface PublicCombo {
  name: string;
  strategy: string;
  description?: string;
  models: PublicComboStep[];
  capabilities?: PublicComboCapabilities;
  /**
   * Fleet-topology (task 4.11): the route kind. Additive — older clients ignore
   * it. Always present on the vscode-combos projection; see `deriveComboKind`.
   */
  kind?: PublicComboKind;
  /**
   * Fleet-topology (task 13.1): the route's effective context window, from
   * `computeComboContextLength`. Omitted when no known window can be determined
   * (e.g. an internal pool that carries none). Additive — older clients ignore it.
   */
  contextWindow?: number;
  /**
   * Fleet-topology (task 14.1): per-route capacity, for a Public_Route only.
   * Only present when the combo record carries it; see `deriveRouteCapacity`.
   */
  routeCapacity?: PublicComboRouteCapacity;
  /**
   * Fleet-topology (task 14.2): the Capability_Lane → this Public_Route-name map
   * entries assigned to this route, for a Public_Route only. Only present when
   * the combo record carries it; see `deriveCapabilityLane`.
   */
  capabilityLane?: Record<string, string>;
}

/** Capability subset projectCombo needs; injectable so tests stay DB-free + deterministic. */
export type ComboCapabilityResolver = (model: string) => {
  supportsVision: boolean | null;
  reasoning: boolean;
};

export interface ProjectComboOptions {
  /** When true, attach the resolved `capabilities` block to the projection (#3979). */
  includeCapabilities?: boolean;
  /** Override the capability resolver (defaults to the model registry). */
  resolveCapabilities?: ComboCapabilityResolver;
  /**
   * #14232: the full combo collection. When supplied, combo-ref steps are
   * expanded through the same resolver the routing runtime uses, so nested
   * leaves count toward capabilities exactly as they would count at dispatch
   * time — matching how /v1/models evaluates the same combo. Without it the
   * legacy behavior applies: any combo-ref forces the conservative false.
   */
  allCombos?: ComboCollectionLike;
  /**
   * Fleet-topology (task 12.1): when true, attach the published route metadata
   * (`kind`, `contextWindow`, and for a Public_Route `routeCapacity` +
   * `capabilityLane`) to the projection. Additive and body-free; older clients
   * ignore the new fields.
   */
  includeRouteMetadata?: boolean;
  /**
   * Override the context-window resolver (defaults to `computeComboContextLength`
   * bound to `allCombos`). Injectable so tests stay DB-free + deterministic.
   */
  resolveContextWindow?: (combo: Record<string, unknown>) => number | undefined;
}

const defaultCapabilityResolver: ComboCapabilityResolver = (model) => {
  const caps = getResolvedModelCapabilities(model);
  return { supportsVision: caps.supportsVision, reasoning: caps.reasoning };
};

export function projectComboStep(step: Record<string, unknown>): PublicComboStep | null {
  const kind = step.kind;
  if (kind === "combo-ref" && typeof step.comboName === "string") {
    return { kind: "combo-ref", comboName: step.comboName };
  }
  if (kind === "model" && typeof step.model === "string") {
    const out: PublicComboStep = { kind: "model", model: step.model };
    if (typeof step.providerId === "string" && step.providerId.length > 0) {
      out.providerId = step.providerId;
    }
    // Same shape test as providerId above. `cleanupComboConnectionRefs` drops the
    // key when the connection is deleted, so a step whose pinned account is gone
    // reports false rather than pointing at nothing.
    out.accountPinned = typeof step.connectionId === "string" && step.connectionId.length > 0;
    return out;
  }
  return null;
}

/**
 * #3979: derive the capabilities a combo can be imported with.
 * - `multimodal` / `reasoning`: true only when there is at least one concrete
 *   model step, there are no unresolvable nested combo-refs, and EVERY model
 *   step proves the capability via the registry. #14232: with `allCombos`
 *   supplied, resolvable combo-refs are expanded through
 *   `resolveNestedComboTargets` — the same target pool the routing runtime
 *   dispatches against and /v1/models evaluates — so nested leaves count
 *   toward the verdict instead of every nested combo being capped at false.
 * - `caching`: reflects the operator's explicit per-combo Context-Cache-Protection
 *   choice (no registry caching flag exists), so caching is never advertised
 *   unless the operator opted in — avoiding surprise prompt-cache cost.
 */
export function computeComboCapabilities(
  combo: Record<string, unknown>,
  resolve: ComboCapabilityResolver = defaultCapabilityResolver,
  allCombos?: ComboCollectionLike
): PublicComboCapabilities {
  const rawModels = Array.isArray(combo.models) ? combo.models : [];
  let hasComboRef = false;
  const directModelIds: string[] = [];

  for (const m of rawModels) {
    if (!m || typeof m !== "object") continue;
    const step = m as Record<string, unknown>;
    if (step.kind === "combo-ref") {
      hasComboRef = true;
    } else if (step.kind === "model" && typeof step.model === "string") {
      directModelIds.push(step.model);
    }
  }

  // #14232: with the collection in hand, combo-ref steps expand through the
  // same resolver the runtime dispatch uses, so the projection evaluates the
  // exact target pool a request would hit. Unresolvable refs (dangling names,
  // cycles at the depth cap) contribute no targets and force the conservative
  // false below, matching the doc contract.
  const modelIds: string[] = [...directModelIds];
  if (hasComboRef && allCombos) {
    const resolved = resolveNestedComboTargets(combo as unknown as ComboLike, allCombos);
    for (const target of resolved as ResolvedComboTarget[]) {
      if (target.kind === "model" && typeof target.modelStr === "string") {
        modelIds.push(target.modelStr);
      }
    }
  }

  let multimodal = modelIds.length > 0 && (!hasComboRef || Boolean(allCombos));
  let reasoning = modelIds.length > 0 && (!hasComboRef || Boolean(allCombos));

  if (multimodal || reasoning) {
    for (const id of modelIds) {
      const caps = resolve(id);
      if (caps.supportsVision !== true) multimodal = false;
      if (caps.reasoning !== true) reasoning = false;
    }
  }

  const caching = combo.context_cache_protection === true;

  return { multimodal, reasoning, caching };
}

const COMBO_KINDS: readonly PublicComboKind[] = ["public", "alias", "internal", "diagnostic"];

function isComboKind(value: unknown): value is PublicComboKind {
  return typeof value === "string" && (COMBO_KINDS as readonly string[]).includes(value);
}

/** Read a combo's own `kind` marker, falling back to `config.kind` / `config.routeKind`. */
function explicitComboKind(combo: Record<string, unknown>): PublicComboKind | undefined {
  if (isComboKind(combo.kind)) return combo.kind;
  if (isComboKind(combo.routeKind)) return combo.routeKind;
  const config = combo.config;
  if (config && typeof config === "object") {
    const c = config as Record<string, unknown>;
    if (isComboKind(c.kind)) return c.kind;
    if (isComboKind(c.routeKind)) return c.routeKind;
  }
  return undefined;
}

/**
 * Fleet-topology (task 4.11): derive a combo's route kind from the combo model
 * OmniRoute persists (`isHidden`, step shape), as a fleet compiler emits it:
 *
 *   - hidden + model steps        → `internal` (an Internal_Pool: a route's fan-out).
 *   - hidden + a combo-ref step   → `diagnostic` (a hidden Diagnostic_Route).
 *   - visible                     → `public` (a client-selectable Public_Route).
 *
 * A Route_Alias is a visible combo-ref to the same pool as its Public_Route, so
 * it is structurally identical to a `public` route in OmniRoute's record and
 * cannot be told apart by shape. An explicit `kind` / `routeKind` marker on the
 * record (or its `config`) is honored first — that is the only way `alias` is
 * reported; without it an alias reads as `public`. Documented gap: OmniRoute's
 * current combo record carries no alias-vs-public discriminator.
 */
export function deriveComboKind(combo: Record<string, unknown>): PublicComboKind {
  const explicit = explicitComboKind(combo);
  if (explicit) return explicit;

  const hidden = combo.isHidden === true;
  const rawModels = Array.isArray(combo.models) ? combo.models : [];
  const hasComboRef = rawModels.some(
    (m) => m && typeof m === "object" && (m as Record<string, unknown>).kind === "combo-ref"
  );
  const hasModelStep = rawModels.some(
    (m) => m && typeof m === "object" && (m as Record<string, unknown>).kind === "model"
  );

  if (hidden) {
    // A hidden combo-ref with no model step is a Diagnostic_Route; anything else
    // hidden is an Internal_Pool (the model fan-out behind a route).
    return hasComboRef && !hasModelStep ? "diagnostic" : "internal";
  }
  return "public";
}

/**
 * Fleet-topology (task 14.1): read a Public_Route's `routeCapacity` from the
 * combo record when a fleet compiler stamped it (`routeCapacity`, or
 * `config.routeCapacity`). OmniRoute does not re-derive capacity from live
 * routing state, so a route without the stamped record reports no capacity.
 */
function deriveRouteCapacity(
  combo: Record<string, unknown>,
  routeName: string
): PublicComboRouteCapacity | undefined {
  const source =
    combo.routeCapacity ??
    (combo.config && typeof combo.config === "object"
      ? (combo.config as Record<string, unknown>).routeCapacity
      : undefined);
  if (!source || typeof source !== "object") return undefined;
  const rec = source as Record<string, unknown>;
  const capacity = rec.capacity;
  if (typeof capacity !== "number" || !Number.isFinite(capacity)) return undefined;
  const route = typeof rec.route === "string" && rec.route.length > 0 ? rec.route : routeName;
  return { route, capacity };
}

/**
 * Fleet-topology (task 14.2): read a Public_Route's `capabilityLane` map
 * (Capability_Lane → this route's name) from the combo record when a fleet
 * compiler stamped it (`capabilityLane`, or `config.capabilityLane`). String →
 * string entries only. Absent when the record carries nothing.
 */
function deriveCapabilityLane(combo: Record<string, unknown>): Record<string, string> | undefined {
  const source =
    combo.capabilityLane ??
    (combo.config && typeof combo.config === "object"
      ? (combo.config as Record<string, unknown>).capabilityLane
      : undefined);
  if (!source || typeof source !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [lane, route] of Object.entries(source as Record<string, unknown>)) {
    if (typeof route === "string" && route.length > 0) out[lane] = route;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function projectCombo(
  combo: Record<string, unknown>,
  options?: ProjectComboOptions
): PublicCombo | null {
  const name = typeof combo.name === "string" ? combo.name.trim() : "";
  if (!name) return null;

  const strategy = typeof combo.strategy === "string" ? combo.strategy : "priority";

  const out: PublicCombo = { name, strategy, models: [] };
  if (typeof combo.description === "string" && combo.description.length > 0) {
    out.description = combo.description;
  }

  const rawModels = Array.isArray(combo.models) ? combo.models : [];
  for (const m of rawModels) {
    if (m && typeof m === "object") {
      const step = projectComboStep(m as Record<string, unknown>);
      if (step) out.models.push(step);
    }
  }

  if (options?.includeCapabilities) {
    out.capabilities = computeComboCapabilities(
      combo,
      options.resolveCapabilities,
      options.allCombos
    );
  }

  // Fleet-topology (task 12.1): additively publish the route metadata. Body-free
  // (derived from the already-fetched combo record) and additive — older clients
  // ignore `kind` / `contextWindow` / `routeCapacity` / `capabilityLane`.
  if (options?.includeRouteMetadata) {
    const kind = deriveComboKind(combo);
    out.kind = kind;

    const contextWindow = options.resolveContextWindow
      ? options.resolveContextWindow(combo)
      : undefined;
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
      out.contextWindow = contextWindow;
    }

    // routeCapacity + capabilityLane are Public_Route-only (a fleet compiler
    // publishes them per Public_Route, not per alias / internal pool / diagnostic).
    if (kind === "public") {
      const routeCapacity = deriveRouteCapacity(combo, name);
      if (routeCapacity) out.routeCapacity = routeCapacity;
      const capabilityLane = deriveCapabilityLane(combo);
      if (capabilityLane) out.capabilityLane = capabilityLane;
    }
  }

  return out;
}
