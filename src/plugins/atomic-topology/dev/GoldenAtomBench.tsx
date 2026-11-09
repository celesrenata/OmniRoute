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
import { createAtomBatchSet, type BatchAtomFrame } from "../scene/rt/atomBatch";
import { batchCapacityFor } from "../scene/rt/atomData";
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
  /** Multi-atom load test: N atoms (1..32) on a grid, for frame-time headroom. */
  count: number;
}

const MODEL_SETS: Record<string, string[] | undefined> = {
  "1": ["llama-3.3-70b"],
  // Demo ids chosen so production modelColor() hashes to green / blue / violet.
  "3": ["qwen3.5-35b", "llama-3.3-70b", "kimi-k2"],
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // A fresh canvas per mount: the WebGL2 backend's dispose() calls
    // loseContext(), so a remount (StrictMode / param change) must never reuse
    // the previous canvas or it inherits a permanently lost context.
    const canvas = document.createElement("canvas");
    canvas.style.width = `${params.width}px`;
    canvas.style.height = `${params.height}px`;
    canvas.style.display = "block";
    host.prepend(canvas);
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
    const pair = params.energy === "both";
    const env = createEnvironment(
      pair
        ? [
            [-78, 0],
            [78, 0],
          ]
        : [[0, 0]]
    );
    env.objects.forEach((o) => scene.add(o));
    registry.add(env);

    const multi = params.count > 1;
    const single: "idle" | "excited" = params.energy === "idle" ? "idle" : "excited";
    const kinds: ("idle" | "excited")[] = multi
      ? Array.from({ length: params.count }, () => single)
      : pair
        ? ["idle", "excited"]
        : [params.energy as "idle" | "excited"];
    const cols = Math.ceil(Math.sqrt(kinds.length));
    const rows = Math.ceil(kinds.length / cols);
    const spacing = 150;
    const webgl =
      params.backend === "webgl" || typeof (navigator as { gpu?: unknown }).gpu === "undefined";
    const batch = createAtomBatchSet(batchCapacityFor(webgl ? 16384 : 65536), registry);
    scene.add(batch.group);
    const atoms: { energy: EnergyState; kind: "idle" | "excited"; phase: number; spin: number }[] =
      [];
    const positions: [number, number, number][] = [];
    const configs = kinds.map((kind, i) => {
      const ids = MODEL_SETS[params.models];
      const gx = (i % cols) - (cols - 1) / 2;
      const gz = Math.floor(i / cols) - (rows - 1) / 2;
      const x = multi ? gx * spacing : pair ? (i === 0 ? -78 : 78) : 0;
      const z = multi ? gz * spacing : 0;
      positions.push([x, 0, z]);
      atoms.push({ energy: energyFor(kind, stale, reduced), kind, phase: 0, spin: 0 });
      return {
        id: multi ? `${params.golden}:bench-${i}` : `${params.golden}:bench-${params.golden}`,
        hub: params.golden === "hub",
        observedModelIds: params.golden === "hub" ? undefined : ids,
        laneHue: laneHue("prefill"),
        neutral: params.golden === "hub" ? false : !ids || stale,
      };
    });
    batch.configure(configs);
    const atomFrames: BatchAtomFrame[] = atoms.map((a, i) => ({
      position: positions[i],
      energy: a.energy,
      phase: 0,
      spinAngle: 0,
      marchSteps: 48,
    }));

    const dist = multi
      ? 255 * Math.max(cols, rows) * 0.9
      : params.dist === "close"
        ? 118
        : pair
          ? 400
          : 255;
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
    // Dev-only profiling: ?hide=strands,wires,... hides named batched layers.
    const hidden = new Set(
      (new URLSearchParams(location.search).get("hide") ?? "").split(",").filter(Boolean)
    );
    // Dev-only profiling: ?hideEnv=1 hides the circuit-board environment.
    if (new URLSearchParams(location.search).get("hideEnv") === "1")
      env.objects.forEach((o) => (o.visible = false));
    let last = performance.now();
    let frames = 0;

    const frame = (nowMs: number) => {
      if (disposed || !rtRenderer) return;
      const dt = Math.min(Math.max((nowMs - last) / 1000, 0), 0.1);
      last = nowMs;
      camera.updateMatrixWorld(true);
      atoms.forEach((a, i) => {
        if (params.t != null) {
          a.phase = params.t * a.energy.speedMul;
          a.spin = a.energy.measured ? params.t * tpsToRadiansPerSecond(140) : 0;
        } else if (!params.paused) {
          a.phase = advanceAnimationPhase(a.phase, dt, a.energy.speedMul, reduced);
          a.spin += a.energy.measured && !reduced ? tpsToRadiansPerSecond(140) * dt : 0;
        }
        const fr = atomFrames[i];
        fr.phase = a.phase;
        fr.spinAngle = a.spin;
        fr.marchSteps = steps;
      });
      batch.update(atomFrames, {
        dt: params.paused || params.t != null ? 0 : dt,
        camera,
        reducedMotion: reduced,
        pixelHeight: params.height * (window.devicePixelRatio || 1),
      });
      if (hidden.size) batch.group.traverse((o) => hidden.has(o.name) && (o.visible = false));
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
        // Dev-only handle for the GPU timestamp / layer breakdown (`pw-atomic-layers.mjs`).
        (window as unknown as { __atomicGpuDbg?: unknown }).__atomicGpuDbg = {
          gl: r.renderer,
          post: { pipeline: r.pipeline, setBloom: r.setPostEnabled },
          atoms: batch,
          env,
          motes: { far: { visible: true }, near: { visible: true } },
        };
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
      canvas.remove();
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
