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
import type { BloomBudget } from "@/plugins/atomic-topology/quality";

import { buildGoldenSnapshot } from "./goldenSnapshot";
import {
  GoldenAtomBench,
  type GoldenBenchParams,
} from "@/plugins/atomic-topology/dev/GoldenAtomBench";

/** Bench viewport (matches the scorecard capture size). */
export const BENCH_WIDTH = 1600;
export const BENCH_HEIGHT = 1000;

/**
 * Build the deterministic golden snapshot once (sync) and feed its lifecycle
 * stream into a fresh event pool at the snapshot's own capture time — the
 * same deterministic discharge clock the production renderer uses.
 */
/**
 * Parse the `?atoms=N` perf-ladder param (OR-ATOM-010 T10.6). Only the
 * budget targets (8 / 16 / 20 / 32) are accepted; anything else falls back to the
 * golden default so a malformed URL never produces a bogus topology.
 */
function parseAtomCount(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return n === 8 || n === 16 || n === 20 || n === 32 ? n : undefined;
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

function useBenchScene(
  atomCount: number | undefined,
  opts: { allIdle?: boolean; errorPhase?: "error" | "recovered" } = {}
) {
  const { allIdle, errorPhase } = opts;
  return useMemo(() => {
    const snapshot = buildGoldenSnapshot({
      ...(atomCount ? { atomCount } : {}),
      allIdle,
      errorPhase,
    });
    const capturedAt = Number.isFinite(snapshot.capturedAt) ? snapshot.capturedAt : 0;
    const eventPool = createAtomicEventPool();
    for (const event of mapLifecycleToAtomicEvents(snapshot)) {
      eventPool.ingest(event, capturedAt);
    }
    return { snapshot, eventPool };
  }, [atomCount, allIdle, errorPhase]);
}

/**
 * `?failure=cycle` (DEMO): the error provider recovers for 3 s, then fails
 * again, every 6 s, so the scene shows the real failure transition (red
 * branching bolt + nucleus flash) instead of a static error.
 */
function useFailureCycle(enabled: boolean): "error" | "recovered" {
  const [phase, setPhase] = useState<"error" | "recovered">("error");
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setPhase((p) => (p === "error" ? "recovered" : "error")), 3000);
    return () => clearInterval(id);
  }, [enabled]);
  return phase;
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
      <BenchRouter />
    </Suspense>
  );
}

/** `?atomic-fx=rt` routes to the isolated ray-traced golden-atom bench (Gate A). */
function BenchRouter() {
  const sp = useSearchParams();
  const pick = <T extends string>(k: string, allowed: readonly T[], d: T): T => {
    const v = sp.get(k);
    return allowed.includes(v as T) ? (v as T) : d;
  };
  const params = useMemo<GoldenBenchParams | null>(() => {
    if (sp.get("atomic-fx") !== "rt") return null;
    const t = sp.get("t");
    return {
      golden: pick("golden", ["provider", "gpu", "hub"] as const, "provider"),
      dist: pick("dist", ["default", "close"] as const, "default"),
      models: pick("models", ["1", "3", "unknown", "stale"] as const, "3"),
      energy: pick("energy", ["idle", "excited", "both"] as const, "excited"),
      az: Number(sp.get("az") ?? 0) || 0,
      t: t != null && Number.isFinite(Number(t)) ? Number(t) : null,
      paused: sp.get("paused") === "1",
      backend: sp.get("backend") === "webgl" ? "webgl" : "webgpu",
      bloom: sp.get("bloom") !== "0",
      reduced: sp.get("reduced") === "1",
      badge: sp.get("badge") !== "0",
      width: Number(sp.get("w")) || 1672,
      height: Number(sp.get("h")) || 941,
      count: Math.min(32, Math.max(1, Math.floor(Number(sp.get("count")) || 1))),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);
  return params ? <GoldenAtomBench params={params} /> : <BenchBody />;
}
function BenchBody() {
  const searchParams = useSearchParams();
  const focusNodeId = searchParams.get("node");
  const paused = searchParams.get("paused") !== "0";
  const showBadge = searchParams.get("badge") !== "0";
  const atomCount = parseAtomCount(searchParams.get("atoms"));
  const bloomOverride = parseBloomOverride(searchParams.get("bloom"));

  const errorPhase = useFailureCycle(searchParams.get("failure") === "cycle");
  const allIdle = searchParams.get("idle") === "1";
  const { snapshot, eventPool } = useBenchScene(atomCount, { allIdle, errorPhase });
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
          {allIdle ? " · all idle (no measured activity)" : ""}
          {searchParams.get("failure") === "cycle" ? ` · failure cycle (${errorPhase})` : ""}
          {" · "}
          {paused ? "paused" : "live"}
        </div>
      )}
    </main>
  );
}
