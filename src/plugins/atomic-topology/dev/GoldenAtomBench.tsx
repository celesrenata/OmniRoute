"use client";
/**
 * Gate A golden-atom bench (dev only, behind `?atomic-fx=rt`).
 *
 * Renders ONE golden atom (or an idle-vs-excited pair) with the ray-traced
 * renderer, using the production primitives (`buildNucleusCluster`,
 * `modelColor`, `laneHue`, `nucleusMotion`). All data is synthetic DEMO data
 * and is labelled as such; an idle atom is labelled "idle, no measured
 * activity" so decorative low-energy motion is never read as workload.
 *
 * Params: golden=provider|gpu|hub, dist=default|close, models=1|3|unknown|stale,
 * energy=idle|excited|both, az=<deg>, t=<seconds> (deterministic capture time),
 * paused=1|0, backend=webgpu|webgl, bloom=0|1, reduced=1, badge=0.
 *
 * No per-frame React state: the loop mutates preallocated uniforms only.
 */
import { useEffect, useRef } from "react";
import { PerspectiveCamera, Scene } from "three/webgpu";
import { tpsToRadiansPerSecond } from "../scene/nucleusMotion";
import {
  advanceAnimationPhase,
  energyFromActivity,
  resolveEnergyState,
  type EnergyState,
} from "../scene/energyState";
import { createEnvironment, FLOOR_Y } from "../scene/shaders/environment";
import { createRtAtom, type RtAtom } from "../scene/rt/rtAtom";
import { createRtRegistry } from "../scene/rt/rtRegistry";
import { createRtRenderer, type RtRenderer } from "../scene/rt/rendererFactory";
import { laneHue } from "../visualEncoding";

export interface GoldenBenchParams {
  golden: "provider" | "gpu" | "hub";
  dist: "default" | "close";
  models: "1" | "3" | "unknown" | "stale";
  energy: "idle" | "excited" | "both";
  az: number;
  t: number | null;
  paused: boolean;
  backend: "webgpu" | "webgl";
  bloom: boolean;
  reduced: boolean;
  badge: boolean;
  width: number;
  height: number;
}

const MODEL_SETS: Record<string, string[] | undefined> = {
  "1": ["ds4-glm53"],
  "3": ["ds4-glm53", "qwen3.5-9b", "qwen3.8-27b"],
  unknown: undefined,
  stale: undefined,
};

function energyFor(kind: "idle" | "excited", stale: boolean, reduced: boolean): EnergyState {
  if (kind === "idle" || stale)
    return resolveEnergyState({
      measuredTps: null,
      activeRequests: null,
      queued: null,
      stale: true,
      reducedMotion: reduced,
    });
  return resolveEnergyState({
    measuredTps: 140,
    activeRequests: 4,
    queued: 0,
    stale: false,
    reducedMotion: reduced,
  });
}

