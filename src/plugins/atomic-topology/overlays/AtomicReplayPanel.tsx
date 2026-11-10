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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  REPLAY_WINDOWS_MS,
  type ReplayController,
  type ReplayView,
} from "../scene/replayController";
import { REPLAY_SPEEDS, replayProgress } from "../scene/replayClock";
import { replayMomentLabel } from "../scene/replaySnapshot";

const AMBER = "#fbbf24";

const MARKER: React.CSSProperties = {
  position: "absolute",
  // Below the Pause / Reset / Fullscreen cluster (top centre) and left of the detail panel.
  top: 40,
  left: 8,
  display: "flex",
  alignItems: "center",
  gap: 8,
  maxWidth: "calc(100% - 16px)",
  padding: "3px 10px",
  borderRadius: 14,
  border: `1px solid ${AMBER}`,
  background: "rgba(40, 24, 2, 0.9)",
  color: "#fef3c7",
  font: "600 11px/1.3 system-ui, sans-serif",
  letterSpacing: 0.3,
  pointerEvents: "none",
  zIndex: 8,
  // Wrap rather than clip: the whole "recorded history, not live" notice must stay readable.
  flexWrap: "wrap",
  columnGap: 8,
};

/** Slim transport bar along the card's bottom edge (the expanded part is optional). */
const PANEL: React.CSSProperties = {
  position: "absolute",
  left: 8,
  right: 8,
  bottom: 8,
  padding: "5px 8px",
  border: `1px solid rgba(251, 191, 36, 0.55)`,
  borderRadius: 10,
  background: "rgba(14, 10, 4, 0.92)",
  color: "#e2e8f0",
  font: "12px/1.4 system-ui, sans-serif",
  boxShadow: "0 8px 24px -10px rgba(0, 0, 0, 0.8)",
  backdropFilter: "blur(10px)",
  pointerEvents: "auto",
  zIndex: 7,
};

const BTN: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 6,
  border: "1px solid rgba(251, 191, 36, 0.5)",
  background: "rgba(60, 38, 4, 0.7)",
  color: "#fef3c7",
  cursor: "pointer",
  font: "600 11px system-ui, sans-serif",
};

/** Moment chip colours (all >= 4.5:1 on the bar background). */
const MOMENT_COLOR: Record<string, string> = {
  quiet: "#d6d3d1",
  "in-flight": "#5eead4",
  completed: "#86efac",
  failed: "#fca5a5",
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

function clockTime(ms: number): string {
  return fmtTime(ms).slice(11);
}

export function AtomicReplayPanel({
  controller,
  onExit,
  reservedRight = 0,
  initialExpanded = false,
}: {
  controller: ReplayController;
  onExit: () => void;
  /** Right inset (px) kept clear for another panel (the detail panel): limits the marker width. */
  reservedRight?: number;
  initialExpanded?: boolean;
}) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView, controller.getView);
  const [expanded, setExpanded] = useState(initialExpanded);
  const sectionRef = useRef<HTMLElement | null>(null);
  const open = view.phase !== "closed";
  // Publish the bar's height so the legend and the detail panel reflow above it (never overlap).
  useEffect(() => {
    const el = sectionRef.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const publish = () =>
      host.style.setProperty("--atomic-replay-inset", `${el.offsetHeight + 8}px`);
    publish();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      host.style.removeProperty("--atomic-replay-inset");
    };
  }, [open]);
  if (view.phase === "closed") return null;
  const clock = view.clock;
  const empty = view.phase === "ready" && view.recordCount === 0;
  const ready = view.phase === "ready" && clock != null && !empty;
  const moment = view.moment;
  const showStatus = !ready || expanded;
  return (
    <>
      <div
        data-atomic-replay-marker="true"
        role="status"
        aria-label="Replay mode: showing recorded history, not live data"
        style={{
          ...MARKER,
          maxWidth: `calc(100% - ${reservedRight + 16}px)`,
        }}
      >
        <strong>{replayMarkerText(view)}</strong>
        <span style={{ fontWeight: 400, opacity: 0.9 }}>recorded history, not live</span>
      </div>
      <section
        ref={sectionRef}
        data-atomic-replay-panel="true"
        data-expanded={expanded ? "true" : "false"}
        role="group"
        aria-label="Request replay controls"
        style={PANEL}
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
            title="Previous recorded event"
            onClick={() => controller.stepPrev()}
          >
            ◀
          </button>
          <button
            type="button"
            style={BTN}
            disabled={!ready}
            aria-label="Next recorded event"
            title="Next recorded event"
            onClick={() => controller.stepNext()}
          >
            ▶
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
          {ready && clock ? (
            <input
              type="range"
              aria-label="Replay position"
              aria-valuetext={fmtTime(clock.positionMs)}
              min={clock.startMs}
              max={clock.endMs}
              step={1000}
              value={clock.positionMs}
              onChange={(e) => controller.seek(Number(e.target.value))}
              style={{ flex: "1 1 60px", minWidth: 56, accentColor: AMBER }}
              data-progress={replayProgress(clock).toFixed(3)}
            />
          ) : (
            <span style={{ flex: "1 1 60px" }} />
          )}
          {ready && clock ? (
            <span
              data-atomic-replay-time="true"
              style={{ color: "#e7e5e4", fontVariantNumeric: "tabular-nums" }}
            >
              {clockTime(clock.positionMs)}
            </span>
          ) : null}
          {ready && moment ? (
            <span
              data-atomic-replay-moment={moment.state}
              aria-label={`Replayed moment, all providers: ${replayMomentLabel(moment)}`}
              title="What the recorded history shows across all providers at the playhead"
              style={{
                color: MOMENT_COLOR[moment.state],
                border: `1px solid ${MOMENT_COLOR[moment.state]}`,
                borderRadius: 999,
                padding: "0 8px",
                font: "600 11px system-ui, sans-serif",
                whiteSpace: "nowrap",
              }}
            >
              fleet · {replayMomentLabel(moment)}
            </span>
          ) : null}
          {ready && view.truncated ? (
            <span
              data-atomic-replay-truncated="true"
              title="The history page cap was reached; the oldest rows in this window are omitted."
              style={{ color: "#fcd34d", font: "600 11px system-ui, sans-serif" }}
            >
              history capped
            </span>
          ) : null}
          <button
            type="button"
            style={BTN}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse replay options" : "Expand replay options"}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Less ▾" : "More ▴"}
          </button>
          <button
            type="button"
            style={BTN}
            onClick={onExit}
            aria-label="Exit replay and return to live"
          >
            Exit replay
          </button>
        </div>
        {expanded ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                disabled={!ready}
                checked={clock?.loop === true}
                onChange={(e) => controller.setLoop(e.target.checked)}
              />
              Loop
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
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
            {ready && clock ? (
              <span style={{ marginLeft: "auto", color: "#d6d3d1" }}>
                {fmtTime(clock.startMs)} → {fmtTime(clock.endMs)}
              </span>
            ) : null}
          </div>
        ) : null}
        {showStatus ? (
          <div
            style={{ marginTop: 2, color: "#d6d3d1", fontSize: 11 }}
            data-atomic-replay-status="true"
          >
            {view.phase === "loading" ? "Loading recorded requests…" : null}
            {view.phase === "error" ? (
              <>
                {view.error}.{" "}
                <button
                  type="button"
                  style={BTN}
                  onClick={() => void controller.open(view.windowMs)}
                >
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
        ) : null}
      </section>
    </>
  );
}
