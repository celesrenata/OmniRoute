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
  type Camera,
  type Object3D,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import {
  Fn,
  If,
  clamp,
  dot,
  float,
  fract,
  length,
  max,
  mix,
  pass,
  pow,
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

  const post = createRtPost(renderer, opts.scene, opts.camera, opts.bloom);
  const pipeline = post.pipeline;

  return {
    renderer,
    backend,
    pipeline,
    setPostEnabled: post.setBloom,
    render() {
      pipeline.render();
    },
    resize(w, h) {
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(w, h, false);
    },
    dispose() {
      post.dispose();
      renderer.dispose();
    },
  };
}

export interface RtPost {
  pipeline: RenderPipeline;
  setBloom: (on: boolean) => void;
  /**
   * Depth of field. `focusDist` = camera to orbit-target distance (world units);
   * `atom` = the focused atom's projected disc (screen UV centre + radius in
   * viewport-height units, `w` = isolation weight 0..1) or null when nothing is focused.
   */
  setFocus: (
    focusDist: number,
    atom: { u: number; v: number; r: number; w?: number } | null
  ) => void;
  dispose: () => void;
}

/** Golden-angle disc taps for the bokeh gather (unit disc, sqrt-spaced). */
const DOF_TAPS = 16;
const DOF_KERNEL: Array<[number, number]> = Array.from({ length: DOF_TAPS }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / DOF_TAPS);
  const a = i * 2.399963;
  return [Math.cos(a) * r, Math.sin(a) * r];
});
/** Largest circle of confusion, in viewport-height units. */
const DOF_MAX_COC = 0.0065;

/**
 * HDR post chain shared by the bench and the topology scene: scene pass ->
 * bloom on HDR emissives -> subtle edge RGB shift -> filmic split-tone grade ->
 * vignette -> grain -> renderer output transform (ACES + sRGB). Built on the
 * LIVE renderer; no extra renderer, no quality tiers.
 */
