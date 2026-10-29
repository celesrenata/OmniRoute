"use client";

/**
 * Developer-only telemetry provenance diagnostics panel (OR-ATOM-009 / Phase 2,
 * W3).
 *
 * A SMALL, collapsible, clearly-labeled panel that shows per-atom provenance
 * for the CURRENT signals: value, source (live/demo/stale/unavailable),
 * `sampledAt` age (seconds), `basis` string, the `providerCentricFallback`
 * flag, and the edge count per relation type. It surfaces the DEMO badge when
 * demo mode is active (the badge lives HERE, not in a hidden flag — per the
 * task: "ALWAYS surfaces a visible 'DEMO' badge — render via the diagnostics
 * panel, not a hidden flag").
 *
 * HIDDEN BY DEFAULT, toggled ONLY by the same dev query param
 * (`?topology-dev=1`, read by the integrator and passed as `showDev`) — never
 * by a normal UI control. When `showDev` is false the component renders
 * NOTHING (no DOM, no style, no label change), so the normal UI layout /
 * labels are byte-identical.
 *
 * Presentational + pure React + CSS only (no `three`) — safe under jsdom.
 * Follows the `AtomicTelemetryStatus.tsx` overlay pattern (absolute-positioned
 * badge in the scene host, inline styles, no external CSS).
 */
import { useMemo, useState } from "react";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";
import type {
  ReconciliationResult,
  ReconciliationEdge,
} from "@/shared/topology/telemetry/reconcile";
import type { ReconciliationSignals } from "@/shared/topology/telemetry/atomSignals";
import { computeProvenRouteLinks } from "../scene/provenPulse";

/** The per-atom source classification the panel displays. */
export type AtomicDiagnosticsSource = "live" | "demo" | "stale" | "unavailable";

/** A single per-atom provenance row. */
export interface AtomicDiagnosticsAtom {
  /** Canonical resource id (e.g. `gpu:<host>:<uuid>`). */
  resourceId: string;
  /** The displayed value (TPS or queue count). */
  value: number | null;
  /** The source classification. */
  source: AtomicDiagnosticsSource;
  /** `sampledAt` age in seconds (null when unavailable). */
  ageSec: number | null;
  /** The provenance `basis` string ("" when absent). */
  basis: string;
}

/** Edge counts keyed by relation type. */
export interface AtomicDiagnosticsEdgeCounts {
  provider_runtime: number;
  runtime_device: number;
  runtime_model: number;
}

/** A per-route-link provenance row (OR-ATOM-009 S9.5 — "is this link proven, and on what basis"). */
export interface AtomicDiagnosticsRouteLink {
  /** Canonical link id (`route:<providerId>`). */
  id: string;
  /** Whether the link is proven (may carry pulses). */
  proven: boolean;
  /** The provenance basis string. */
  basis: string;
  /**
   * Age of the snapshot's `capturedAt` in seconds — `null` when the snapshot
   * has no finite `capturedAt`. Computed inside the builder (injectable
   * `nowMs`), never in the render body (react-hooks/purity).
   */
  ageSec: number | null;
}

/**
 * Build the per-route-link provenance rows this panel renders (pure — no
 * React). Each route link's `proven` status + basis come from the snapshot's
 * OWN evidence via {@link computeProvenRouteLinks}: a link is proven when its
 * target provider atom is present (call-log / active-request route evidence),
 * optionally corroborated by a fleet-telemetry provider sample (basis
 * strengthening only). Works WITHOUT a reconciliation — the call-log route
 * is the primary proven segment.
 *
 * `ageSec` derives from the snapshot's `capturedAt` vs `nowMs` (both
 * epoch-ms) and is clamped at 0 (a future `capturedAt` — clock skew — must not
 * render a negative age); `null` when `capturedAt` is absent. `nowMs` is
 * injectable for tests and defaults to the real clock; only the age reads it,
 * so rows stay a pure function of `(snapshot, nowMs)`. The age is computed
 * HERE, never in the render body (react-hooks/purity — same contract as
 * {@link buildDiagnosticsAtoms}).
 */
export function buildDiagnosticsRouteLinks(
  snapshot: TopologySceneSnapshot,
  nowMs: number = Date.now()
): AtomicDiagnosticsRouteLink[] {
  const { provenLinkIds, basisById } = computeProvenRouteLinks(snapshot);
  const ageSec = Number.isFinite(snapshot.capturedAt)
    ? Math.max(0, (nowMs - snapshot.capturedAt) / 1000)
    : null;
  return snapshot.links.map((link) => ({
    id: link.id,
    proven: provenLinkIds.has(link.id),
    basis: basisById.get(link.id) ?? "unproven",
    ageSec,
  }));
}

