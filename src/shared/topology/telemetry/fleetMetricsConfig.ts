/**
 * Fleet telemetry — external metrics-source configuration (OR-ATOM-005 / Step 5).
 *
 * T5.0 found NO reachable Prometheus / InfluxDB2 / Grafana backend on this
 * host (macOS, no env vars, no docker containers, no `nvidia-smi`), so the
 * external adapters are OPT-IN: they register only when the operator has
 * configured a backend via env. The native adapter always keeps the endpoint
 * alive — a missing or misconfigured external source must never make the
 * `/api/telemetry/fleet` endpoint 503.
 *
 * Env (names only — values are read at runtime, never logged/returned):
 *   OMNIROUTE_FLEET_METRICS_SOURCE      none|prometheus|influxdb2|grafana|auto
 *   OMNIROUTE_FLEET_METRICS_VRAM_UNIT   bytes|mib (DCGM VRAM gauge units)
 *   OMNIROUTE_FLEET_METRICS_URL         base URL of the configured backend
 *   OMNIROUTE_FLEET_METRICS_DATASOURCE_UID   Grafana datasource uid
 *   OMNIROUTE_FLEET_METRICS_TOKEN       bearer/service token (NEVER logged)
 *   OMNIROUTE_FLEET_METRICS_FRESHNESS_MS   sample-freshness window
 *
 * URL validation (SSRF defense) is enforced here and in each adapter:
 *   - http/https only (reject file://, ftp://, gopher://, …)
 *   - host allowlist when configured (OMNIROUTE_FLEET_METRICS_ALLOWED_HOSTS)
 *   - port allowlist when the default ports are not acceptable
 */

import { z } from "zod";

import { resolveFleetMetricLabelKeys, type FleetMetricLabelKeys } from "./providers/metricMapping";

export type FleetMetricsSourceKind = "none" | "prometheus" | "influxdb2" | "grafana" | "auto";

/** Defaults (overridable via env). */
export const FLEET_METRICS_FRESHNESS_MS_DEFAULT = 30_000;
/** Default allowlisted ports per backend type. */
export const FLEET_METRICS_DEFAULT_PORTS: Record<"prometheus" | "influxdb2" | "grafana", number[]> =
  {
    prometheus: [9090],
    influxdb2: [8086],
    grafana: [3000],
  };

/** Env keys read (names only — no values ever logged). */
export const FLEET_METRICS_ENV = {
  source: "OMNIROUTE_FLEET_METRICS_SOURCE",
  vramUnit: "OMNIROUTE_FLEET_METRICS_VRAM_UNIT",
  url: "OMNIROUTE_FLEET_METRICS_URL",
  datasourceUid: "OMNIROUTE_FLEET_METRICS_DATASOURCE_UID",
  token: "OMNIROUTE_FLEET_METRICS_TOKEN",
  freshnessMs: "OMNIROUTE_FLEET_METRICS_FRESHNESS_MS",
  allowedHosts: "OMNIROUTE_FLEET_METRICS_ALLOWED_HOSTS",
  allowedPorts: "OMNIROUTE_FLEET_METRICS_ALLOWED_PORTS",
  labelHost: "OMNIROUTE_FLEET_METRICS_LABEL_HOST",
  labelGpuDevice: "OMNIROUTE_FLEET_METRICS_LABEL_GPU_DEVICE",
  labelRuntimeId: "OMNIROUTE_FLEET_METRICS_LABEL_RUNTIME_ID",
} as const;

const SOURCE_VALUES: FleetMetricsSourceKind[] = [
  "none",
  "prometheus",
  "influxdb2",
  "grafana",
  "auto",
];

const sourceSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.enum(SOURCE_VALUES as [FleetMetricsSourceKind, ...FleetMetricsSourceKind[]]));

export const fleetMetricsConfigSchema = z.object({
  source: sourceSchema.default("none"),
  /**
   * Units the DCGM VRAM gauges (DCGM_FI_DEV_FB_USED / _FB_TOTAL) are reported
   * in. The stock dcgm-exporter reports MiB; the normalized schema fields are
   * BYTES, so the adapters scale by 1048576 only when this is "mib". Default
   * "bytes" keeps the historical raw pass-through (byte-valued fixtures).
   */
  vramUnit: z.enum(["bytes", "mib"]).default("bytes"),
  url: z
    .string()
    .url()
    .refine((u) => {
      try {
        const p = new URL(u);
        return p.protocol === "http:" || p.protocol === "https:";
      } catch {
        return false;
      }
    }, "URL must be http/https"),
  datasourceUid: z.string().min(1).optional(),
  token: z.string().optional(),
  freshnessMs: z.coerce.number().int().positive().default(FLEET_METRICS_FRESHNESS_MS_DEFAULT),
  allowedHosts: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0)
    )
    .optional(),
  allowedPorts: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((p) => Number.parseInt(p, 10))
        .filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
    )
    .optional(),
  // Label-key overrides: ASSUMED exporter label names. Each role defaults to a
  // conventional value (host / gpu_uuid / runtime_id) and is operator-configurable.
  labelHost: z.string().min(1).optional(),
  labelGpuDevice: z.string().min(1).optional(),
  labelRuntimeId: z.string().min(1).optional(),
});