export function createRtPost(
  renderer: WebGPURenderer,
  scene: Scene | Object3D,
  camera: Camera,
  bloomEnabled: boolean
): RtPost {
  const pipeline = new RenderPipeline(renderer);
  const scenePass = pass(scene as Scene, camera);
  const sceneColor = scenePass.getTextureNode();
  const bloomOn = uniform(bloomEnabled ? 1 : 0);
  const bloomNode = bloom(sceneColor, 0.15, 0.5, 1.3);
  // Chromatic aberration: subtle and EDGE-ONLY (zero in the central ~38 % of the frame so
  // atoms in the middle never fringe; operator directive 31).
  const caAmount = smoothstep(0.38, 0.9, length(screenUV.sub(0.5).mul(vec2(1.0, 0.9)))).mul(0.0014);
  const shifted = rgbShift(sceneColor, caAmount, 0.0);
  const viewZ = scenePass.getViewZNode();
  const focusDist = uniform(1e7); // no DOF until a host calls setFocus (bench look unchanged)
  const focusAtom = uniform(new Vector3(0.5, 0.5, 0));
  const focusOn = uniform(0);
  const aspect = uniform(1);
  // Cinematic depth of field (idea5): the room behind the topology falls into a
  // soft bokeh; in the focus view everything outside the focused atom's disc is
  // defocused so the hero atom is isolated. Atoms do not write depth, so the
  // neighbour isolation is screen-space around the focused atom's projection.
  const dof = Fn(() => {
    const d = viewZ.negate();
    // Background: only the far room (walls/ceiling) beyond the topology, so
    // atoms drawn over the floor (they write no depth) stay sharp.
    const bg = smoothstep(focusDist.mul(2.3), focusDist.mul(3.6), d).mul(0.7);
    const toAtom = screenUV.sub(focusAtom.xy).mul(vec2(aspect, 1));
    const ring = smoothstep(focusAtom.z.mul(1.25), focusAtom.z.mul(2.3), length(toAtom));
    // Focus view: the hero atom's disc is fully sharp, everything around it defocuses.
    const coc = mix(bg, max(bg, ring).mul(ring.mul(0.9).add(0.1)).max(ring), focusOn)
      .mul(mix(float(1), ring, focusOn))
      .mul(DOF_MAX_COC);
    // Most pixels are in focus: skip the 16-tap gather there (one branch).
    const out = vec3(shifted.rgb).toVar();
    If(coc.greaterThan(DOF_MAX_COC * 0.02), () => {
      const acc = vec3(0).toVar();
      const wsum = float(0).toVar();
      for (const [kx, ky] of DOF_KERNEL) {
        const c = sceneColor.sample(
          screenUV.add(
            vec2(kx, ky)
              .mul(coc)
              .mul(vec2(float(1).div(aspect), 1))
          )
        ).rgb;
        // Highlight-weighted gather: bright emitters bloom into bokeh discs.
        const w = dot(c, vec3(0.2126, 0.7152, 0.0722))
          .mul(2)
          .add(1);
        acc.addAssign(c.mul(w));
        wsum.addAssign(w);
      }
      out.assign(mix(shifted.rgb, acc.div(wsum), smoothstep(0, DOF_MAX_COC * 0.35, coc)));
    });
    return out;
  });
  const grade = Fn(() => {
    const hdr = dof().add(bloomNode.rgb.mul(bloomOn));
    // Filmic split-tone: cool teal in shadows, warm magenta/orange in highlights.
    const luma = dot(hdr, vec3(0.2126, 0.7152, 0.0722));
    const shadowTint = vec3(0.9, 1.0, 1.1);
    const highTint = vec3(1.12, 0.95, 1.03);
    const toned = hdr.mul(mix(shadowTint, highTint, smoothstep(0.1, 1.2, luma)));
    // Deep blacks + contrast: crush the lifted floor so the atom is the brightest object.
    const graded = pow(max(toned.sub(0.012), 0), vec3(1.14));
    // Vignette.
    const v = length(screenUV.sub(0.5).mul(vec2(1.0, 0.9)));
    const vig = float(1).sub(smoothstep(0.3, 0.9, v).mul(0.72));
    // Grain (static pattern phase; reduced-motion safe because it is subtle and non-flashing).
    const g = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
    return vec4(graded.mul(vig).add(g.mul(0.012)), 1);
  });
  pipeline.outputNode = grade();

  void clamp;
  return {
    pipeline,
    setBloom(on) {
      (bloomOn as unknown as { value: number }).value = on ? 1 : 0;
    },
    setFocus(dist, atom) {
      (focusDist as unknown as { value: number }).value = Math.max(50, dist);
      (focusOn as unknown as { value: number }).value = atom ? (atom.w ?? 1) : 0;
      if (atom) (focusAtom.value as Vector3).set(atom.u, atom.v, atom.r);
      const el = renderer.domElement;
      const a = el && el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 1;
      (aspect as unknown as { value: number }).value = a;
    },
    dispose() {
      try {
        pipeline.dispose?.();
      } catch {
        /* already disposed */
      }
    },
  };
}

/**
 * Renderer for the R3F `<Canvas gl={...}>` factory (topology scene). Full
 * retina DPR is applied by the Canvas `dpr` prop; MSAA via `antialias`.
 * `onDeviceLost` fires for a real WebGPU device loss, never for our own
 * dispose (the caller sets `disposing` first).
 */
export async function createRtCanvasRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  opts: { forceWebGL?: boolean; onDeviceLost?: (reason: string) => void }
): Promise<{ renderer: WebGPURenderer; backend: Backend; device: GPUDevice | null }> {
  const renderer = new WebGPURenderer({
    canvas: canvas as HTMLCanvasElement,
    antialias: true,
    alpha: true,
    forceWebGL: !!opts.forceWebGL,
    powerPreference: "high-performance",
  });
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // A loss is handled (freeze + rebuild on a fresh canvas, see AtomicScene), so
  // it is reported as a warning instead of three's default console error.
  (
    renderer as unknown as { onDeviceLost: (info: { api?: string; message?: string }) => void }
  ).onDeviceLost = (info) => {
    (renderer as unknown as { _isDeviceLost: boolean })._isDeviceLost = true;
    console.warn(
      `[atomic] ${info.api ?? "GPU"} device lost (${info.message ?? "unknown"}); rebuilding`
    );
  };
  await renderer.init();
  const be = (renderer as unknown as { backend: { isWebGPUBackend?: boolean; device?: GPUDevice } })
    .backend;
  const backend: Backend = be?.isWebGPUBackend ? "webgpu" : "webgl";
  const device = be?.device ?? null;
  if (device && opts.onDeviceLost) {
    void device.lost.then((info) => opts.onDeviceLost?.(info.reason ?? "unknown"));
  }
  return { renderer, backend, device };
}
