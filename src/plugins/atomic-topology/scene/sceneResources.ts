"use client";

/**
 * Shared GPU resources for the Atomic scene (OR-ATOM-007).
 *
 * Performance contract (web-quality-performance.md): ONE shared radial-gradient
 * glow texture (generated at most once per client module load, reused by every
 * atom's electrons + pulses + flashes), and a single sphere geometry reused by
 * every core/electron mesh via `mesh.scale`. This file is the *only* place in
 * the scene subtree that creates DOM-backed textures, so the scene unmount
 * disposes everything through {@link disposeSceneResources}.
 *
 * The fresnel rim glow (webgpu-threejs-tsl `custom-material.js` fresnel rim
 * pattern, ported into the installed WebGL2 idiom): instead of a TSL node
 * material, we inject the rim term into the standard material's fragment
 * shader via `onBeforeCompile`. The rim color reuses the material's own
 * `totalEmissiveRadiance` (which already equals the per-atom model/state color)
 * multiplied by a fixed strength constant — NO custom uniforms, so every
 * injected core shares ONE compiled program (program-cache friendly) while
 * still tinting each atom with its truthful per-model color.
 */
import * as THREE from "three";

/** The shared radial-gradient glow sprite texture (created lazily on the client). */
let glowTexture: THREE.CanvasTexture | null = null;
let glowTextureCreated = false;

/**
 * The shared studio environment map (OR-ATOM-010 cinematic pass, Gate A).
 *
 * The previous material had NO environment map and only flat ambient light, so
 * the per-model diffuse tint had nothing to reflect and the nucleons read as
 * flat grey balls with a faint white rim (the rubric "nucleus 2/5" baseline).
 * A single low-intensity studio env map — a bright cool sky key, a soft warm
 * key strip, a dark navy floor — gives every nucleon a glossy highlight and a
 * colored sheen so the model color is legible at a glance.
 *
 * It is an *equirectangular* `CanvasTexture`, created once per client module
 * load. Three r186 auto-converts a per-material equirect `envMap` to a CubeUV
 * PMREM on the *scene's own* renderer (see `WebGLPrograms` →
 * `environments.get(envMap, usePMREM=true)` → `getPMREM`), so we must NOT run
 * our own one-shot `PMREMGenerator`/`WebGLRenderer` here — that would bake the
 * CubeUV buffers into a dead GL context and the scene would sample an empty
 * texture. Disposing the source texture cascades to the cached PMREM through
 * three's built-in `dispose` event plumbing (see
 * {@link disposeSharedEnvironmentTexture}).
 */
let envMapTexture: THREE.Texture | null = null;
let envMapCreated = false;

/** The equirectangular studio gradient painted into the env map. */
const ENV_GRADIENT_SIZE = 256;

