/**
 * Fleet telemetry — HTTP query mapping (T005 / M2, OR-ATOM-001 v2).
 *
 * Maps the URL query string of `GET /api/telemetry/fleet` onto the
 * `FleetTelemetryQuery` contract (`types.ts`) BEFORE the gateway sees it, so
 * invalid input is a clean 400 instead of a gateway throw. Pure and
 * dependency-free — unit-testable without Next/DB (AC: query validation).
 *
 * Params (all optional; `windowMs` defaults):
 *   windowMs  observation window in ms, must be a finite positive integer
 *             within [MIN_QUERY_WINDOW_MS, MAX_QUERY_WINDOW_MS]
 *   providers comma-separated backend ids (repeated param or comma list);
 *             selects REGISTERED backends — unknown ids warn at the gateway,
 *             they never 400 (gateway semantics)
 *   hosts     comma-separated hostId facts (drops resources without a hostId)
 *   gpus      comma-separated canonical `gpu:<host>:<uuid>` ids (filters
 *             kind=gpu rows only — never provider/runtime rows)
 *
 * Id tokens follow the same non-empty/no-padding rule the gateway applies
 * (`isNonEmptyId` in provenance.ts); list lengths follow the query schema
 * caps (64 / 64 / 256).
 */

import { MAX_QUERY_WINDOW_MS, MIN_QUERY_WINDOW_MS, parseQuery } from "./provenance";
import type { FleetTelemetryQuery } from "./types";

/** Default observation window when `windowMs` is omitted (5 minutes). */
export const FLEET_TELEMETRY_DEFAULT_WINDOW_MS = 300_000;

/** Per-list caps — mirror the querySchema limits (providers/hosts 64, gpus 256). */
const LIST_CAPS = { providers: 64, hosts: 64, gpus: 256 } as const;

type ListParamName = keyof typeof LIST_CAPS;

function readListParam(params: URLSearchParams, name: string): string[] {
  const tokens: string[] = [];
  for (const raw of params.getAll(name)) {
    for (const piece of raw.split(",")) {
      tokens.push(piece);
    }
  }
  return tokens;
}

/**
 * Parse a URL query into a `FleetTelemetryQuery`, or an error message.
 * `parseQuery` re-validates the result (strict schema) so this function can
 * never produce an over-cap or malformed query even if the pre-checks above
 * change.
 */
export function mapFleetTelemetryQuery(
  params: URLSearchParams
): { query: FleetTelemetryQuery } | { error: string } {
  const windowRaw = params.get("windowMs");
  let windowMs: number;
  if (windowRaw === null) {
    windowMs = FLEET_TELEMETRY_DEFAULT_WINDOW_MS;
  } else {
    if (!/^\d+$/.test(windowRaw)) {
      return { error: "windowMs must be a positive integer of milliseconds" };
    }
    windowMs = Number(windowRaw);
    if (!Number.isFinite(windowMs)) {
      return { error: "windowMs must be finite" };
    }
  }
  if (windowMs < MIN_QUERY_WINDOW_MS || windowMs > MAX_QUERY_WINDOW_MS) {
    return {
      error: `windowMs must be within [${MIN_QUERY_WINDOW_MS}, ${MAX_QUERY_WINDOW_MS}]`,
    };
  }

  const lists = {
    providers: readListParam(params, "providers"),
    hosts: readListParam(params, "hosts"),
    gpus: readListParam(params, "gpus"),
  };

  for (const [name, tokens] of Object.entries(lists)) {
    for (const token of tokens) {
      if (token.trim().length === 0 || token.trim() !== token) {
        return {
          error: `${name} ids must be non-empty and free of surrounding whitespace`,
        };
      }
    }
    const cap = LIST_CAPS[name as ListParamName];
    if (tokens.length > cap) {
      return { error: `too many ${name} ids (max ${cap})` };
    }
  }

  const query = parseQuery({
    ...(lists.providers.length > 0 ? { providerIds: lists.providers } : {}),
    ...(lists.hosts.length > 0 ? { hostIds: lists.hosts } : {}),
    ...(lists.gpus.length > 0 ? { gpuIds: lists.gpus } : {}),
    windowMs,
  });
  if (query === null) {
    return { error: "invalid fleet telemetry query" };
  }
  return { query };
}
