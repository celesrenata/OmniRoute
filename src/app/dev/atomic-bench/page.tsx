"use client";

/**
 * OR-ATOM-010 — Atomic material bench (T10.1a).
 *
 * A dev-only, deterministic bench host that renders the **real production**
 * `AtomicTopologyRenderer` (the exact React scene host the dashboard uses)
 * against the golden DEMO snapshot (`goldenSnapshot.ts`). The scene, layout,
 * camera fit, descriptor resolution and visual-encoding paths are all the real
 * ones — so a before/after material comparison is a true A/B: same positions,
 * same edges, same camera, same controls, same 2D fallback. Only the
 * material/shader pipeline changes.
 *
 * Determinism: `paused=1` (default) freezes the shared scene clock, so the
 * camera and electron spin hold at a fixed angle and captures are stable. The
 * discharge clock is the snapshot's own `capturedAt` (the renderer's contract),
 * never the wall clock.
 *
 * URL params (all optional):
 *   - `node=<id>`   focus the camera on this canonical atom (e.g.
 *                   `provider:bench-primary`). Absent → base fit ("default
 *                   zoom" framing).
 *   - `paused=1|0`  default `1` → frozen frame loop (stable captures).
 *   - `badge=0`     hide the DEMO provenance badge (clean material-only frame).
 *   - `quality=high|medium|low`  force a tier (iteration-e: makes headless
 *                   captures comparable across machines — the resolved tier
 *                   would otherwise follow the probe's hardware signals).
 *   - `bloom=…`    dev-only bloom override (iteration-e washout isolation):
 *                   `off` → direct render path (isolates the material/
 *                   OutputPass pipeline from bloom), `current` → the shipped
 *                   tier budget, or a named sweep candidate (`strict`, `s110`,
 *                   `s130`, `s160`, `s45130`, `t20`, `t25`, `t30`, `soft16`).
 *
 * Provenance (T10.8): every frame captured here is synthetic DEMO data — the
 * `data-provenance="DEMO"` attribute and badge say so; it is never a live
 * telemetry join.
 */
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import {
  createAtomicEventPool,
  mapLifecycleToAtomicEvents,
} from "@/plugins/atomic-topology/eventPool";
import { AtomicTopologyRenderer } from "@/plugins/atomic-topology/AtomicTopologyRenderer";
import type { AtomicSceneQuality, BloomBudget } from "@/plugins/atomic-topology/quality";

import { buildGoldenSnapshot } from "./goldenSnapshot";

/** Bench viewport (matches the scorecard capture size). */
export const BENCH_WIDTH = 1600;
export const BENCH_HEIGHT = 1000;

/**
 * Build the deterministic golden snapshot once (sync) and feed its lifecycle
 * stream into a fresh event pool at the snapshot's own capture time — the
 * same deterministic discharge clock the production renderer uses.
 */
/**
 * Parse the `?atoms=N` perf-ladder param (OR-ATOM-010 T10.6). Only the three
 * budget targets (8 / 16 / 32) are accepted; anything else falls back to the
 * golden default so a malformed URL never produces a bogus topology.
 */
function parseAtomCount(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return n === 8 || n === 16 || n === 32 ? n : undefined;
}

/**
 * Dev-only `?quality=` override (iteration-e): a forced tier so headless
 * captures are comparable. Anything else → the resolved tier.
 */
function parseQualityOverride(raw: string | null): AtomicSceneQuality | undefined {
  return raw === "high" || raw === "medium" || raw === "low" ? raw : undefined;
}

/**
 * Dev-only `?bloom=` override (iteration-e washout isolation). `current`
 * returns the tier's own budget (a no-op); anything else → the tier budget.
 */
