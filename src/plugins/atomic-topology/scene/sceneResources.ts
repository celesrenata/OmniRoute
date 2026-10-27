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
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    emissive: new THREE.Color(emissive),
    emissiveIntensity,
    roughness: 0.35,
    metalness: 0.2,
  });
  material.onBeforeCompile = (shader) => {
    // Declare the rim strength constant in the fragment prelude.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_pars_fragment>",
      `#include <dithering_pars_fragment>
const float uRimStrength = ${RIM_STRENGTH.toFixed(3)};`
    );
    // Inject the fresnel rim into the outgoing light (additive light source).
    // The anchor line is the single `outgoingLight` assignment in
    // meshphysical.glsl.js (three r186); the rim uses the non-perturbed
    // geometry normal (clean rim, no normal-map bumps) and the material's own
    // emissive as the rim color (truthful per-model/state tint, no uniforms).
    shader.fragmentShader = shader.fragmentShader.replace(
      "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;",
      `vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
// fresnel rim glow (OR-ATOM-007): rim = pow(1 - saturate(dot(N, V)), 3) * rimColor
{
  vec3 fresnelViewDir = normalize( - vViewPosition );
  float fresnelNd = saturate( dot( nonPerturbedNormal, fresnelViewDir ) );
  float fresnelRim = pow( 1.0 - fresnelNd, 3.0 );
  outgoingLight += fresnelRim * totalEmissiveRadiance * uRimStrength;
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
