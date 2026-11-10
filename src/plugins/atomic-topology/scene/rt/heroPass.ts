/**
 * Reduced-resolution hero translucency (directive 44.2, dev flag `?herores=<scale>`).
 *
 * Only the hero atom (the focused atom, or the close-up hero) is split:
 *   - its cloud march runs in a low-res pass (`heroCloud` mesh, HERO_CLOUD_LAYER) that writes the
 *     cloud emission + packed transmittances into an RGBA32F target; the hero's full-res impostor
 *     skips the march and reads it back with a depth-aware (nucleus-hit-aware) bilinear upsample,
 *     so the nucleus, glass shell, cyan limb and flare stay at full DPR;
 *   - its strands draw into a low-res additive target (HERO_STRAND_LAYER) at width-compensated
 *     (energy-conserving) pixel size, composited back additively at the strands' renderOrder (9).
 * Sparkles (the closed cyan rim), wires, board, links, labels and UI are untouched.
 *
 * Imports `three` only via three/webgpu + three/tsl.
 */
import { positionGeometry, screenUV, texture, vec4 } from "three/tsl";
import {
  AdditiveBlending,
  Color,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  PlaneGeometry,
  RenderTarget,
  Vector2,
  type Camera,
  type Scene,
  type WebGPURenderer,
} from "three/webgpu";
import { heroCloudTex, heroLowScale, heroLowSize, heroStrandScale } from "./heroUniforms";
import { mirrorTargetSize } from "./mirrorPass";

export const HERO_CLOUD_LAYER = 7;
export const HERO_STRAND_LAYER = 8;

/** Default hero translucency scale (directive 45: cloud-only at 0.5 is the default). */
export const DEFAULT_HERO_SCALE = 0.5;

/**
 * Hero scale for a `?herores=` value: 0.5 by default and always in production; dev override
 * `?herores=1` = off (full-res march), `?herores=<0.25..0.99>` = another scale.
 */
export function resolveHeroScale(param: string | null, production: boolean): number | null {
  if (production || param == null || param === "") return DEFAULT_HERO_SCALE;
  const v = Number(param);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_HERO_SCALE;
  if (v >= 1) return null;
  return Math.max(0.25, v);
}

/**
 * Strands in the low-res hero pass: OFF by default and always in production (hairline strands
 * stay full res, directive 45); dev flag `?herostrands=1` = cloud + strands.
 */
export function resolveHeroStrands(param: string | null, production: boolean): boolean {
  return !production && param === "1";
}

export interface HeroPass {
  scale: number;
  /** Strands also go low-res (dev flag `?herostrands=1`); default false = cloud only. */
  strands: boolean;
  /** Additive composite quad for the low-res strands (add to the scene once). */
  objects: Mesh[];
  /** Render the hero's low-res layers (call before the main render, every frame a hero is active). */
  render: (gl: WebGPURenderer, scene: Scene, camera: Camera) => void;
  dispose: () => void;
}

export function createHeroPass(scale: number, strands = false): HeroPass {
  const rtCloud = new RenderTarget(1, 1, { type: FloatType, depthBuffer: false });
  rtCloud.texture.minFilter = NearestFilter;
  rtCloud.texture.magFilter = NearestFilter;
  rtCloud.texture.generateMipmaps = false;
  const rtStrand = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  rtStrand.texture.minFilter = LinearFilter;
  rtStrand.texture.magFilter = LinearFilter;
  rtStrand.texture.generateMipmaps = false;

  const quad = new PlaneGeometry(2, 2);
  const mat = new MeshBasicNodeMaterial();
  mat.vertexNode = vec4(positionGeometry.xy, 0, 1);
  mat.colorNode = vec4(texture(rtStrand.texture, screenUV).rgb, 1);
  mat.transparent = true;
  mat.blending = AdditiveBlending;
  mat.depthTest = false;
  mat.depthWrite = false;
  const strandQuad = new Mesh(quad, mat);
  strandQuad.renderOrder = 9;
  strandQuad.frustumCulled = false;
  strandQuad.name = "heroStrandComposite";
  (strandQuad as { raycast?: unknown }).raycast = () => {};
  (heroStrandScale as { value: number }).value = scale;

  const size = new Vector2();
  const clear = new Color();
  return {
    scale,
    strands,
    objects: strands ? [strandQuad] : [],
    render(gl, scene, camera) {
      gl.getDrawingBufferSize(size);
      const [w, h] = mirrorTargetSize(size.x, size.y, scale);
      if (rtCloud.width !== w || rtCloud.height !== h) {
        rtCloud.setSize(w, h);
        rtStrand.setSize(w, h);
      }
      (heroLowSize.value as Vector2).set(w, h);
      (heroLowScale.value as Vector2).set(w / size.x, h / size.y);
      heroCloudTex.value = rtCloud.texture;
      const prevTarget = gl.getRenderTarget();
      const prevMask = camera.layers.mask;
      const prevAlpha = gl.getClearAlpha();
      gl.getClearColor(clear);
      const prevAuto = gl.autoClear;
      gl.setClearColor(0x000000, 0);
      gl.autoClear = true;
      const layers = strands
        ? ([
            [rtCloud, HERO_CLOUD_LAYER],
            [rtStrand, HERO_STRAND_LAYER],
          ] as const)
        : ([[rtCloud, HERO_CLOUD_LAYER]] as const);
      for (const [rt, layer] of layers) {
        gl.setRenderTarget(rt);
        camera.layers.set(layer);
        gl.render(scene, camera);
      }
      camera.layers.mask = prevMask;
      gl.setRenderTarget(prevTarget);
      gl.setClearColor(clear, prevAlpha);
      gl.autoClear = prevAuto;
    },
    dispose() {
      rtCloud.dispose();
      rtStrand.dispose();
      quad.dispose();
      mat.dispose();
    },
  };
}
