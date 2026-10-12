/**
 * Atomic labels overlay — the DOM label *roster* (OR-ATOM-001 v2, M3 Phase B).
 *
 * This is the bounded-scope stand-in for spatially-projected screen labels
 * (which would require `three` camera math or drei's `<Html>`). Instead of
 * projecting each atom's world position to screen space, it renders a compact
 * *roster* panel (bottom-right) listing every atom with its label, lane hue,
 * and health/traffic state. Selecting a row:
 *   - calls `onFocusRequest(atomId)` to center the view on that atom, and
 *   - for provider atoms, calls `onProviderClick(providerId)` to fire the
 *     delegated provider-click (the host's `onProviderClick`).
 *
 * Pure React + CSS only (no `three`) — safe under jsdom. The roster is a pure
 * function of the descriptors, so a renderer swap keeps the same labels.
 *
 * Explicit unknown: this is NOT a projected label (it does not track an atom's
 * on-screen position). It is a stable list, which is the bounded scope
 * documented in the adapter.
 */
import type { AtomVisualDescriptor } from "../AtomicTopologyRenderer";

/**
 * The DOM label roster.
 *
 * @param descriptors    the atom descriptors (one row per atom).
 * @param focusNodeId    the atom currently centered (highlighted in the roster).
 * @param onProviderClick delegated provider-click (provider atoms only).
 * @param onFocusRequest  let the host center the view on an atom.
 */
export function AtomicLabels({
  descriptors,
  focusNodeId,
  onProviderClick,
  onFocusRequest,
}: {
  descriptors: AtomVisualDescriptor[];
  focusNodeId: string | null;
  onProviderClick: (providerId: string) => void;
  onFocusRequest?: (nodeId: string) => void;
}) {
  // One row per atom (snapshot order — stable).
  return (
    <div
      className="atomic-labels"
      data-atomic-labels="true"
      role="list"
      aria-label="Topology atoms"
      style={{ pointerEvents: "auto" }}
    >
      {descriptors.map((descriptor) => {
        const isHub = descriptor.kind === "hub";
        const isFocused = focusNodeId === descriptor.id;
        const state = descriptor.visualState.state;
        const rowClass = [
          "atomic-labels__row",
          isHub ? "atomic-labels__row--hub" : "atomic-labels__row--atom",
          `atomic-labels__row--${state}`,
          isFocused ? "is-focused" : "",
        ]
          .filter(Boolean)
          .join(" ");

        const handleRowClick = () => {
          onFocusRequest?.(descriptor.id);
          if (!isHub && descriptor.providerId) onProviderClick(descriptor.providerId);
        };

        return (
          <button
            key={descriptor.id}
            type="button"
            className={rowClass}
            data-atom-id={descriptor.id}
            data-kind={descriptor.kind}
            data-visual-state={state}
            data-focused={isFocused ? "true" : "false"}
            onClick={handleRowClick}
          >
            <span
              className="atomic-labels__swatch"
              style={{ backgroundColor: descriptor.laneHue }}
              aria-hidden="true"
            />
            <span className="atomic-labels__text">{descriptor.label}</span>
            <span className="atomic-labels__state" aria-hidden="true">
              {state}
            </span>
          </button>
        );
      })}
    </div>
  );
}
