/**
 * Neutral cover shown over the whole scene while a replay session is loading (or failed to
 * load). Without it the LIVE scene would sit under the amber REPLAY banner until the recorded
 * history arrives, which reads as replayed data. The cover is opaque, static (no animation, so
 * it is the same under reduced motion) and sits below the replay marker and controls so Exit /
 * Retry stay reachable.
 */
import { useSyncExternalStore } from "react";
import type { ReplayController } from "../scene/replayController";

export function replayCoverVisible(phase: string): boolean {
  return phase === "loading" || phase === "error";
}

export function AtomicReplayCover({ controller }: { controller: ReplayController }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView, controller.getView);
  if (!replayCoverVisible(view.phase)) return null;
  return (
    <div
      data-atomic-replay-cover={view.phase}
      role="status"
      aria-live="polite"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#05070f",
        color: "#a8a29e",
        font: "13px/1.4 system-ui, sans-serif",
        pointerEvents: "auto",
      }}
    >
      {view.phase === "loading"
        ? "Loading recorded requests…"
        : "Recorded history unavailable. Use Retry or Exit replay."}
    </div>
  );
}
