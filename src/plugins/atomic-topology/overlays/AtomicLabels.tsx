/**
 * Atomic labels overlay — DOM labels associated with the rendered atoms
 * (OR-ATOM-001 v2, UX correction replacing the detached bottom-right roster).
 *
 * Two presentation modes, chosen by projection availability:
 *
 * 1. **Projected labels** (the default once the scene has written at least one
 *    frame — `cameraState.valid`): each atom gets a compact DOM label positioned
 *    next to its *on-screen* position, projected from the live camera (position
 *    + orbit target + viewport size) written every frame into the shared
 *    {@link AtomicCameraState}. The position updates run in a
 *    `requestAnimationFrame` loop that mutates `transform` directly — no React
 *    re-render, no `three` import (the math lives in the pure `../projection`).
 * 2. **Compact roster fallback** (bottom-right): shown while projection is not
 *    safely available — before the first scene frame, when the 3D canvas is
 *    absent (WebGL2 unavailable → the host's empty state), or when the scene
 *    module has not loaded yet.
 *
 * Interaction (both modes): selecting an atom
 *   - calls `onFocusRequest(atomId)` to center the view on that atom, and
 *   - for provider atoms, calls `onProviderClick(providerId)` (the host's
 *     delegated provider-click).
 *
 * Keyboard: every label is a real `<button>` (Tab-reachable, Enter/Space
 * activate, `aria-pressed` reflects the focused atom), so the 3D view stays
 * operable without a pointer.
 *
 * Pure React + CSS only (no `three` / R3F) — safe under jsdom.
 */
import { useEffect, useRef } from "react";

import type { AtomVisualDescriptor } from "../AtomicTopologyRenderer";
import { createProjector } from "../projection";
import type { AtomicCameraState } from "../scene/sceneContext";

/**
 * The atomic labels overlay.
 *
 * @param descriptors    the atom descriptors (one label/row per atom).
 * @param focusNodeId    the atom currently centered (highlighted).
 * @param onProviderClick delegated provider-click (provider atoms only).
 * @param onFocusRequest  let the host center the view on an atom.
 * @param cameraState     the shared per-frame camera snapshot the scene writes
 *   (the projected-label mode). When `undefined` or `valid === false`, the
 *   compact roster fallback is rendered.
 */
export function AtomicLabels({
  descriptors,
  focusNodeId,
  onProviderClick,
  onFocusRequest,
  cameraState,
}: {
  descriptors: AtomVisualDescriptor[];
  focusNodeId: string | null;
  onProviderClick: (providerId: string) => void;
  onFocusRequest?: (nodeId: string) => void;
  cameraState?: AtomicCameraState;
}) {
  // Projection is usable only once the scene has written at least one frame
  // and reported a non-degenerate viewport.
  const projected =
    cameraState != null &&
    cameraState.valid &&
    cameraState.viewportWidth > 0 &&
    cameraState.viewportHeight > 0;

  if (!projected) {
    return (
      <RosterFallback
        descriptors={descriptors}
        focusNodeId={focusNodeId}
        onProviderClick={onProviderClick}
        onFocusRequest={onFocusRequest}
      />
    );
  }

  return (
    <ProjectedLabels
      descriptors={descriptors}
      focusNodeId={focusNodeId}
      onProviderClick={onProviderClick}
      onFocusRequest={onFocusRequest}
      cameraState={cameraState}
    />
  );
}

/**
 * The shared selection behavior: center the view on the atom, and fire the
 * delegated provider-click for provider atoms.
 */