export interface AtomicTelemetryDiagnosticsProps {
  /** The reconciliation block (null → panel shows "no reconciliation"). */
  reconciliation: ReconciliationResult | null;
  /** Epoch-ms `capturedAt` (drives the per-atom age computation). */
  capturedAt?: number;
  /** The demo scenario id, when demo mode is active (→ DEMO badge). */
  demoScenarioId?: string | null;
  /** When true the panel is rendered; when false the component renders
   * nothing. The integrator drives this from `?topology-dev=1`. */
  showDev?: boolean;
  /** The per-atom provenance rows (the integrator builds these from the
   * reconciliation nodes). Empty → the panel shows the atom count only. */
  atoms?: AtomicDiagnosticsAtom[];
  /** The edge counts per relation type (computed from the reconciliation
   * edges). */
  edgeCounts?: AtomicDiagnosticsEdgeCounts;
  /**
   * The per-route-link provenance rows (OR-ATOM-009 S9.5): whether each
   * visible link is proven and on what basis. Built from the snapshot via
   * {@link buildDiagnosticsRouteLinks}; shown even without a reconciliation
   * (the call-log route is the primary proven segment). Empty → the panel
   * omits the section. */
  routeLinks?: AtomicDiagnosticsRouteLink[];
}

/** Count the edges per relation type (pure). */
export function countEdgesByRelation(
  edges: readonly ReconciliationEdge[]
): AtomicDiagnosticsEdgeCounts {
  const counts: AtomicDiagnosticsEdgeCounts = {
    provider_runtime: 0,
    runtime_device: 0,
    runtime_model: 0,
  };
  for (const e of edges) {
    if (e.relation === "provider_runtime") counts.provider_runtime++;
    else if (e.relation === "runtime_device") counts.runtime_device++;
    else if (e.relation === "runtime_model") counts.runtime_model++;
  }
  return counts;
}

/**
 * Map `ReconciliationSignals` (from `buildAtomSignals()` /
 * `mergeDemoSignals()`) to the per-atom provenance rows this panel renders
 * (pure — testable without React).
 *
 * Honesty contract (OR-ATOM-009 / S9.5):
 *   - `value` is the measured TPS **verbatim** — `null` stays `null`, never a
 *     fabricated `0`;
 *   - `source` passes through verbatim (`live` / `demo` / `stale` /
 *     `unavailable`) — the panel badges it with that classification;
 *   - `ageSec` derives from `sampledAt` vs `nowMs` (both epoch-ms) and is
 *     **clamped at 0** (a future `sampledAt` — clock skew — must not render a
 *     negative age); `null` when `sampledAt` is absent;
 *   - `basis` passes through ("" when absent — the panel prints nothing);
 *   - rows follow the signal map's insertion order (the reconciliation's).
 *
 * @param signals  the per-atom signals (null/undefined → no rows).
 * @param nowMs    "now" in epoch-ms (injectable for tests; defaults to the
 *                 real clock). Only the age computation reads it, so rows
 *                 remain a pure function of `(signals, nowMs)`.
 */
export function buildDiagnosticsAtoms(
  signals: ReconciliationSignals | null | undefined,
  nowMs: number = Date.now()
): AtomicDiagnosticsAtom[] {
  if (signals === null || signals === undefined) return [];
  const rows: AtomicDiagnosticsAtom[] = [];
  signals.perAtom.forEach((signal) => {
    rows.push({
      resourceId: signal.resourceId,
      value: signal.tokensPerSecond,
      source: signal.source,
      ageSec:
        signal.sampledAt != null && Number.isFinite(signal.sampledAt)
          ? Math.max(0, (nowMs - signal.sampledAt) / 1000)
          : null,
      basis: signal.basis ?? "",
    });
  });
  return rows;
}

/**
 * The developer-only provenance diagnostics panel. HIDDEN by default; only
 * renders when `showDev` is true (the integrator keys this off
 * `?topology-dev=1`). Never part of the normal UI.
 */
