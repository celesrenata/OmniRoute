/**
 * Atomic tooltip overlay — the focus-driven detail card (OR-ATOM-001 v2, M3
 * Phase B; OR-ATOM-003, V2/P2).
 *
 * The 3D scene has no in-scope 3D picking (an explicit unknown), so the
 * tooltip is driven by the *focused* atom — the same atom the label overlay
 * centers and that `focusNode` selects. When an atom is focused, this card
 * appears (top-right) with the atom's full telemetry: label, provider id,
 * lane, spin mode/speed, queue-vibration mode, in-flight requests, and the
 * composed visual state.
 *
 * Truthfulness (P2 — telemetry closure): every derived metric carries its
 * provenance. `spin.mode` distinguishes *measured* from *measured-zero*
 * (observed quiet — a real `0`) from *unavailable* (no telemetry sampled at
 * all — the card says "TPS unavailable", it never fabricates a rate). The
 * in-flight count says "no data" when absent (never `0`), and the queue
 * vibration says "unavailable" when no queue telemetry exists. The
 * source/freshness row shows the snapshot's own `capturedAt` — the feed the
 * numbers came from and when it was captured.
 *
 * Pure React + CSS only (no `three`) — safe under jsdom. It is a pure
 * function of the focused descriptor: `null` → no card, a descriptor → the
 * card. A renderer swap cannot silently change what the tooltip shows.
 *
 * Explicit unknown: this is a *focus*-driven card, not a true mouse-hover
 * tooltip (it does not follow the cursor). That is the bounded scope: hover
 * would need 3D ray-picking, which is out of scope for M3 Phase B.
 */
import { Fragment } from "react";
import type { AtomVisualDescriptor } from "../AtomicTopologyRenderer";

/**
 * Human copy for the spin row, by provenance. "measured-zero" is a *real*
 * observed 0 (quiet upstream) and must not read as missing; "unavailable"
 * means no telemetry was sampled at all (no fabricated rate).
 */
/**
 * Activity row (operator directive 30): decorative vitality must never read as live
 * work, so the tooltip states which energy tier the atom is in and why.
 */
export function activityCopy(
  tier: 0 | 1 | 2 | 3,
  lastActivityAt: number | null,
  now: number
): string {
  if (tier === 0) return "no data (stale or unknown health)";
  if (tier === 3) return "active (live or measured work)";
  if (tier === 2 && lastActivityAt != null && Number.isFinite(lastActivityAt)) {
    const mins = Math.max(0, Math.round((now - lastActivityAt) / 60_000));
    return mins < 1 ? "recent activity < 1m ago" : `recent activity ${mins}m ago`;
  }
  return "idle, no measured activity";
}

function spinCopy(descriptor: AtomVisualDescriptor): string {
  const { value, mode } = descriptor.spin;
  switch (mode) {
    case "measured":
      return `${value.toFixed(2)} rad/s (measured)`;
    case "measured-zero":
      return "0 rad/s (measured — observed quiet)";
    case "unavailable":
      return "TPS unavailable (no telemetry)";
    default:
      return "TPS unavailable (no telemetry)";
  }
}

/**
 * The queue row's label, by atom kind — the two queues are DIFFERENT systems
 * and must never read as one (T5.4 labeling freeze). Provider atoms carry the
 * OmniRoute request rate-limiter queue (basis `rateLimitManager:counts.QUEUED`);
 * runtime device atoms carry the inference-scheduler queue. GPU atoms have no
 * queue of their own, so the row (always "unavailable" for them) uses the
 * rate-limiter label as the closest fleet concept.
 */
export function queueRowLabel(
  kind: AtomVisualDescriptor["kind"],
  hostedRuntimeIds?: readonly string[]
): string {
  // A GPU atom that hosts merged runtimes carries their scheduler queue.
  const scheduler = kind === "runtime" || (kind === "gpu" && (hostedRuntimeIds?.length ?? 0) > 0);
  return scheduler ? "Sched. queue" : "Rate-limit queue";
}

/**
 * Observed-model rows with their provenance basis. One row per origin so a
 * model id is never shown without saying where it was observed:
 * "live in-flight" (WS), "call-log, last N min" (recent successful rows) or
 * "fleet residency" (proven runtime residency on device atoms). Empty when
 * nothing was observed (never a placeholder model).
 */
export function modelProvenanceRows(
  descriptor: AtomVisualDescriptor
): Array<{ label: string; value: string }> {
  const ids = descriptor.observedModelIds;
  if (!ids || ids.length === 0) return [];
  const sources = descriptor.observedModelSources;
  if (!sources) return [{ label: "Models (fleet residency)", value: ids.join(", ") }];
  const rows: Array<{ label: string; value: string }> = [];
  if (sources.inFlight.length > 0) {
    rows.push({ label: "Models (live in-flight)", value: sources.inFlight.join(", ") });
  }
  const fromLog = sources.callLog.filter((id) => !sources.inFlight.includes(id));
  if (fromLog.length > 0) {
    const minutes = sources.callLogWindowMs ? Math.round(sources.callLogWindowMs / 60_000) : null;
    rows.push({
      label: `Models (call-log${minutes ? `, last ${minutes} min` : ""})`,
      value: fromLog.join(", "),
    });
  }
  return rows;
}

/**
 * Human copy for the queue row, by provenance. "zero" is a real observed
 * empty queue; "unavailable" means no queue telemetry exists.
 */
function queueCopy(descriptor: AtomVisualDescriptor): string {
  const { mode } = descriptor.vibration;
  switch (mode) {
    case "measured":
      return `measured (amplitude ${descriptor.vibration.amplitude.toFixed(1)})`;
    case "zero":
      return "empty queue (measured)";
    case "unavailable":
      return "unavailable (no queue telemetry)";
    default:
      return "unavailable (no queue telemetry)";
  }
}

