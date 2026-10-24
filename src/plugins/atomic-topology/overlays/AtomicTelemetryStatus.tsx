"use client";

/**
 * Telemetry status indicator (OR-ATOM-001 v2, M4/M6).
 *
 * A small readable badge in the scene host that tells the operator whether the
 * live feed behind the scene is *available* (fresh), *stale* (older than the
 * freshness window), or *unavailable* (no snapshot / no feed). It is the 3D
 * analogue of the 2D feed-status pill: it surfaces the snapshot's
 * provenance — it never fabricates a value. A **failed request** is never
 * shown here: the badge is about the *feed's freshness*, not any single
 * request or provider's health.
 *
 * Pure React + CSS only (no `three`) — safe under jsdom.
 */

/** The feed-freshness state the badge surfaces. */
export type AtomicTelemetryState = "available" | "stale" | "unavailable";

export interface AtomicTelemetryStatusProps {
  /** The snapshot-derived feed state. */
  state: AtomicTelemetryState;
  /** Epoch ms of the snapshot's `capturedAt` (drives the aria description). */
  capturedAt?: number;
}

const STATE_COPY: Record<AtomicTelemetryState, string> = {
  available: "Live",
  stale: "Stale",
  unavailable: "Telemetry unavailable",
};

/**
 * Presentational feed-freshness badge (top-right of the scene host).
 */
export function AtomicTelemetryStatus({ state, capturedAt }: AtomicTelemetryStatusProps) {
  const label = STATE_COPY[state];
  const description =
    capturedAt && Number.isFinite(capturedAt)
      ? `Feed last updated ${new Date(capturedAt).toISOString()}`
      : `Feed status: ${label}`;

  return (
    <div
      className="atomic-telemetry-status"
      data-atomic-telemetry-status={state}
      role="status"
      aria-label={description}
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 999,
        border: "1px solid rgba(148,163,184,0.4)",
        background: "rgba(15,23,42,0.6)",
        color: "#e2e8f0",
        fontSize: 11,
        lineHeight: 1,
        pointerEvents: "none",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          display: "inline-block",
          background: state === "available" ? "#22c55e" : state === "stale" ? "#f59e0b" : "#94a3b8",
        }}
      />
      <span>{label}</span>
    </div>
  );
}
