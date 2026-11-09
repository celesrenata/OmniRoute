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

/** Dev flag parser: `?herores=0.5` -> 0.5; absent / >= 1 / invalid / production -> null (off). */
export function resolveHeroScale(param: string | null, production: boolean): number | null {
  if (production || param == null || param === "") return null;
  const v = Number(param);
  if (!Number.isFinite(v) || v <= 0 || v >= 1) return null;
  return Math.max(0.25, v);
}

export interface HeroPass {
  scale: number;
  /** Strands also go low-res (default); `?herostrands=0` keeps them at full res (cloud only). */
  strands: boolean;
  /** Additive composite quad for the low-res strands (add to the scene once). */
  objects: Mesh[];
  /** Render the hero's low-res layers (call before the main render, every frame a hero is active). */
  render: (gl: WebGPURenderer, scene: Scene, camera: Camera) => void;
  dispose: () => void;
}

export function createHeroPass(scale: number, strands = true): HeroPass {
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
