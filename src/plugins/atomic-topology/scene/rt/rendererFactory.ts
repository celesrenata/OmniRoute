/**
 * WebGPURenderer factory + HDR post pipeline for the ray-traced atom bench
 * (three/webgpu; its built-in WebGL2 backend is the fallback).
 *
 * Pipeline: scene pass (HalfFloat, MSAA via renderer antialias) -> bloom on
 * HDR emissives -> subtle RGB-shift (edge chromatic aberration) -> filmic
 * grade (teal/cyan shadows, orange/magenta highlights) -> vignette -> grain ->
 * ACES + sRGB output. Full retina DPR, no quality tiers.
 */
import {
  ACESFilmicToneMapping,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
  WebGPURenderer,
} from "three/webgpu";
import {
  Fn,
  clamp,
  dot,
  float,
  fract,
  length,
  mix,
  pass,
  screenUV,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
  screenCoordinate,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { rgbShift } from "three/addons/tsl/display/RGBShiftNode.js";

export type Backend = "webgpu" | "webgl";

export interface RtRenderer {
  renderer: WebGPURenderer;
  backend: Backend;
  pipeline: RenderPipeline;
  setPostEnabled: (bloomOn: boolean) => void;
  render: () => void;
  resize: (w: number, h: number) => void;
  dispose: () => void;
}

export interface RtRendererOptions {
  canvas: HTMLCanvasElement;
  scene: Scene;
  camera: PerspectiveCamera;
  width: number;
  height: number;
  forceWebGL?: boolean;
  bloom: boolean;
  onDeviceLost?: (reason: string) => void;
}

export async function createRtRenderer(opts: RtRendererOptions): Promise<RtRenderer> {
  const renderer = new WebGPURenderer({
    canvas: opts.canvas,
    antialias: true,
    alpha: false,
    forceWebGL: !!opts.forceWebGL,
    powerPreference: "high-performance",
  });
  // Full retina: no DPR cap.
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(opts.width, opts.height, false);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  await renderer.init();
  const backendName = (renderer as unknown as { backend: { isWebGPUBackend?: boolean } }).backend;
  const backend: Backend = backendName?.isWebGPUBackend ? "webgpu" : "webgl";

  const device = (renderer as unknown as { backend: { device?: GPUDevice } }).backend.device;
  if (device && opts.onDeviceLost) {
    void device.lost.then((info) => opts.onDeviceLost?.(info.reason ?? "unknown"));
  }

  const pipeline = new RenderPipeline(renderer);
  const scenePass = pass(opts.scene, opts.camera);
  const sceneColor = scenePass.getTextureNode();
  const bloomOn = uniform(opts.bloom ? 1 : 0);
  const bloomNode = bloom(sceneColor, 0.26, 0.55, 1.15);
  const shifted = rgbShift(sceneColor, 0.0011, 0.0);
  const grade = Fn(() => {
    const hdr = shifted.rgb.add(bloomNode.rgb.mul(bloomOn));
    // Filmic split-tone: cool teal in shadows, warm magenta/orange in highlights.
    const luma = dot(hdr, vec3(0.2126, 0.7152, 0.0722));
    const shadowTint = vec3(0.9, 1.0, 1.1);
    const highTint = vec3(1.12, 0.95, 1.03);
    const graded = hdr.mul(mix(shadowTint, highTint, smoothstep(0.1, 1.2, luma)));
    // Vignette.
    const v = length(screenUV.sub(0.5).mul(vec2(1.0, 0.9)));
    const vig = float(1).sub(smoothstep(0.35, 0.95, v).mul(0.55));
    // Grain (static pattern phase; reduced-motion safe because it is subtle and non-flashing).
    const g = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
    return vec4(graded.mul(vig).add(g.mul(0.012)), 1);
  });
  pipeline.outputNode = grade();
  void clamp;

  return {
    renderer,
    backend,
    pipeline,
    setPostEnabled(on) {
      (bloomOn as unknown as { value: number }).value = on ? 1 : 0;
    },
    render() {
      pipeline.render();
    },
    resize(w, h) {
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(w, h, false);
    },
    dispose() {
      try {
        pipeline.dispose?.();
      } catch {
        /* already disposed */
      }
      renderer.dispose();
    },
  };
}