function useAtomSelection(
  onProviderClick: (providerId: string) => void,
  onFocusRequest?: (nodeId: string) => void
) {
  return (descriptor: AtomVisualDescriptor) => {
    onFocusRequest?.(descriptor.id);
    if (descriptor.kind !== "hub" && descriptor.providerId) {
      onProviderClick(descriptor.providerId);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Projected mode — one label per atom, positioned next to the atom    */
/* ------------------------------------------------------------------ */

/** The on-screen offset (CSS px) between the projected atom center and the
 *  label anchor, so the label sits just above its atom instead of on it. */
const LABEL_OFFSET_Y = -28;

function ProjectedLabels({
  descriptors,
  focusNodeId,
  onProviderClick,
  onFocusRequest,
  cameraState,
}: {
  descriptors: AtomVisualDescriptor[];
  focusNodeId: string | null;
  onProviderClick: (providerId: string) => void;
  onFocusRequest?: (nodeId: string) => void;
  cameraState: AtomicCameraState;
}) {
  const handleSelect = useAtomSelection(onProviderClick, onFocusRequest);

  // One stable node ref per atom (snapshot order). The rAF loop projects each
  // atom against the *live* camera state and mutates `transform`/visibility.
  const labelRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // The loop re-runs when the descriptor set changes (a new snapshot identity)
  // or when the host re-creates the shared camera state; `cameraState` itself
  // is a stable mutable object read fresh every frame.
  useEffect(() => {
    let raf = 0;
    const labels = descriptors;

    const tick = () => {
      if (labels.length > 0) {
        const project = createProjector(
          {
            position: cameraState.position,
            target: cameraState.target,
            fovDeg: cameraState.fovDeg,
            aspect: cameraState.aspect,
          },
          {
            width: cameraState.viewportWidth,
            height: cameraState.viewportHeight,
          }
        );

        for (const descriptor of labels) {
          const el = labelRefs.current[descriptor.id];
          if (!el) continue;
          const p = project([descriptor.position.x, descriptor.position.y, descriptor.position.z]);
          // Hide when behind the camera, when projected far outside the
          // viewport (margin = label half-width, so re-entry is smooth), or
          // when the projection is degenerate.
          const marginX = 80;
          const offscreen =
            p.behind ||
            p.x < -marginX ||
            p.x > cameraState.viewportWidth + marginX ||
            p.y < -marginX ||
            p.y > cameraState.viewportHeight + marginX;
          if (offscreen) {
            el.style.visibility = "hidden";
            el.style.pointerEvents = "none";
          } else {
            el.style.visibility = "visible";
            el.style.pointerEvents = "auto";
            el.style.transform = `translate(${p.x}px, ${p.y + LABEL_OFFSET_Y}px)`;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cameraState, descriptors]);

  return (
    <div
      className="atomic-labels atomic-labels--projected"
      data-atomic-labels="projected"
      role="list"
      aria-label="Topology atoms"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {descriptors.map((descriptor) => {
        const isFocused = focusNodeId === descriptor.id;
        const state = descriptor.visualState.state;
        const rowClass = [
          "atomic-labels__row",
          "atomic-labels__row--projected",
          descriptor.kind === "hub" ? "atomic-labels__row--hub" : "atomic-labels__row--atom",
          `atomic-labels__row--${state}`,
          isFocused ? "is-focused" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <button
            key={descriptor.id}
            type="button"
            ref={(el) => {
              labelRefs.current[descriptor.id] = el;
            }}
            className={rowClass}
            data-atom-id={descriptor.id}
            data-kind={descriptor.kind}
            data-visual-state={state}
            data-focused={isFocused ? "true" : "false"}
            aria-pressed={isFocused}
            aria-label={`${descriptor.label} — atom, ${state}`}
            onClick={() => handleSelect(descriptor)}
            // Initial hidden state; the rAF loop positions + reveals it on the
            // first frame.
            style={{ visibility: "hidden" }}
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

/* ------------------------------------------------------------------ */
/* Roster fallback — compact bottom-right panel (pre-frame / no-WebGL) */
/* ------------------------------------------------------------------ */

function RosterFallback({
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
  const handleSelect = useAtomSelection(onProviderClick, onFocusRequest);

  return (
    <div
      className="atomic-labels atomic-labels--roster"
      data-atomic-labels="roster"
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

        return (
          <button
            key={descriptor.id}
            type="button"
            className={rowClass}
            data-atom-id={descriptor.id}
            data-kind={descriptor.kind}
            data-visual-state={state}
            data-focused={isFocused ? "true" : "false"}
            aria-pressed={isFocused}
            aria-label={`${descriptor.label} — atom, ${state}`}
            onClick={() => handleSelect(descriptor)}
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