function createStudioEnvGradient(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = ENV_GRADIENT_SIZE;
  canvas.height = ENV_GRADIENT_SIZE / 2;
  const ctx = canvas.getContext("2d")!;
  // Vertical gradient: warm key strip → bright cool sky → dark navy floor.
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, "#243a5e");
  g.addColorStop(0.35, "#0b1424");
  g.addColorStop(0.55, "#3a6ea8");
  g.addColorStop(0.72, "#7ea6d8");
  g.addColorStop(0.88, "#101a2e");
  g.addColorStop(1, "#05070f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // A small bright "window" high-left gives the glossy nucleons a moving
  // highlight as the cluster spins (cinematic depth, not flat ambient).
  const win = ctx.createRadialGradient(
    canvas.width * 0.28,
    canvas.height * 0.3,
    0,
    canvas.width * 0.28,
    canvas.height * 0.3,
    canvas.width * 0.18
  );
  win.addColorStop(0, "rgba(220,235,255,0.95)");
  win.addColorStop(1, "rgba(220,235,255,0)");
  ctx.fillStyle = win;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // A warm secondary strip lower-right for specular balance.
  const warm = ctx.createRadialGradient(
    canvas.width * 0.78,
    canvas.height * 0.62,
    0,
    canvas.width * 0.78,
    canvas.height * 0.62,
    canvas.width * 0.14
  );
  warm.addColorStop(0, "rgba(255,214,170,0.5)");
  warm.addColorStop(1, "rgba(255,214,170,0)");
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Create (once) the shared studio environment map, or null on SSR.
 *
 * Returns an *equirectangular* `CanvasTexture`; the scene's own renderer
 * converts it to a CubeUV PMREM on first use (three r186 does this
 * automatically for per-material `envMap`s — `WebGLPrograms` →
 * `getPMREM`), caching the result per renderer. No `WebGLRenderer`/
 * `PMREMGenerator` is created here: a one-shot renderer would bake the
 * CubeUV buffers into a GL context that dies with that renderer, leaving
 * the scene sampling an empty texture.
 */
export function getSharedEnvironmentTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  if (envMapTexture && envMapCreated) return envMapTexture;
  const canvas = createStudioEnvGradient();
  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  envMapTexture = texture;
  envMapCreated = true;
  return texture;
}

/**
 * Create the shared soft radial-gradient texture: a white core fading to
 * transparent. Tinted per-usage by the sprite material's `color` (additive
 * blending multiplies the texture by the tint, so one white texture serves
 * every lane hue / state color).
 *
 * Client-only guard: `document` must exist; otherwise returns `null` and the
 * scene degrades to no glow sprites (SSR / headless safety).
 */
export function getSharedGlowTexture(): THREE.CanvasTexture | null {
  if (glowTextureCreated) return glowTexture;
  glowTextureCreated = true;
  if (typeof document === "undefined") return null;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  // A soft, gaussian-ish falloff: bright core, long transparent tail.
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.6)");
  gradient.addColorStop(0.5, "rgba(255,255,255,0.22)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  glowTexture = texture;
  return texture;
}

/** The strength of the injected fresnel rim (visual-design-foundations: the rim
 *  reads as the edge of a light source on the dark background, not a hard halo). */
export const RIM_STRENGTH = 1.1;

/** Strength of the virtual studio key light driving the injected Blinn-Phong
 *  specular lobe (OR-ATOM-010 cinematic pass). Modest: the env map does most
 *  of the work — this only sharpens the highlight. */
export const STUDIO_KEY_INTENSITY = 0.55;

/** Overall gain of the injected specular lobe. Kept well under the rim so the
 *  highlight reads as light on a glossy surface, not a second halo. */
export const SPECULAR_LOBE_STRENGTH = 0.35;

/**
 * Build a standard material with the fresnel rim glow injected
 * (`onBeforeCompile` into the WebGL2 fragment shader).
 *
 * The injected term — exactly the skill pattern:
 *   rim = pow(1.0 - saturate(dot(normalWorld, viewDir)), 3.0)
 * is added to the material's existing `totalEmissiveRadiance` scaled by
 * {@link RIM_STRENGTH}, before the opaque/tonemapping includes. Because the
 * rim color is the material's own emissive (the truthful per-model/state
 * color), no per-material uniforms are needed and all cores compile to the
 * same program — only `onBeforeCompile.toString()` enters the cache key, so
 * identical injections share one program across atoms.
 */
