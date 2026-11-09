/**
 * Reduced-resolution floor reflection (profile phase, directive 41 experiment).
 *
 * The floor reflection is drawn by two kinds of mirror meshes: the per-atom mirrored impostor
 * (`impostorMirror`, premultiplied "over" blending, renderOrder 2) and the batched mirrored strands
 * (`strandMirror`, additive, renderOrder 3). Both are depth-test-free. This module renders each
 * kind into its own offscreen target at `scale` x the drawing-buffer size and composites it back
 * with one full-screen quad at the same renderOrder and the same blend equation:
 *   - "over" layers accumulated over transparent black, then composited with One/OneMinusSrcAlpha,
 *     equal the sequential blends exactly (associativity of premultiplied over);
 *   - additive layers commute, so their sum composites with One/One.
 * Only the resolution of the reflection changes (bilinear upsample).
 *
 * Imports `three` only via three/webgpu + three/tsl.
 */
import { screenUV, texture, vec4, positionGeometry } from "three/tsl";
import {
  AddEquation,
  Color,
  CustomBlending,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  RenderTarget,
  Vector2,
  type Camera,
  type Object3D,
  type Scene,
  type WebGPURenderer,
} from "three/webgpu";

export const MIRROR_OVER_LAYER = 5;
export const MIRROR_ADD_LAYER = 6;

/** Which mirror layer a mesh name belongs to (null = not a mirror mesh). */
export function mirrorLayerOf(name: string): number | null {
  if (name === "impostorMirror") return MIRROR_OVER_LAYER;
  if (name === "strandMirror") return MIRROR_ADD_LAYER;
  return null;
}

/** Offscreen target size for a drawing buffer and a scale (never below 1 px). */
export function mirrorTargetSize(w: number, h: number, scale: number): [number, number] {
  const s = Math.min(1, Math.max(0.1, scale));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

export interface MirrorPass {
  /** Composite quads (add to the scene once). */
  objects: Mesh[];
  /** Move every mirror mesh under `root` onto its offscreen layer. */
  assignLayers: (root: Object3D) => void;
  /** Render both mirror layers offscreen (call before the main render). */
  render: (gl: WebGPURenderer, scene: Scene, camera: Camera) => void;
  dispose: () => void;
}

function target(): RenderTarget {
  const rt = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  rt.texture.minFilter = LinearFilter;
  rt.texture.magFilter = LinearFilter;
  rt.texture.generateMipmaps = false;
  return rt;
}

function compositeMaterial(rt: RenderTarget, additive: boolean): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.vertexNode = vec4(positionGeometry.xy, 0, 1);
  const s = texture(rt.texture, screenUV);
  m.colorNode = additive ? vec4(s.rgb, 1) : s;
  m.transparent = true;
  m.depthTest = false;
  m.depthWrite = false;
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendSrc = OneFactor;
  m.blendDst = additive ? OneFactor : OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = OneFactor;
  m.blendDstAlpha = additive ? OneFactor : OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = AddEquation;
  return m;
}

export function createMirrorPass(scale: number): MirrorPass {
  const rtOver = target();
  const rtAdd = target();
  const quad = new PlaneGeometry(2, 2);
  const over = new Mesh(quad, compositeMaterial(rtOver, false));
  const add = new Mesh(quad, compositeMaterial(rtAdd, true));
  over.renderOrder = 2;
  add.renderOrder = 3;
  for (const q of [over, add]) {
    q.frustumCulled = false;
    q.name = "mirrorComposite";
    (q as { raycast?: unknown }).raycast = () => {};
  }
  const size = new Vector2();
  return {
    objects: [over, add],
    assignLayers(root) {
      root.traverse((o) => {
        const l = mirrorLayerOf(o.name);
        if (l != null && !o.layers.isEnabled(l)) o.layers.set(l);
      });
    },
    render(gl, scene, camera) {
      gl.getDrawingBufferSize(size);
      const [w, h] = mirrorTargetSize(size.x, size.y, scale);
      if (rtOver.width !== w || rtOver.height !== h) {
        rtOver.setSize(w, h);
        rtAdd.setSize(w, h);
      }
      const prevTarget = gl.getRenderTarget();
      const prevMask = camera.layers.mask;
      const prevAlpha = gl.getClearAlpha();
      const prevColor = gl.getClearColor(new Color());
      gl.setClearColor(0x000000, 0);
      const prevAuto = gl.autoClear;
      gl.autoClear = true;
      for (const [rt, layer] of [
        [rtOver, MIRROR_OVER_LAYER],
        [rtAdd, MIRROR_ADD_LAYER],
      ] as const) {
        gl.setRenderTarget(rt);
        camera.layers.set(layer);
        gl.render(scene, camera);
      }
      camera.layers.mask = prevMask;
      gl.setRenderTarget(prevTarget);
      gl.setClearColor(prevColor, prevAlpha);
      gl.autoClear = prevAuto;
    },
    dispose() {
      rtOver.dispose();
      rtAdd.dispose();
      quad.dispose();
      (over.material as MeshBasicNodeMaterial).dispose();
      (add.material as MeshBasicNodeMaterial).dispose();
    },
  };
}
