/**
 * Atomic legend overlay — the lane-hue key (OR-ATOM-001 v2, M3 Phase B).
 *
 * A compact legend in the bottom-left of the scene host listing each job lane
 * and its deterministic hue (`LANE_HUES` from `visualEncoding`). This is the
 * 3D analogue of the 2D `ProviderTopology2D` legend, so a renderer swap keeps
 * the lane→color contract consistent.
 *
 * Pure React + CSS only (no `three`) — safe under jsdom. The lane list is
 * derived from the descriptors (the lanes actually present in the snapshot),
 * de-duplicated, so the legend never lists a lane no atom uses.
 */
import { LANE_HUES, type JobLane } from "../visualEncoding";

import type { AtomVisualDescriptor } from "../AtomicTopologyRenderer";

/**
 * Presentational lane-hue legend.
 *
 * @param descriptors the atom descriptors (the lanes present drive the list).
 */
export function AtomicLegend({ descriptors }: { descriptors: AtomVisualDescriptor[] }) {
  // The distinct lanes actually in use (descriptor order = snapshot order).
  const lanes: JobLane[] = [];
  for (const descriptor of descriptors) {
    if (!lanes.includes(descriptor.lane)) lanes.push(descriptor.lane);
  }

  return (
    <div
      className="atomic-legend"
      data-atomic-legend="true"
      role="list"
      aria-label="Job lane legend"
    >
      <span className="atomic-legend__title" aria-hidden="true">
        Lanes
      </span>
      {lanes.map((lane) => (
        <span key={lane} className="atomic-legend__item" role="listitem">
          <span
            className="atomic-legend__swatch"
            style={{ backgroundColor: LANE_HUES[lane] }}
            aria-hidden="true"
          />
          <span className="atomic-legend__name">{lane}</span>
        </span>
      ))}
    </div>
  );
}