export function GoldenAtomBench({ params }: { params: GoldenBenchParams }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    let disposed = false;
    let raf = 0;
    let rtRenderer: RtRenderer | null = null;
    const registry = createRtRegistry();
    const reduced =
      params.reduced ||
      (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    const stale = params.models === "stale";

    const scene = new Scene();
    const camera = new PerspectiveCamera(32, params.width / params.height, 1, 6000);
    const env = createEnvironment();
    env.objects.forEach((o) => scene.add(o));
    registry.add(env);

    const pair = params.energy === "both";
    const kinds: ("idle" | "excited")[] = pair ? ["idle", "excited"] : [params.energy];
    const atoms: {
      atom: RtAtom;
      energy: EnergyState;
      kind: "idle" | "excited";
      phase: number;
      spin: number;
    }[] = [];
    kinds.forEach((kind, i) => {
      const ids = MODEL_SETS[params.models];
      const x = pair ? (i === 0 ? -78 : 78) : 0;
      const atom = createRtAtom(
        {
          id: `${params.golden}:bench-${params.golden}`,
          hub: params.golden === "hub",
          observedModelIds: params.golden === "hub" ? undefined : ids,
          laneHue: laneHue("prefill"),
          position: [x, 0, 0],
          neutral: params.golden === "hub" ? false : !ids || stale,
        },
        registry
      );
      env.objects.length && scene.add(atom.group);
      atoms.push({ atom, energy: energyFor(kind, stale, reduced), kind, phase: 0, spin: 0 });
    });

    const dist = params.dist === "close" ? 118 : pair ? 400 : 255;
    const az = (params.az * Math.PI) / 180;
    const el = 0.17;
    camera.position.set(
      Math.sin(az) * Math.cos(el) * dist,
      Math.sin(el) * dist + 6,
      Math.cos(az) * Math.cos(el) * dist
    );
    camera.lookAt(0, params.dist === "close" ? 0 : -6, 0);
    camera.updateMatrixWorld(true);

    const steps =
      Number(new URLSearchParams(location.search).get("steps")) ||
      (params.dist === "close" ? 48 : 48);
    let last = performance.now();
    let frames = 0;

    const frame = (nowMs: number) => {
      if (disposed || !rtRenderer) return;
      const dt = Math.min(Math.max((nowMs - last) / 1000, 0), 0.1);
      last = nowMs;
      camera.updateMatrixWorld(true);
      for (const a of atoms) {
        if (params.t != null) {
          a.phase = params.t * a.energy.speedMul;
          a.spin = a.energy.measured ? params.t * tpsToRadiansPerSecond(140) : 0;
        } else if (!params.paused) {
          a.phase = advanceAnimationPhase(a.phase, dt, a.energy.speedMul, reduced);
          a.spin += a.energy.measured && !reduced ? tpsToRadiansPerSecond(140) * dt : 0;
        }
        a.atom.update({
          dt: params.paused || params.t != null ? 0 : dt,
          camera,
          energy: a.energy,
          phase: a.phase,
          spinAngle: a.spin,
          reducedMotion: reduced,
          marchSteps: steps,
          time: nowMs / 1000,
        });
      }
      (env.time as { value: number }).value = reduced ? 0 : (params.t ?? nowMs / 1000);
      rtRenderer.render();
      frames += 1;
      if (frames === 3) {
        host.dataset.ready = "true";
        host.dataset.backend = rtRenderer.backend;
      }
      const still = params.paused || params.t != null || reduced;
      if (!still || frames < 6) raf = requestAnimationFrame(frame);
    };

    void createRtRenderer({
      canvas,
      scene,
      camera,
      width: params.width,
      height: params.height,
      forceWebGL: params.backend === "webgl",
      bloom: params.bloom,
      onDeviceLost: (reason) => {
        if (reason === "destroyed") return; // our own dispose, not a loss
        host.dataset.state = `device-lost:${reason}`;
      },
    })
      .then((r) => {
        if (disposed) {
          r.dispose();
          return;
        }
        rtRenderer = r;
        raf = requestAnimationFrame(frame);
      })
      .catch((error: unknown) => {
        host.dataset.state = "error";
        host.dataset.error = error instanceof Error ? error.message : "renderer init failed";
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      registry.disposeAll();
      rtRenderer?.dispose();
      rtRenderer = null;
    };
  }, [params]);

  const stale = params.models === "stale";
  const label = (kind: "idle" | "excited") =>
    kind === "idle"
      ? "IDLE — lower energy state · no measured activity (decorative drift)"
      : "EXCITED — measured activity (DEMO values)";

  return (
    <div
      ref={hostRef}
      data-atomic-bench="rt"
      data-provenance="DEMO"
      style={{
        position: "relative",
        width: params.width,
        height: params.height,
        background: "#02040c",
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: params.width, height: params.height, display: "block" }}
      />
      {params.badge && (
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
            font: "600 12px/1.3 system-ui, sans-serif",
            pointerEvents: "none",
          }}
        >
          DEMO · {params.golden} atom · models={params.models} ·{" "}
          {params.energy === "both"
            ? "idle vs excited"
            : label(params.energy as "idle" | "excited")}{" "}
          · {params.dist}
          {stale ? " · STALE telemetry" : ""}
        </div>
      )}
    </div>
  );
}

void FLOOR_Y;
void energyFromActivity;
