/**
 * Atomic legend overlay — the semantic key (OR-ATOM-001 v2, M3 Phase B;
 * OR-ATOM-003, V7/P2).
 *
 * A compact legend in the bottom-left of the scene host, split into three
 * sections so the viewer can read the scene's color vocabulary without
 * guessing:
 *
 *   - **Lanes** — each job lane present in the snapshot and its
 *     deterministic hue (`LANE_HUES` from `visualEncoding`). The 3D
 *     analogue of the 2D `ProviderTopology2D` legend, so a renderer swap
 *     keeps the lane→color contract consistent.
 *   - **States** — the composed atom/link states (error > active > last >
 *     healthy > idle) and their colors, mirroring `NUCLEUS_STATE_COLOR`
 *     (the halo/link color) in `scene/Nucleus.tsx`.
 *   - **Events** — the transient request-lifecycle discharges: cool teal
 *     for a started/in-flight request, a short red flash on failure
 *     (matching `DISCHARGE_COOL` / `DISCHARGE_RED` in
 *     `scene/EnergyLink.tsx`).
 *
 * Truthfulness (V7/P2): the lane list is derived from the descriptors (the
 * lanes actually present), de-duplicated. When the only lane is `unknown` —
 * i.e. no active-request lane is observable — the legend says so explicitly
 * ("no active lane observable") instead of letting a lone `unknown` imply
 * the whole feature is broken. `unknown` is a valid, honest state (M1 has
 * no per-node lane feed), not an error.
 *
 * Pure React + CSS only (no `three`) — safe under jsdom.
 */
import { LANE_HUES, type JobLane, type AtomicVisualState } from "../visualEncoding";

import type { AtomVisualDescriptor } from "../AtomicTopologyRenderer";

/**
 * The composed state → color key. Mirrors `NUCLEUS_STATE_COLOR`
 * (`scene/Nucleus.tsx`) — the same colors the scene's halos/links actually
 * use — so the legend never invents a color the scene does not paint.
 * `last`/`healthy` share a blue family, `idle` is neutral slate.
 */
const LEGEND_STATE_COLOR: Record<AtomicVisualState, string> = {
  error: "#ef4444",
  active: "#3b82f6",
  last: "#60a5fa",
  healthy: "#3b82f6",
  idle: "#64748b",
};

/** The composed states, in precedence order (matches `resolveVisualState`). */
const LEGEND_STATES: AtomicVisualState[] = ["error", "active", "last", "healthy", "idle"];

/**
 * Presentational semantic-key legend.
 *
 * @param descriptors the atom descriptors (the lanes present drive the
 *   lane list; all three sections are always shown so the vocabulary is
 *   legible even on an empty/unknown-lane snapshot).
 */
export function AtomicLegend({ descriptors }: { descriptors: AtomVisualDescriptor[] }) {
  // The distinct lanes actually in use (descriptor order = snapshot order).
  const lanes: JobLane[] = [];
  for (const descriptor of descriptors) {
    if (!lanes.includes(descriptor.lane)) lanes.push(descriptor.lane);
  }
  const onlyUnknown = lanes.length === 1 && lanes[0] === "unknown";

  return (
    <div
      className="atomic-legend"
      data-atomic-legend="true"
      role="list"
      aria-label="Atomic scene legend"
    >
      {/* ------------------------------------------------------------------ */}
      {/* Lanes — per-atom job lane (the 3D analogue of the 2D legend).       */}
      {/* ------------------------------------------------------------------ */}
      <div className="atomic-legend__section" role="listitem" aria-label="Lane colors">
        <span className="atomic-legend__title" aria-hidden="true">
          Lanes
        </span>
        {onlyUnknown ? (
          <span className="atomic-legend__note">no active lane observable — not an error</span>
        ) : (
          lanes.map((lane) => (
            <span key={lane} className="atomic-legend__item">
              <span
                className="atomic-legend__swatch"
                style={{
                  backgroundColor: lane === "unknown" ? "transparent" : LANE_HUES[lane],
                  border: lane === "unknown" ? "1px dashed rgba(148,163,184,0.5)" : "none",
                }}
                aria-hidden="true"
              />
              <span className="atomic-legend__text">{lane}</span>
            </span>
          ))
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* States — composed atom/link state (error > active > last > …).      */}
      {/* ------------------------------------------------------------------ */}
      <div className="atomic-legend__section" role="listitem" aria-label="State colors">
        <span className="atomic-legend__title" aria-hidden="true">
          States
        </span>
        {LEGEND_STATES.map((state) => (
          <span key={state} className="atomic-legend__item">
            <span
              className="atomic-legend__swatch"
              style={{ backgroundColor: LEGEND_STATE_COLOR[state] }}
              aria-hidden="true"
            />
            <span className="atomic-legend__text">{state}</span>
          </span>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Events — transient request-lifecycle discharges (start / fail).     */}
      {/* ------------------------------------------------------------------ */}
      <div className="atomic-legend__section" role="listitem" aria-label="Event colors">
        <span className="atomic-legend__title" aria-hidden="true">
          Events
        </span>
        <span className="atomic-legend__item">
          <span
            className="atomic-legend__swatch"
            style={{ backgroundColor: "#2dd4bf" }}
            aria-hidden="true"
          />
          <span className="atomic-legend__text">start / active</span>
        </span>
        <span className="atomic-legend__item">
          <span
            className="atomic-legend__swatch"
            style={{ backgroundColor: "#ef4444" }}
            aria-hidden="true"
          />
          <span className="atomic-legend__text">failure (brief)</span>
        </span>
      </div>
    </div>
  );
}