export function AtomicTelemetryDiagnostics({
  reconciliation,
  capturedAt,
  demoScenarioId = null,
  showDev = false,
  atoms,
  edgeCounts,
  routeLinks,
}: AtomicTelemetryDiagnosticsProps) {
  const [expanded, setExpanded] = useState(false);
  const counts = useMemo(
    () => edgeCounts ?? (reconciliation ? countEdgesByRelation(reconciliation.edges) : null),
    [edgeCounts, reconciliation]
  );

  if (!showDev) return null;

  const demo = demoScenarioId !== null && demoScenarioId.length > 0;
  const rows = atoms ?? [];
  const links = routeLinks ?? [];

  return (
    <div
      className="atomic-telemetry-diagnostics"
      data-atomic-telemetry-diagnostics={showDev ? "true" : "false"}
      data-demo-scenario={demo ? demoScenarioId : "none"}
      role="note"
      aria-label="Developer telemetry provenance diagnostics"
      style={{
        position: "absolute",
        bottom: 8,
        left: 8,
        maxWidth: 360,
        maxHeight: "45%",
        overflow: "auto",
        padding: expanded ? 8 : 0,
        borderRadius: 8,
        border: "1px solid rgba(148,163,184,0.5)",
        background: "rgba(15,23,42,0.72)",
        color: "#e2e8f0",
        fontSize: 11,
        lineHeight: 1.4,
        pointerEvents: "auto",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      {/* Collapsible header row — always visible when the panel is on. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label="Toggle provenance diagnostics"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: 0,
          background: "transparent",
          border: "none",
          color: "#e2e8f0",
          fontSize: 11,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 10 }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{ fontWeight: 700, letterSpacing: "0.04em" }}>DEV</span>
        <span style={{ opacity: 0.8 }}>provenance</span>
        {demo && (
          <span
            aria-label="Demo mode active"
            style={{
              marginLeft: "auto",
              padding: "1px 6px",
              borderRadius: 999,
              background: "#f59e0b",
              color: "#0f172a",
              fontWeight: 700,
              letterSpacing: "0.08em",
            }}
          >
            DEMO
          </span>
        )}
      </button>

      {/* The collapsible body. */}
      {expanded && (
        <div style={{ marginTop: 6 }}>
          {!reconciliation && (
            <div style={{ opacity: 0.75 }}>no reconciliation (telemetry unavailable)</div>
          )}

          {/* Proven route links (OR-ATOM-009 S9.5): whether each visible link
              is a proven relation and on what basis. Rendered even without a
              reconciliation — the call-log route is the primary proven
              segment. */}
          {links.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ opacity: 0.85, marginBottom: 2, fontWeight: 700 }}>
                route links · proven basis
              </div>
              {links.map((l, i) => (
                <div
                  key={`${l.id}-${i}`}
                  data-atomic-diag-link={l.id}
                  data-atomic-link-proven={l.proven ? "true" : "false"}
                  style={{
                    marginBottom: 2,
                    paddingBottom: 2,
                    borderBottom:
                      i < links.length - 1 ? "1px solid rgba(148,163,184,0.25)" : "none",
                  }}
                >
                  <span style={{ opacity: l.proven ? 1 : 0.6 }}>{l.id}</span>
                  <span
                    style={{
                      marginLeft: 6,
                      fontWeight: 700,
                      color: l.proven ? "#4ade80" : "#f87171",
                    }}
                  >
                    {l.proven ? "PROVEN" : "unproven"}
                  </span>
                  <span style={{ opacity: 0.7 }}> · {l.basis}</span>
                  {l.ageSec != null && (
                    <span style={{ opacity: 0.5 }}>
                      {" "}
                      · sampled {Math.max(0, Math.round(l.ageSec))}s ago
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {reconciliation && (
            <>
              <div style={{ opacity: 0.85, marginBottom: 4 }}>
                providerCentricFallback:{" "}
                <span style={{ fontWeight: 700 }}>
                  {reconciliation.providerCentricFallback ? "true" : "false"}
                </span>
                {typeof capturedAt === "number" && Number.isFinite(capturedAt) && (
                  <>
                    {" · captured "}
                    <span style={{ opacity: 0.7 }}>{new Date(capturedAt).toISOString()}</span>
                  </>
                )}
              </div>

              {counts && (
                <div style={{ opacity: 0.85, marginBottom: 6 }}>
                  edges · provider_runtime {counts.provider_runtime} · runtime_device{" "}
                  {counts.runtime_device} · runtime_model {counts.runtime_model}
                </div>
              )}

              {rows.length === 0 && <div style={{ opacity: 0.75 }}>no per-atom facts observed</div>}

              {rows.map((a, i) => (
                <div
                  key={`${a.resourceId}-${i}`}
                  data-atomic-diag-atom={a.resourceId}
                  style={{
                    marginBottom: 4,
                    paddingBottom: 4,
                    borderBottom: i < rows.length - 1 ? "1px solid rgba(148,163,184,0.25)" : "none",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    }}
                  >
                    <span style={{ fontWeight: 700 }}>{a.resourceId}</span>
                    <span
                      data-atomic-diag-source={a.source}
                      style={{
                        padding: "0 5px",
                        borderRadius: 999,
                        fontSize: 10,
                        fontWeight: 700,
                        background:
                          a.source === "live"
                            ? "#22c55e"
                            : a.source === "demo"
                              ? "#f59e0b"
                              : a.source === "stale"
                                ? "#f97316"
                                : "#94a3b8",
                        color: a.source === "live" || a.source === "demo" ? "#0f172a" : "#e2e8f0",
                      }}
                    >
                      {a.source}
                    </span>
                    <span style={{ opacity: 0.85 }}>{a.value === null ? "∅" : a.value}</span>
                    <span style={{ opacity: 0.6 }}>
                      {a.ageSec === null ? "age ∅" : `age ${a.ageSec.toFixed(1)}s`}
                    </span>
                  </div>
                  {a.basis.length > 0 && (
                    <div style={{ opacity: 0.6, fontSize: 10 }}>{a.basis}</div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default AtomicTelemetryDiagnostics;
