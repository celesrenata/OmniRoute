/**
 * Atomic topology — pure 3D-scene render gate.
 *
 * Extracted from `AtomicTopologyRenderer` so the three-condition gate can be
 * unit-tested as a side-effect-free function (all eight truth combinations)
 * without importing the renderer's React/DOM tree.
 *
 * Behavior-neutral refactor: the renderer's JSX gate used to inline
 * `sceneModule && descriptors.length > 1 && <webgl2 probe>`; it now calls
 * {@link shouldRenderScene} with the same three operands, so the rendered
 * outcome (scene vs empty-state fallback) is unchanged.
 */

/**
 * Decide whether the Atomic 3D scene (vs the empty-state fallback) renders.
 *
 * @param sceneModuleLoaded the client-only 3D scene module resolved.
 * @param descriptorCount   number of atom descriptors in the snapshot.
 * @param webgl2Ok          the cached, once-per-page-load WebGL2 probe result.
 * @returns `true` only when every condition holds (module loaded, at least
 *   two atoms to connect, and a usable WebGL2 context).
 */
export function shouldRenderScene(
  sceneModuleLoaded: boolean,
  descriptorCount: number,
  webgl2Ok: boolean
): boolean {
  return sceneModuleLoaded && descriptorCount > 1 && webgl2Ok;
}