/**
 * The focus-driven detail card.
 *
 * @param descriptor the focused atom, or `null` when nothing is focused.
 * @param capturedAt the snapshot's capture time (epoch ms) — the
 *   source/freshness row; `null`/non-finite → "source unavailable".
 */
export function AtomicTooltip({
  descriptor,
  capturedAt,
  onOpenDetail,
}: {
  descriptor: AtomVisualDescriptor | null;
  capturedAt?: number | null;
  /** Opt-in detail view (Step 11): shows the "Open detail view" action when provided. */
  onOpenDetail?: (atomId: string) => void;
}) {
  if (!descriptor) return null;

  const state = descriptor.visualState.state;
  const activeRequests =
    descriptor.activeRequests == null
      ? "no data (no telemetry)"
      : String(descriptor.activeRequests);
  const capturedLabel =
    capturedAt != null && Number.isFinite(capturedAt)
      ? new Date(capturedAt).toLocaleTimeString()
      : "source unavailable";
  // T5.4: device-atom facts (GPU util/VRAM/temp/watts; runtime queue/model).
  // Every value is a real measurement; `null` → "no data" (never `0`).
  const facts = descriptor.deviceFacts;
  const numOrNoData = (v: number | null | undefined, fmt?: (n: number) => string): string =>
    v == null ? "no data" : (fmt ?? ((n) => String(n)))(v);
  const fleetSampleLabel =
    descriptor.fleetSampledAt != null && Number.isFinite(descriptor.fleetSampledAt)
      ? new Date(descriptor.fleetSampledAt).toLocaleTimeString()
      : "no fleet sample";

  return (
    <div
      className="atomic-tooltip"
      data-atomic-tooltip="true"
      data-atom-id={descriptor.id}
      data-visual-state={state}
      role="status"
      aria-live="polite"
      style={{ pointerEvents: "auto" }}
    >
      <div className="atomic-tooltip__header">
        <span
          className="atomic-tooltip__swatch"
          style={{ backgroundColor: descriptor.laneHue }}
          aria-hidden="true"
        />
        <span className="atomic-tooltip__label">{descriptor.label}</span>
        <span className="atomic-tooltip__kind">{descriptor.kind}</span>
      </div>

      <dl className="atomic-tooltip__grid">
        <dt>Provider</dt>
        <dd>{descriptor.providerId ?? "—"}</dd>
        <dt>Lane</dt>
        <dd>{descriptor.lane}</dd>
        <dt>State</dt>
        <dd>{state}</dd>
        <dt>Activity</dt>
        <dd>
          {activityCopy(
            descriptor.energyTier,
            descriptor.lastActivityAt,
            capturedAt ?? descriptor.lastActivityAt ?? 0
          )}
        </dd>
        <dt>Spin</dt>
        <dd>{spinCopy(descriptor)}</dd>
        <dt>{queueRowLabel(descriptor.kind, descriptor.deviceFacts?.hostedRuntimeIds)}</dt>
        <dd>{queueCopy(descriptor)}</dd>
        <dt>In flight</dt>
        <dd>{activeRequests}</dd>
        {modelProvenanceRows(descriptor).map((row) => (
          <Fragment key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </Fragment>
        ))}
        <dt>Captured</dt>
        <dd>{capturedLabel}</dd>
        {facts ? (
          <>
            {facts.kind === "gpu" ? (
              <>
                <dt>GPU util</dt>
                <dd>{numOrNoData(facts.utilizationPercent, (n) => `${n.toFixed(1)}%`)}</dd>
                <dt>VRAM</dt>
                <dd>
                  {facts.vramUsedBytes != null && facts.vramTotalBytes != null
                    ? `${(facts.vramUsedBytes / 1e9).toFixed(2)} / ${(facts.vramTotalBytes / 1e9).toFixed(2)} GB`
                    : "no data"}
                </dd>
                <dt>Temp</dt>
                <dd>{numOrNoData(facts.temperatureC, (n) => `${n.toFixed(1)} °C`)}</dd>
                <dt>Power</dt>
                <dd>{numOrNoData(facts.powerWatts, (n) => `${n.toFixed(1)} W`)}</dd>
                {facts.hostedRuntimeIds && facts.hostedRuntimeIds.length > 0 ? (
                  <>
                    <dt>Hosted runtimes</dt>
                    <dd>{facts.hostedRuntimeIds.join(", ")} (proven runtime_device)</dd>
                    <dt>Active jobs</dt>
                    <dd>{numOrNoData(facts.activeJobs)}</dd>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <dt>Queue depth</dt>
                <dd>{numOrNoData(facts.queuedJobs)}</dd>
                <dt>Active jobs</dt>
                <dd>{numOrNoData(facts.activeJobs)}</dd>
                <dt>Model</dt>
                <dd>{facts.modelId ?? "no data"}</dd>
              </>
            )}
          </>
        ) : null}
        <dt>Fleet sample</dt>
        <dd>{fleetSampleLabel}</dd>
      </dl>
      {onOpenDetail ? (
        <button
          type="button"
          data-atomic-open-detail="true"
          onClick={() => onOpenDetail(descriptor.id)}
          style={{
            marginTop: 8,
            width: "100%",
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid rgba(34, 211, 238, 0.45)",
            background: "rgba(8, 47, 73, 0.6)",
            color: "#e0f2fe",
            cursor: "pointer",
            font: "600 11px system-ui, sans-serif",
          }}
        >
          Open detail view
        </button>
      ) : null}
    </div>
  );
}
