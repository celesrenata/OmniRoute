/**
 * Atomic controls overlay — the pause/resume state indicator (OR-ATOM-001 v2,
 * M3 Phase B).
 *
 * A small, presentational control chip in the top-left of the scene host. It
 * reflects the host's `setPaused` state (live vs. paused). The chip is
 * *presentational*: the host panel owns the pause toggle and drives
 * `renderer.setPaused` — the overlay only mirrors that state so a renderer
 * swap cannot silently change the controls. The chip is a `<button>` that
 * dispatches a delegated `atomic:toggle-pause` `CustomEvent` (the host listens
 * on its container), so the overlay needs no `three`, no React context, and no
 * imperative reference to the renderer.
 *
 * Pure React + CSS only (no `three`, no `@react-three/*`) — safe under jsdom.
 */

const TOGGLE_PAUSE_EVENT = "atomic:toggle-pause";

/**
 * Presentational pause/resume chip.
 *
 * @param paused the current pause state (mirrored from the host's
 *   `setPaused`).
 */
export function AtomicControls({ paused }: { paused: boolean }) {
  const label = paused ? "Paused" : "Live";

  return (
    <button
      type="button"
      className={`atomic-controls ${paused ? "atomic-controls--paused" : "atomic-controls--live"}`}
      data-atomic-control="pause"
      data-paused={paused ? "true" : "false"}
      aria-pressed={paused}
      aria-label={paused ? "Resume atomic animation" : "Pause atomic animation"}
      onClick={() => {
        // Delegate the toggle to the host (which owns setPaused).
        window.dispatchEvent(new CustomEvent(TOGGLE_PAUSE_EVENT, { detail: { pause: !paused } }));
      }}
    >
      <span className="atomic-controls__dot" aria-hidden="true" />
      <span className="atomic-controls__label">{label}</span>
    </button>
  );
}
