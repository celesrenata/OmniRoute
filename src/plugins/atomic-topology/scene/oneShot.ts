/**
 * One-shot event bookkeeping for the Atomic scene (OR-ATOM-007).
 *
 * Pure (no `three`, no DOM, no `Math.random`). Books single-shot visual
 * impulses driven ONLY by existing visual-state evidence — a state
 * transition, never fabricated motion:
 *
 * - **completion**: a link/atom transitions *into* `last` → one teal flash
 *   (~350 ms, sharp ease-out, interaction-design "one-shot impulse" band).
 * - **failure**: a link/atom transitions *into* `error` → one red
 *   lightning burst (~1.2 s exponential decay, no loop).
 *
 * The event fires ONCE per transition edge: `bookTransition` returns an event
 * only when `prev !== next` (the scene calls it exactly when the resolved
 * state changes), so a steady error state never re-fires — only the faint
 * static failure filament remains (see `EnergyLink`).
 */
import { easeOutSharp, pulsePhase } from "./motion";
import { decayEnvelope } from "./discharge";

/** Duration of the teal completion flash (~350 ms, spec). */
export const COMPLETION_FLASH_MS = 350;
/** Duration of the red failure lightning burst (~1.2 s, spec). */
export const FAILURE_BURST_MS = 1200;

/** A visual state the scene resolves (mirrors `AtomicVisualState`). */
export type OneShotState = "error" | "active" | "last" | "healthy" | "idle";

/** A booked one-shot impulse. */
export interface OneShotEvent {
  kind: "completion" | "failure";
  /** Scene-time (seconds) when the impulse started. */
  startAt: number;
  /** Impulse duration in seconds. */
  duration: number;
}

/**
 * Book a one-shot event for a state transition.
 *
 * Returns:
 * - `kind:"completion"` when `next === "last"` and `prev !== next`.
 * - `kind:"failure"` when `next === "error"` and `prev !== next`.
 * - `null` otherwise (no transition edge, or a transition that is not
 *   completion/failure — those are continuous states, not impulses).
 *
 * Deterministic + edge-triggered: identical (prev, next) with `prev === next`
 * yields `null`, which is the "fires once, never again" dedupe pin.
 */
export function bookTransition(
  prev: OneShotState,
  next: OneShotState,
  nowSeconds: number
): OneShotEvent | null {
  if (prev === next) return null;
  if (next === "last") {
    return { kind: "completion", startAt: nowSeconds, duration: COMPLETION_FLASH_MS / 1000 };
  }
  if (next === "error") {
    return { kind: "failure", startAt: nowSeconds, duration: FAILURE_BURST_MS / 1000 };
  }
  return null;
}

/**
 * Intensity of a booked one-shot impulse at scene-time `t`.
 *
 * - `completion`: `1 - easeOutSharp(phase)` — a sharp ease-out flash that
 *   starts at full intensity and decays to 0 over the 350 ms duration.
 * - `failure`: {@link decayEnvelope} — an exponential-decay burst over the
 *   1.2 s duration.
 *
 * Returns 0 when `t` is before `startAt` or at/after `startAt + duration`
 * (single-shot: never re-plays). Bounded to [0, 1].
 */
export function oneShotIntensity(event: OneShotEvent, tSeconds: number): number {
  const elapsed = tSeconds - event.startAt;
  if (elapsed <= 0) return 1;
  if (elapsed >= event.duration) return 0;
  if (event.kind === "completion") {
    const phase = pulsePhase(elapsed, event.duration);
    return 1 - easeOutSharp(phase);
  }
  return decayEnvelope(elapsed, event.duration);
}
