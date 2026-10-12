---
title: Atomic Topology User Guide (OR-ATOM-001 v2)
---

# Atomic Topology — User Guide

The home page **Provider Topology** card visualizes your OmniRoute gateway:
the central router ("hub") and every connected provider, with live activity.
You can view it two ways:

- **2D (default)** — the original node/edge diagram. Fast, lightweight, and the
  view you see by default.
- **3D "Atomic"** — an experimental WebGL2 scene that renders each provider as
  an "atom" (a nucleus with orbiting electron clouds). Available only when your
  browser supports WebGL2.

## Switching between 2D and 3D

The card has a small **`2D | 3D`** toggle in its top-left corner.

1. Click **`3D`** to switch to the Atomic renderer.
2. If your browser lacks WebGL2, or the 3D renderer fails to start, the panel
   **automatically falls back to 2D** and shows a brief notice
   ("Topology renderer unavailable — showing the 2D view."). Nothing breaks.
3. Click **`2D`** any time to return. Your choice is remembered in your
   browser (localStorage) and restored on your next visit.

> **Note:** On first load the card always starts in 2D. The 3D view is strictly
> opt-in so the default page stays fast and works in every browser.

## What the views show

Both views render the **same underlying data** — provider identity, health,
and traffic state. The difference is presentation:

- **2D** — nodes and edges, colored by health/traffic
  (error > active > last-used > healthy > idle), laid out in concentric rings
  around the router. Click a provider to open its page.
- **3D** — each provider is an atom; the router is the hub. Electron-cloud hue
  encodes the request/job lane observed from that provider's **live in-flight
  traffic** (e.g. a provider serving `whisper-*` models shows the audio hue).
  A provider with no classifiable in-flight traffic — or no traffic at all —
  shows a neutral hue; OmniRoute never invents a lane.

## Interactions

- **2D:** hover for details, click a provider node to navigate to its page,
  use the **Zoom In / Zoom Out / Fit View** controls.
- **3D:** **drag to orbit**, **scroll (or pinch) to zoom**, **right-drag to
  pan** the camera around the router; hover a provider for a tooltip and
  label; the legend explains the color and motion encoding.

## What is _not_ shown (by design)

OmniRoute never invents facts. You will **not** see:

- Physical GPU/device details for remote providers (OpenAI, xAI, Bedrock, …).
  A remote provider stays a **provider** node unless a physically exposed,
  authorized telemetry source reports a real device.
- Synthetic throughput or latency. Provider-level output throughput is shown
  only when it is correctly instrumented; otherwise the view shows _unknown_.

When a metric has no data source, the view decays to a neutral state instead
of displaying a made-up number.

## Experimental 3D: current scope

The Atomic (3D) renderer is an early, opt-in feature. As of this release:

- It renders the provider atoms, hub, and a legend/controls overlay.
- The camera is interactive: orbit / zoom / pan (see _Interactions_).
- It renders from core-owned data. Live telemetry-driven motion (measured
  token rates, GPU utilization, job-lane hues) is enabled as telemetry
  sources are configured — see the implementation report for the milestone
  plan.

If the 3D view feels rough, switch back to 2D — that is the stable,
production default.

## Troubleshooting

| Symptom                         | Likely cause                                                                                   | Resolution                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3D falls back to 2D immediately | No WebGL2, or renderer threw on start                                                          | Use 2D; the notice confirms the fallback. Hardware-accelerated WebGL2 is required for 3D.                                                                                                              |
| No providers shown              | No providers connected yet                                                                     | Connect a provider; the card shows an empty state until then.                                                                                                                                          |
| 3D shows "unknown" lane colors  | No in-flight traffic on that provider, or its in-flight models are not a recognized job family | Expected — lane hues come from live traffic and are never guessed. A provider with no in-flight traffic, or traffic that isn't a recognized family (e.g. ordinary chat models), keeps the neutral hue. |
| 3D camera won't move            | Orbit controls unavailable (very old GPU / WebGL2 quirks)                                      | The scene still renders and updates; use 2D for a stable view. Hardware-accelerated WebGL2 gives the full orbit/zoom/pan experience.                                                                   |

## Where to read more

- Architecture, deferrals, and test evidence:
  `docs/specs/atomic-topology-implementation-report.md`.
- Telemetry field audit (what exists vs. what is unavailable):
  `docs/specs/atomic-topology-telemetry-matrix.md`.