export function makeFresnelCoreMaterial(
  color: string,
  emissive: string,
  emissiveIntensity: number
): THREE.MeshStandardMaterial {
  // The shared studio env map gives the nucleon a glossy highlight + colored
  // sheen; without it the per-model diffuse tint has nothing to reflect and
  // the core reads as a flat grey ball (OR-ATOM-010 Gate A baseline). Null on
  // SSR — the fresnel rim below still tints.
  const envMap = getSharedEnvironmentTexture();
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    emissive: new THREE.Color(emissive),
    emissiveIntensity,
    roughness: 0.22,
    metalness: 0.18,
    envMap,
    envMapIntensity: envMap ? 0.9 : 0,
  });
  material.onBeforeCompile = (shader) => {
    // Declare the rim + studio-specular constants in the fragment prelude.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_pars_fragment>",
      `#include <dithering_pars_fragment>
const float uRimStrength = ${RIM_STRENGTH.toFixed(3)};
const vec3 uStudioLightDir = normalize( vec3( 0.35, 0.85, 0.55 ) );
const float uStudioLightColor = ${STUDIO_KEY_INTENSITY.toFixed(3)};
const float uSpecularStrength = ${SPECULAR_LOBE_STRENGTH.toFixed(3)};`
    );
    // Inject the fresnel rim + Blinn-Phong studio specular into the outgoing
    // light (additive light sources). The anchor line is the single
    // `outgoingLight` assignment in meshphysical.glsl.js (three r186). Both
    // terms use the non-perturbed geometry normal (clean rim/highlight, no
    // normal-map bumps) and `diffuseColor.rgb` — the per-particle tint — so
    // the rim and the specular highlight carry the truthful per-model/state
    // color. `diffuseColor` (declared after `#include <color_fragment>`)
    // folds in `vColor`, i.e. the per-particle `instanceColor` set via
    // `setColorAt` (three r186 `color_vertex` multiplies `instanceColor` into
    // `vColor`; the `USE_COLOR` define is emitted from `instancingColor`), so
    // instanced nucleons get their own tint — the bare `diffuse` uniform is
    // the material base color (white-ish for the nucleon roles) and would
    // render the rim as a grey wash (OR-ATOM-010: the previous white-emissive
    // rim read as grey balls; the per-particle tint is what makes each
    // model's color legible).
    shader.fragmentShader = shader.fragmentShader.replace(
      "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;",
      `vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
// fresnel rim glow + Blinn-Phong studio specular (OR-ATOM-007 / OR-ATOM-010)
{
  vec3 fresnelViewDir = normalize( - vViewPosition );
  float fresnelNd = saturate( dot( nonPerturbedNormal, fresnelViewDir ) );
  float fresnelRim = pow( 1.0 - fresnelNd, 3.0 );
  outgoingLight += fresnelRim * ( totalEmissiveRadiance + diffuseColor.rgb * uRimStrength * 0.85 );
  vec3 halfDir = normalize( uStudioLightDir + fresnelViewDir );
  float specNd = saturate( dot( nonPerturbedNormal, halfDir ) );
  float specMask = saturate( dot( nonPerturbedNormal, uStudioLightDir ) );
  float specExponent = mix( 64.0, 6.0, roughness );
  outgoingLight += pow( specNd, specExponent ) * specMask * uStudioLightColor * uSpecularStrength * ( diffuseColor.rgb + vec3( 0.25 ) );
}`
    );
  };
  // A stable program-cache key for the injection (three caches on this string
  // when `onBeforeCompile` is used — see Material#customProgramCacheKey).
  material.customProgramCacheKey = () => "atomic-fresnel-core-v1";
  return material;
}

/**
 * Dispose the shared glow texture exactly once (scene unmount / context
 * rebuild). Idempotent — safe to call multiple times.
 */
export function disposeSharedGlowTexture(): void {
  if (glowTexture) {
    glowTexture.dispose();
    glowTexture = null;
  }
  glowTextureCreated = false;
}

/**
 * Dispose the shared studio env map (scene unmount / context rebuild).
 *
 * Disposing the source equirect `CanvasTexture` fires its `dispose` event,
 * which three's PMREM cache (`WebGLTextures`) listens for to free the derived
 * CubeUV render targets on each renderer. Idempotent — safe to call multiple
 * times.
 */
export function disposeSharedEnvironmentTexture(): void {
  if (envMapTexture) {
    envMapTexture.dispose();
    envMapTexture = null;
  }
  envMapCreated = false;
}
