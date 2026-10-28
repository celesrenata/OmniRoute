/**
 * Plasma filament shader for the Atomic scene (OR-ATOM-008 S8.1).
 *
 * webgpu-threejs-tsl technique, ported to the installed WebGL2 idiom
 * (three r186 — `three/examples/jsm/tsl` does not exist here): instead of a
 * TSL node material, the filament halo is injected into a standard
 * `MeshBasicMaterial`'s vertex + fragment shaders via `onBeforeCompile` —
 * the same program-cache-friendly pattern as `makeFresnelCoreMaterial` in
 * `sceneResources.ts`.
 *
 * Why a ribbon MESH (not `Line2`) for the halo: `LineMaterial` does NOT
 * support `onBeforeCompile`, so a shader line would require its own custom
 * program. A `MeshBasicMaterial` ribbon (a thin quad strip along the curve,
 * built by `filament.ts::buildRibbonStripData`) reuses a STANDARD program —
 * the injection adds ZERO custom uniforms:
 *   - it reuses the stock `diffuse` uniform (set from `material.color`) for
 *     the per-link lane hue — so every link's tint needs no extra uniform
 *     and ALL links share ONE compiled program;
 *   - it reuses the stock `opacity` uniform so the per-state, per-frame
 *     opacity (driven in `EnergyLink`) scales the plasma without touching
 *     the program.
 *
 * r186 UV channel caveat (verified in `WebGLPrograms.js`): three r186 only
 * defines `USE_UV`/declares `vUv` when a texture actually consumes channel
 * 0 — a map-less `MeshBasicMaterial` has NO `vUv` at all. The injection is
 * therefore SELF-CONTAINED: it declares its own `vPlasmaUv` varying, fed
 * from the `uv` attribute that three declares UNCONDITIONALLY in the vertex
 * prelude (`'attribute vec2 uv;'` — `WebGLProgram.js`, verified). No guard,
 * no dependency on the material's map state.
 *
 * The plasma profile (per-fragment): `vPlasmaUv.x` = arc-length fraction
 * along the link, `vPlasmaUv.y` = 0 at one ribbon edge, 1 at the other
 * (center at 0.5). A narrow gaussian core at the center reads as a 1–2 CSS
 * px hairline filament at normal framing (the ribbon is ~0.6 world units
 * wide — see `EnergyLink.RIBBON_HALF_WIDTH`), plus a wide, low-contrast
 * gaussian halo on either side ("almost hairline, low-contrast" — S8.1).
 * The along-path shimmer is a STATIC spatial sine (no time uniform →
 * deterministic, zero uniforms, and static by construction — exactly what
 * `prefers-reduced-motion` wants; the traveling ACTIVE packets carry all
 * motion evidence).
 *
 * Pure module: string constants + one factory function. No `three` import,
 * no DOM, unit-testable in Node.
 */

/**
 * Fragment plasma term, spliced right AFTER the `meshbasic` fragment's
 * `vec3 outgoingLight = reflectedLight.indirectDiffuse;` line (verified in
 * `three/src/renderers/shaders/ShaderLib/meshbasic.glsl.js` for r186) — the
 * same value the stock shader then tone-maps, color-space-converts and
 * writes. Adds the tinted plasma contribution to `outgoingLight`.
 */
export const PLASMA_FRAG_INJECTION = /* glsl */ `
{
	float plasmaSide = vPlasmaUv.y - 0.5;
	// Hairline core: narrow gaussian ridge centered on the ribbon.
	float plasmaCore = exp( -pow( plasmaSide / 0.055, 2.0 ) );
	// Gentle halo: wide, low-contrast gaussian on both sides.
	float plasmaHalo = 0.28 * exp( -pow( plasmaSide / 0.30, 2.0 ) );
	// Static spatial shimmer along the arc (deterministic — no time uniform,
	// no motion under reduced motion by construction).
	float plasmaShimmer = 0.92 + 0.08 * sin( vPlasmaUv.x * 62.8319 );
	// Tinted by the material's own diffuse color (per-link lane hue).
	outgoingLight += ( plasmaCore * 1.35 + plasmaHalo ) * plasmaShimmer * diffuse * opacity;
}
`;

/**
 * The exact fragment-shader anchor line to splice
 * {@link PLASMA_FRAG_INJECTION} after. Present in `meshbasic.glsl.js` for
 * three r16x–r18x (stable since the `outgoingLight` rename; r186 verified).
 */
export const PLASMA_FRAG_ANCHOR = "vec3 outgoingLight = reflectedLight.indirectDiffuse;";

/** Vertex anchor: the stock `uv_vertex` include (feeds the UV channel). */
export const PLASMA_VERT_ANCHOR = "#include <uv_vertex>";

/**
 * Attach the plasma filament injection to a standard material's shaders.
 *
 * - Vertex: splices `vPlasmaUv = uv;` AFTER `#include <uv_vertex>` (the
 *   `uv` attribute is declared unconditionally in three's prelude).
 * - Fragment: splices the plasma term AFTER {@link PLASMA_FRAG_ANCHOR}.
 * - Both shaders get a `varying vec2 vPlasmaUv;` declaration prepended to
 *   their `main()`.
 * - A missing anchor THROWS (a three.js version drift must surface loudly
 *   instead of shipping an invisible filament).
 * - `customProgramCacheKey` is pinned to a STABLE constant — every plasma
 *   filament compiles into ONE shared program slot (no custom uniforms →
 *   nothing varies between links).
 * - The callback always re-applies its splices: three calls `onBeforeCompile`
 *   with a FRESH stock shader source on every (re)compile (including after
 *   a WebGL context restore), so a material-level "already injected" flag
 *   would silently drop the injection on the second compile. This matches
 *   the repo's own `makeFresnelCoreMaterial` pattern (anchor-replace, no
 *   guard).
 */
export function applyPlasmaInjection(material: {
  onBeforeCompile?: (
    shader: { vertexShader: string; fragmentShader: string },
    renderer: unknown
  ) => void;
  customProgramCacheKey?: () => string;
  needsUpdate?: boolean;
}): void {
  material.onBeforeCompile = (shader) => {
    if (!shader.fragmentShader.includes(PLASMA_FRAG_ANCHOR)) {
      throw new Error(
        `plasmaShader: fragment anchor "${PLASMA_FRAG_ANCHOR}" not found — three.js version drift`
      );
    }
    if (!shader.vertexShader.includes(PLASMA_VERT_ANCHOR)) {
      throw new Error(
        `plasmaShader: vertex anchor "${PLASMA_VERT_ANCHOR}" not found — three.js version drift`
      );
    }
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "varying vec2 vPlasmaUv;\n\nvoid main() {")
      .replace(PLASMA_VERT_ANCHOR, `${PLASMA_VERT_ANCHOR}\n\tvPlasmaUv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "varying vec2 vPlasmaUv;\n\nvoid main() {")
      .replace(PLASMA_FRAG_ANCHOR, `${PLASMA_FRAG_ANCHOR}\n\t${PLASMA_FRAG_INJECTION.trim()}`);
  };
  material.customProgramCacheKey = () => PLASMA_PROGRAM_KEY;
  material.needsUpdate = true;
}

/** Stable program-cache key shared by every plasma filament (one program). */
export const PLASMA_PROGRAM_KEY = "atomic-topology-plasma-filament-v1";
