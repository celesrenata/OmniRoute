/**
 * Atomic controls overlay — the pause/resume + reset-view control group
 * (OR-ATOM-001 v2, M3 Phase B; OR-ATOM-003, V7).
 *
 * A small, presentational control group in the top-center of the scene host
 * with two accessible buttons:
 *   - **Pause / Resume** — reflects the host's `setPaused` state. The chip is
 *     *presentational*: it mirrors the `paused` prop and dispatches a delegated
 *     `atomic:toggle-pause` `CustomEvent` on click.
 *   - **Reset view** — dispatches a delegated `atomic:reset-view` `CustomEvent`
 *     (no state of its own; the renderer bumps its `resetToken` so the scene
 *     re-frames).
 *
 * Both events are listened for by the *renderer instance*
 * (`AtomicTopologyRenderer.tsx` → `createAtomicTopologyInstance`), the single
 * owner of the animation state. The overlay therefore needs no `three`, no
 * React context, and no imperative reference to the renderer — a renderer swap
 * cannot silently change the controls, and a bare instance still responds to
 * the same chips.
 *
 * Live-indicator consolidation (V7): the pause chip deliberately carries **no
 * live/stale dot** — the sole true live-telemetry indicator is the
 * `AtomicTelemetryStatus` badge (top-right), which also surfaces freshness.
 * Keeping a dot here duplicated that signal.
 *
 * Pure React + CSS only (no `three`, no `@react-three/*`) — safe under jsdom.
 */

const TOGGLE_PAUSE_EVENT = "atomic:toggle-pause";
const RESET_VIEW_EVENT = "atomic:reset-view";

/**
 * Presentational pause/resume + reset-view control group.
 *
 * @param paused the current pause state (mirrored from the host's
 *   `setPaused`); drives the pause button's icon, label, and `aria-pressed`.
 */
export function AtomicControls({ paused }: { paused: boolean }) {
  return (
    <div
      className="atomic-controls"
      data-atomic-controls="true"
      role="group"
      aria-label="Atomic scene controls"
    >
      <button
        type="button"
        className={`atomic-controls__btn ${
          paused ? "atomic-controls--paused" : "atomic-controls--live"
        }`}
        data-atomic-control="pause"
        data-paused={paused ? "true" : "false"}
        aria-pressed={paused}
        aria-label={paused ? "Resume atomic animation" : "Pause atomic animation"}
        title={paused ? "Resume atomic animation" : "Pause atomic animation"}
        onClick={() => {
          // Delegate the toggle to the renderer instance (which owns setPaused).
          window.dispatchEvent(new CustomEvent(TOGGLE_PAUSE_EVENT, { detail: { pause: !paused } }));
        }}
      >
        <span className="atomic-controls__icon" aria-hidden="true">
          {paused ? "▶" : "❚❚"}
        </span>
        <span className="atomic-controls__label">{paused ? "Resume" : "Pause"}</span>
      </button>
      <button
        type="button"
        className="atomic-controls__btn"
        data-atomic-control="reset"
        aria-label="Reset view"
        title="Reset view"
        onClick={() => {
          // Delegate the reset to the renderer instance (which bumps resetToken).
          window.dispatchEvent(new CustomEvent(RESET_VIEW_EVENT));
        }}
      >
        <span className="atomic-controls__icon" aria-hidden="true">
          ⟲
        </span>
        <span className="atomic-controls__label">Reset</span>
      </button>
    </div>
  );
}
