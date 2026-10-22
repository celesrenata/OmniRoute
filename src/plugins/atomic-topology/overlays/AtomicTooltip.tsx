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
import type { AtomVisualDescriptor } from "../AtomicTopologyRenderer";

/**
 * Human copy for the spin row, by provenance. "measured-zero" is a *real*
 * observed 0 (quiet upstream) and must not read as missing; "unavailable"
 * means no telemetry was sampled at all (no fabricated rate).
 */
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
}: {
  descriptor: AtomVisualDescriptor | null;
  capturedAt?: number | null;
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
        <dt>Spin</dt>
        <dd>{spinCopy(descriptor)}</dd>
        <dt>Queue</dt>
        <dd>{queueCopy(descriptor)}</dd>
        <dt>In flight</dt>
        <dd>{activeRequests}</dd>
        <dt>Captured</dt>
        <dd>{capturedLabel}</dd>
      </dl>
    </div>
  );
}
