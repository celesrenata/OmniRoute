/**
 * Frame-rate policy for the Atomic renderer (operator directive 45).
 *
 * Default: a fixed 30 fps target. The renderer's own rAF loop asks the throttle on every tick;
 * a tick that is not due does nothing at all (no scene update, no GPU submit). "Sync to display
 * refresh rate" (persisted per browser) renders on every rAF tick instead.
 *
 * Pure module (no React, no three) so the throttle is unit-testable.
 */

/** Default target frame rate. */
export const TARGET_FPS = 30;
/** localStorage key of the "Sync to display refresh rate" preference ("1" = synced). */
export const SYNC_REFRESH_KEY = "omniroute.atomic.syncRefresh";

/**
 * Lateness tolerance: a tick up to this many ms before the next deadline still renders. rAF
 * timestamps jitter around the display period, so with no tolerance a 60 Hz display would
 * alternate between 2- and 3-tick gaps (24 fps) instead of holding 2 ticks (30 fps).
 */
const TOLERANCE_MS = 2;

export interface FrameThrottle {
  /** True when a frame should be rendered at `nowMs` (rAF timestamp); records it if so. */
  due: (nowMs: number) => boolean;
  /** Forget the cadence (after a pause in the loop: the next tick renders). */
  reset: () => void;
}

/**
 * Deadline throttle. Renders when `now >= last + interval - tolerance`, then advances the
 * deadline by exactly one interval, so the long-run cadence is the target rate on any refresh
 * rate (60 Hz: every 2nd tick; 120 Hz: every 4th; 144 Hz: alternating 5/4 ticks). After a long
 * stall (more than two intervals late) the cadence re-anchors to `now` instead of bursting.
 * `fps <= 0` or non-finite = unthrottled (every tick).
 */
export function createFrameThrottle(fps: number = TARGET_FPS): FrameThrottle {
  const interval = Number.isFinite(fps) && fps > 0 ? 1000 / fps : 0;
  let last = Number.NaN;
  return {
    due(nowMs) {
      if (interval === 0) return true;
      if (!Number.isFinite(nowMs)) return false;
      if (!Number.isFinite(last)) {
        last = nowMs;
        return true;
      }
      const since = nowMs - last;
      if (since < interval - TOLERANCE_MS) return false;
      last = since > interval * 2 ? nowMs : last + interval;
      return true;
    },
    reset() {
      last = Number.NaN;
    },
  };
}

/** Read the persisted preference (SSR / blocked storage => false, the 30 fps default). */
export function readSyncRefresh(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(SYNC_REFRESH_KEY) === "1";
  } catch {
    return false;
  }
}

const listeners = new Set<(sync: boolean) => void>();

/** Persist and broadcast the preference (the renderer loop and the checkbox both listen). */
export function writeSyncRefresh(
  sync: boolean,
  storage: Pick<Storage, "setItem"> | null = safeStorage()
): void {
  try {
    storage?.setItem(SYNC_REFRESH_KEY, sync ? "1" : "0");
  } catch {
    /* storage blocked: the choice still applies for this page */
  }
  current = sync;
  for (const l of listeners) l(sync);
}

let current: boolean | null = null;

/** Current preference (read once from storage, then kept in memory). */
export function getSyncRefresh(): boolean {
  if (current === null) current = readSyncRefresh();
  return current;
}

/** Subscribe to preference changes; returns the unsubscribe function. */
export function subscribeSyncRefresh(fn: (sync: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** OrbitControls damping per update at the 60 fps reference (the approved feel). */
export const ORBIT_DAMPING_60 = 0.08;

/**
 * Frame-rate-independent OrbitControls damping (directive 45): three's damping decays the
 * remaining orbit motion by `(1 - dampingFactor)` per `update()`, i.e. per FRAME. Scaling it
 * by the frame's elapsed time keeps the glide the same length in seconds at 30 fps and at any
 * refresh rate (identical to before at 60 fps).
 */
export function orbitDampingFor(deltaSeconds: number, base60: number = ORBIT_DAMPING_60): number {
  const dt = Number.isFinite(deltaSeconds) ? Math.min(Math.max(deltaSeconds, 0), 0.1) : 1 / 60;
  if (dt === 0) return base60;
  return 1 - Math.pow(1 - base60, dt * 60);
}
