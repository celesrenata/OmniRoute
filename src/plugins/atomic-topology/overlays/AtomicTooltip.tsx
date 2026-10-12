/**
 * Atomic tooltip overlay — the hover/focus detail card (OR-ATOM-001 v2, M3
 * Phase B).
 *
 * The 3D scene has no in-scope 3D picking (an explicit unknown), so the
 * tooltip is driven by the *focused* atom — the same atom the label roster
 * centers and that `focusNode` selects. When an atom is focused, this card
 * appears (top-right) with the atom's full telemetry: label, provider id,
 * lane, spin mode/speed, queue-vibration mode, in-flight requests, and the
 * composed visual state.
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
 * The focus-driven detail card.
 *
 * @param descriptor the focused atom, or `null` when nothing is focused.
 */
export function AtomicTooltip({ descriptor }: { descriptor: AtomVisualDescriptor | null }) {
  if (!descriptor) return null;

  const state = descriptor.visualState.state;
  const activeRequests =
    descriptor.activeRequests == null ? "no data" : String(descriptor.activeRequests);

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
        <dd>
          {descriptor.spin.value.toFixed(2)} rad/s ({descriptor.spin.mode})
        </dd>
        <dt>Queue</dt>
        <dd>{descriptor.vibration.mode}</dd>
        <dt>In flight</dt>
        <dd>{activeRequests}</dd>
      </dl>
    </div>
  );
}