export type FleetMetricsConfig = z.infer<typeof fleetMetricsConfigSchema>;

/**
 * Build the resolved, validated label keys from a config's raw override fields.
 * Invalid/empty overrides fall back to the assumed defaults (see
 * `resolveFleetMetricLabelKeys`); the result is what adapters use to read
 * identity facts from samples. Pure + no-throw.
 */
export function labelKeysFromConfig(config: FleetMetricsConfig): FleetMetricLabelKeys {
  return resolveFleetMetricLabelKeys({
    host: config.labelHost,
    gpuDevice: config.labelGpuDevice,
    runtimeId: config.labelRuntimeId,
  });
}

/** The backend actually selected (resolving `auto` requires a URL; `none` = off). */
export interface ResolvedFleetMetricsSource {
  enabled: boolean;
  kind: "prometheus" | "influxdb2" | "grafana" | null;
  config: FleetMetricsConfig | null;
}

/**
 * Read + validate the env. Never throws: an invalid value means "external
 * source disabled" (the native adapter still serves the endpoint). The token
 * is carried only in-memory for request auth; it is never logged/serialized.
 */
export function readFleetMetricsConfig(
  env: NodeJS.ProcessEnv = process.env
): ResolvedFleetMetricsSource {
  const parsed = fleetMetricsConfigSchema.safeParse({
    source: env[FLEET_METRICS_ENV.source] ?? "none",
    vramUnit: env[FLEET_METRICS_ENV.vramUnit] || undefined,
    url: env[FLEET_METRICS_ENV.url] || undefined,
    datasourceUid: env[FLEET_METRICS_ENV.datasourceUid] || undefined,
    token: env[FLEET_METRICS_ENV.token] || undefined,
    freshnessMs: env[FLEET_METRICS_ENV.freshnessMs] ?? FLEET_METRICS_FRESHNESS_MS_DEFAULT,
    allowedHosts: env[FLEET_METRICS_ENV.allowedHosts] || undefined,
    allowedPorts: env[FLEET_METRICS_ENV.allowedPorts] || undefined,
    labelHost: env[FLEET_METRICS_ENV.labelHost] || undefined,
    labelGpuDevice: env[FLEET_METRICS_ENV.labelGpuDevice] || undefined,
    labelRuntimeId: env[FLEET_METRICS_ENV.labelRuntimeId] || undefined,
  });

  if (!parsed.success) {
    // Misconfigured → external source off; native adapter still alive.
    return { enabled: false, kind: null, config: null };
  }

  const config = parsed.data;
  const source = config.source;

  // `none` or `auto` without a URL → off.
  if (source === "none") return { enabled: false, kind: null, config: null };
  if (source === "auto") {
    if (!config.url) return { enabled: false, kind: null, config: null };
    // Infer kind from URL heuristics is not reliable; `auto` without an explicit
    // backend kind is treated as off (operator must name the backend).
    return { enabled: false, kind: null, config: null };
  }

  // Explicit backend: needs a URL.
  if (!config.url) return { enabled: false, kind: null, config: null };

  // Grafana needs a datasource uid (the datasource-query API targets it).
  if (source === "grafana" && !config.datasourceUid) {
    return { enabled: false, kind: null, config: null };
  }

  // URL must be valid http/https (schema already checked) + SSRF guards.
  try {
    const u = new URL(config.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { enabled: false, kind: null, config: null };
    }
    if (!isHostAllowed(u, config)) return { enabled: false, kind: null, config: null };
    if (!isPortAllowed(u, source, config)) return { enabled: false, kind: null, config: null };
  } catch {
    return { enabled: false, kind: null, config: null };
  }

  return { enabled: true, kind: source, config };
}

/** True when the URL host is on the configured allowlist (or no allowlist set). */
export function isHostAllowed(u: URL, config: FleetMetricsConfig): boolean {
  if (!config.allowedHosts || config.allowedHosts.length === 0) return true;
  return config.allowedHosts.includes(u.hostname.toLowerCase());
}

/** True when the URL port is on the allowlist (default backend ports when unset). */
export function isPortAllowed(
  u: URL,
  kind: "prometheus" | "influxdb2" | "grafana",
  config: FleetMetricsConfig
): boolean {
  const port = Number.parseInt(u.port || (u.protocol === "https:" ? "443" : "80"), 10);
  const allowed =
    config.allowedPorts && config.allowedPorts.length > 0
      ? config.allowedPorts
      : FLEET_METRICS_DEFAULT_PORTS[kind];
  return allowed.includes(port);
}