function parseBloomOverride(raw: string | null): BloomBudget | undefined {
  if (raw === "off") return { enabled: false, strength: 0, radius: 0, threshold: 1 };
  // iteration-e washout candidates. Strength is the dominant brightness lever;
  // the linear-radiance threshold sets how much of the scene is the bloom
  // SOURCE (ACES pushes true emissives above 1.0, so a low threshold blooms
  // everything; a high one locks the halo to the neon cores). These sweep the
  // threshold at a fixed low strength.
  if (raw === "strict") return { enabled: true, strength: 0.35, radius: 0.4, threshold: 0.9 };
  if (raw === "s110") return { enabled: true, strength: 0.35, radius: 0.4, threshold: 1.1 };
  if (raw === "s130") return { enabled: true, strength: 0.35, radius: 0.35, threshold: 1.3 };
  if (raw === "s160") return { enabled: true, strength: 0.35, radius: 0.3, threshold: 1.6 };
  if (raw === "s45130") return { enabled: true, strength: 0.45, radius: 0.35, threshold: 1.3 };
  if (raw === "t20") return { enabled: true, strength: 0.35, radius: 0.3, threshold: 2.0 };
  if (raw === "t25") return { enabled: true, strength: 0.35, radius: 0.3, threshold: 2.5 };
  if (raw === "t30") return { enabled: true, strength: 0.35, radius: 0.3, threshold: 3.0 };
  if (raw === "soft16") return { enabled: true, strength: 0.25, radius: 0.3, threshold: 1.6 };
  return undefined;
}

function useBenchScene(atomCount: number | undefined) {
  return useMemo(() => {
    const snapshot = buildGoldenSnapshot(atomCount ? { atomCount } : {});
    const capturedAt = Number.isFinite(snapshot.capturedAt) ? snapshot.capturedAt : 0;
    const eventPool = createAtomicEventPool();
    for (const event of mapLifecycleToAtomicEvents(snapshot)) {
      eventPool.ingest(event, capturedAt);
    }
    return { snapshot, eventPool };
  }, [atomCount]);
}

export default function AtomicBenchPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            position: "relative",
            width: BENCH_WIDTH,
            height: BENCH_HEIGHT,
            background: "#05060f",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#93c5fd",
            font: "500 14px system-ui, sans-serif",
          }}
        >
          atomic bench loading…
        </div>
      }
    >
      <BenchBody />
    </Suspense>
  );
}

function BenchBody() {
  const searchParams = useSearchParams();
  const focusNodeId = searchParams.get("node");
  const paused = searchParams.get("paused") !== "0";
  const showBadge = searchParams.get("badge") !== "0";
  const atomCount = parseAtomCount(searchParams.get("atoms"));
  const qualityOverride = parseQualityOverride(searchParams.get("quality"));
  const bloomOverride = parseBloomOverride(searchParams.get("bloom"));

  const { snapshot, eventPool } = useBenchScene(atomCount);
  const [ready, setReady] = useState(false);
  const hostRef = useRef<HTMLElement | null>(null);

  // The scene module loads client-side (async `import` in the renderer host);
  // the canvas appears once it resolves. Detect the first `canvas` as "ready"
  // so the capture can gate on it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const check = () => {
      if (host.querySelector("canvas")) {
        setReady(true);
      }
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <main
      data-atomic-bench="true"
      data-provenance="DEMO"
      data-ready={ready ? "true" : "false"}
      ref={hostRef}
      style={{
        position: "relative",
        width: BENCH_WIDTH,
        height: BENCH_HEIGHT,
        background: "#05060f",
        overflow: "hidden",
      }}
    >
      <AtomicTopologyRenderer
        snapshot={snapshot}
        size={{ width: BENCH_WIDTH, height: BENCH_HEIGHT }}
        paused={paused}
        resetToken={1}
        focusNodeId={focusNodeId}
        eventPool={eventPool}
        options={{ emptyStateLabel: "Atomic bench: WebGL2 unavailable" }}
        qualityOverride={qualityOverride}
        bloomOverride={bloomOverride}
      />
      {showBadge && (
        <div
          data-bench-badge="DEMO"
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            padding: "4px 10px",
            borderRadius: 6,
            background: "rgba(5,6,15,0.6)",
            border: "1px solid rgba(96,165,250,0.35)",
            color: "#bfdbfe",
            font: "600 12px/1.2 system-ui, sans-serif",
            letterSpacing: 0.3,
            pointerEvents: "none",
            userSelect: "none",
          }}
        >
          DEMO · golden snapshot · {focusNodeId ? `focus ${focusNodeId}` : "default zoom"}
          {" · "}
          {paused ? "paused" : "live"}
        </div>
      )}
    </main>
  );
}
