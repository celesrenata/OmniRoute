/**
 * Fleet telemetry — server-side gateway wiring (T005 / M2, OR-ATOM-001 v2).
 *
 * ONE process-wide `FleetTelemetryGateway` with the OmniRoute-native adapter as
 * its only registered backend. The adapter's production producers (DB rows,
 * breaker states, limiter counts, call logs) are imported DYNAMICALLY on first
 * use, so importing this module — and therefore the API route — never pulls
 * the SQLite layer or the rate-limit manager into a test bundle or a
 * cold-start critical path.
 *
 * Boundaries (M0 audit, see `providers/omniroute.ts` header):
 * - NO browser fan-out, NO per-atom queries: one bounded snapshot per call.
 * - NO credentials, NO request bodies: the adapter emits normalized,
 *   provenance-carrying numbers only.
 * - GPU / runtime device facts stay `null` with documented unavailable
 *   provenance (`unavailable:no-gpu-exporter-in-repo`) — nothing is invented.
 */

import pino from "pino";

import { FleetTelemetryGateway } from "./gateway";
import type { FleetTelemetryProvider, FleetTelemetryQuery, FleetTelemetrySnapshot } from "./types";

const logger = pino({ name: "fleet-telemetry-gateway" });

/** Process-wide gateway. Built lazily; never exposed with provider internals. */
let gateway: FleetTelemetryGateway | null = null;

/**
 * Return the shared gateway, registering the native adapter on first call.
 * A native adapter construction failure is fatal to the endpoint (503) —
 * there is exactly one supported backend, so a partial gateway is misleading.
 */
export async function getFleetTelemetryGateway(): Promise<FleetTelemetryGateway> {
  if (gateway === null) {
    // Dynamic import: keeps DB/limiter modules out of the route's static graph.
    const { createProductionOmnirouteProvider } = await import("./providers/omniroute.ts");
    const provider: FleetTelemetryProvider = await createProductionOmnirouteProvider();
    gateway = new FleetTelemetryGateway({
      onWarning: (warning: string) => {
        // Server log only — never a response body, never a request payload.
        logger.warn({ warning }, "fleet telemetry provider warning");
      },
    });
    gateway.register(provider);
  }
  return gateway;
}

/**
 * Serve one bounded, merged snapshot for the fleet. `signal` propagates
 * client cancellation to every provider (the gateway throws
 * `TelemetryAbortedError` on abort; per-provider timeouts degrade to
 * warnings, not errors).
 */
export async function fetchFleetTelemetrySnapshot(
  query: FleetTelemetryQuery,
  signal?: AbortSignal
): Promise<FleetTelemetrySnapshot> {
  const g = await getFleetTelemetryGateway();
  return g.snapshot(query, signal);
}

/** Test hook: drop the cached gateway (and its short-TTL snapshot cache). */
export function resetFleetTelemetryGatewayForTests(): void {
  gateway?.clearCache();
  gateway = null;
}
