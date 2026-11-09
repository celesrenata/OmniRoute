/**
 * Replay overlay (OR-ATOM Step 12): the persistent REPLAY marker and the
 * scrubber / play controls. Opt-in only: the host mounts this when a replay
 * session exists, and the only entry point is the detail panel's
 * "Replay recorded requests" button (no new always-visible toolbar).
 *
 * Pure React + CSS (no `three`), keyboard operable (native buttons, a native
 * range slider, a native select). Under reduced motion playback steps from one
 * recorded event to the next, and nothing here animates.
 */
import { useSyncExternalStore } from "react";
import {
  REPLAY_WINDOWS_MS,
  type ReplayController,
  type ReplayView,
} from "../scene/replayController";
import { REPLAY_SPEEDS, replayProgress } from "../scene/replayClock";

const AMBER = "#fbbf24";

const MARKER: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  alignItems: "center",
  gap: 8,
  maxWidth: "calc(100% - 24px)",
  padding: "4px 12px",
  borderRadius: 999,
  border: `1px solid ${AMBER}`,
  background: "rgba(40, 24, 2, 0.88)",
  color: "#fef3c7",
  font: "600 12px/1.3 system-ui, sans-serif",
  letterSpacing: 0.4,
  pointerEvents: "none",
  zIndex: 8,
  whiteSpace: "nowrap",
};

const PANEL: React.CSSProperties = {
  position: "absolute",
  left: 12,
  bottom: 12,
  width: 400,
  maxWidth: "calc(100% - 24px)",
  padding: "6px 10px",
  border: `1px solid rgba(251, 191, 36, 0.55)`,
  borderRadius: 12,
  background: "rgba(14, 10, 4, 0.9)",
  color: "#e2e8f0",
  font: "12px/1.45 system-ui, sans-serif",
  boxShadow: "0 12px 32px -12px rgba(0, 0, 0, 0.8)",
  backdropFilter: "blur(10px)",
  pointerEvents: "auto",
  zIndex: 7,
};

const BTN: React.CSSProperties = {
  padding: "3px 9px",
  borderRadius: 6,
  border: "1px solid rgba(251, 191, 36, 0.5)",
  background: "rgba(60, 38, 4, 0.7)",
  color: "#fef3c7",
  cursor: "pointer",
  font: "600 11px system-ui, sans-serif",
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function minutes(ms: number): string {
  return ms >= 3_600_000 ? `${ms / 3_600_000} h` : `${ms / 60_000} min`;
}

export function replayMarkerText(view: ReplayView): string {
  if (view.phase === "loading") return "REPLAY · loading recorded requests…";
  if (view.phase === "error") return "REPLAY · history unavailable";
  if (view.clock) return `REPLAY · ${fmtTime(view.clock.positionMs)}`;
  return "REPLAY";
}

export function AtomicReplayPanel({
  controller,
  onExit,
  reservedRight = 0,
}: {
  controller: ReplayController;
  onExit: () => void;
  /** Right inset (px) kept clear for another panel (the detail panel). */
  reservedRight?: number;
}) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView, controller.getView);
  if (view.phase === "closed") return null;
  const clock = view.clock;
  const empty = view.phase === "ready" && view.recordCount === 0;
  const ready = view.phase === "ready" && clock != null && !empty;
  return (
    <>
      <div
        data-atomic-replay-marker="true"
        role="status"
        aria-label="Replay mode: showing recorded history, not live data"
        style={MARKER}
      >
        <strong>{replayMarkerText(view)}</strong>
        <span style={{ fontWeight: 400, opacity: 0.85 }}>recorded history, not live</span>
      </div>
      <section
        data-atomic-replay-panel="true"
        role="group"
        aria-label="Request replay controls"
        style={{
          ...PANEL,
          ...(reservedRight ? { maxWidth: `calc(100% - ${reservedRight + 12}px)` } : {}),
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onExit();
          }
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            style={BTN}
            disabled={!ready}
            aria-pressed={clock?.playing === true}
            aria-label={clock?.playing ? "Pause replay" : "Play replay"}
            onClick={() => controller.toggle()}
          >
            {clock?.playing ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            style={BTN}
            disabled={!ready}
            aria-label="Previous recorded event"
            onClick={() => controller.stepPrev()}
          >
            ◀ Event
          </button>
          <button
            type="button"
            style={BTN}
            disabled={!ready}
            aria-label="Next recorded event"
            onClick={() => controller.stepNext()}
          >
            Event ▶
          </button>
          <span role="group" aria-label="Playback speed" style={{ display: "inline-flex", gap: 3 }}>
            {REPLAY_SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                style={{
                  ...BTN,
                  ...(clock?.speed === s ? { background: AMBER, color: "#1c1203" } : {}),
                }}
                disabled={!ready}
                aria-pressed={clock?.speed === s}
                aria-label={`Speed ${s}x`}
                onClick={() => controller.setSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </span>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              disabled={!ready}
              checked={clock?.loop === true}
              onChange={(e) => controller.setLoop(e.target.checked)}
            />
            Loop
          </label>
          <label
            style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: "auto" }}
          >
            Window
            <select
              aria-label="Replay window"
              value={view.windowMs}
              onChange={(e) => void controller.open(Number(e.target.value))}
              style={{ background: "#1c1203", color: "#fef3c7", borderRadius: 4 }}
            >
              {REPLAY_WINDOWS_MS.map((w) => (
                <option key={w} value={w}>
                  last {minutes(w)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            style={BTN}
            onClick={onExit}
            aria-label="Exit replay and return to live"
          >
            Exit replay
          </button>
        </div>
        {ready && clock ? (
          <div style={{ marginTop: 4 }}>
            <input
              type="range"
              aria-label="Replay position"
              aria-valuetext={fmtTime(clock.positionMs)}
              min={clock.startMs}
              max={clock.endMs}
              step={1000}
              value={clock.positionMs}
              onChange={(e) => controller.seek(Number(e.target.value))}
              style={{ width: "100%", accentColor: AMBER }}
              data-progress={replayProgress(clock).toFixed(3)}
            />
            <div style={{ display: "flex", justifyContent: "space-between", color: "#a8a29e" }}>
              <span>{fmtTime(clock.startMs)}</span>
              <span>{fmtTime(clock.endMs)}</span>
            </div>
          </div>
        ) : null}
        <div
          style={{ marginTop: 2, color: "#d6d3d1", fontSize: 11 }}
          data-atomic-replay-status="true"
        >
          {view.phase === "loading" ? "Loading recorded requests…" : null}
          {view.phase === "error" ? (
            <>
              {view.error}.{" "}
              <button type="button" style={BTN} onClick={() => void controller.open(view.windowMs)}>
                Retry
              </button>
            </>
          ) : null}
          {empty
            ? `No recorded requests in the last ${minutes(view.windowMs)}. Nothing to replay.`
            : null}
          {ready
            ? `${view.recordCount} recorded events from ${view.rowCount} requests` +
              (view.truncated ? " (history capped; oldest rows omitted)" : "") +
              (view.reducedMotion
                ? ". Reduced motion: steps event to event."
                : ". Health and device telemetry are not replayed.")
            : null}
        </div>
      </section>
    </>
  );
}
