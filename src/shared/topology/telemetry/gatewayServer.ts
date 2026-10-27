/**
 * Fleet telemetry — server-side gateway wiring (T005 / M2, OR-ATOM-001 v2;
 * extended by OR-ATOM-005 / Step 5 for optional external adapters).
 *
 * ONE process-wide `FleetTelemetryGateway`. The OmniRoute-native adapter is
 * MANDATORY and always registered first. The adapter's production producers
 * (DB rows, breaker states, limiter counts, call logs) are imported
 * DYNAMICALLY on first use, so importing this module — and therefore the
 * API route — never pulls the SQLite layer or the rate-limit manager into
 * a test bundle or a cold-start critical path.
 *
 * An OPTIONAL external metrics adapter (Prometheus / InfluxDB2 / Grafana)
 * is registered when `OMNIROUTE_FLEET_METRICS_SOURCE` is set to a concrete
 * backend and the URL passes SSRF validation. A misconfigured, down, or
 * unreachable external source NEVER makes the endpoint 503 — the native
 * adapter keeps serving, and the failure degrades to a server-side warning.
 *
 * Boundaries (M0 audit, see `providers/omniroute.ts` header):
 * - NO browser fan-out, NO per-atom queries: one bounded snapshot per call.
 * - NO credentials, NO request bodies: the adapter emits normalized,
 *   provenance-carrying numbers only.
 * - GPU / runtime device facts stay `null` with documented unavailable
 *   provenance (`unavailable:no-gpu-exporter-in-repo`) — nothing is invented.
 */

import pino from "pino";

import { readFleetMetricsConfig } from "./fleetMetricsConfig";
import { FleetTelemetryGateway } from "./gateway";
import { createInfluxProvider } from "./providers/influxdb2";
import { createGrafanaProvider } from "./providers/grafana";
import { createCounterRateEngine } from "./providers/metricMapping";
import { createPrometheusProvider } from "./providers/prometheus";
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

    // Optional external metrics adapter (opt-in via OMNIROUTE_FLEET_METRICS_SOURCE).
    // A misconfigured / down / unreachable external source NEVER makes the
    // endpoint 503 — construction failures degrade to a server-side warning
    // and the native adapter keeps serving.
    registerExternalAdapter(gateway);
  }
  return gateway;
}

/**
 * Build and register the configured external metrics adapter, if any.
 * No-op when the env says "none" / "auto" / "unset" (the native adapter is
 * still the sole backend). Construction failures are caught and logged —
 * the endpoint stays alive on the native adapter alone.
 */
function registerExternalAdapter(gateway: FleetTelemetryGateway): void {
  const resolved = readFleetMetricsConfig();
  if (!resolved.enabled || !resolved.config) return;

  const config = resolved.config;
  try {
    let external: FleetTelemetryProvider;
    switch (resolved.kind) {
      case "prometheus":
        // ONE bounded, persistent counter engine per registered adapter —
        // it survives across snapshots so the vLLM counter forms a real
        // windowed rate (without it the rate is always null).
        external = createPrometheusProvider({
          config,
          counterEngine: createCounterRateEngine(),
        });
        break;
      case "influxdb2":
        external = createInfluxProvider({ config });
        break;
      case "grafana":
        external = createGrafanaProvider({
          config,
          datasourceUid: config.datasourceUid ?? "",
          counterEngine: createCounterRateEngine(),
        });
        break;
      default:
        return;
    }
    gateway.register(external);
    logger.info({ kind: resolved.kind }, "fleet telemetry: external adapter registered");
  } catch (err) {
    logger.warn(
      { err, kind: resolved.kind },
      "fleet telemetry: external adapter registration failed — native adapter still active"
    );
  }
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
