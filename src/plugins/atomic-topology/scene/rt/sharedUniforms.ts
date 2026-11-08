/**
 * Global (scene-wide) TSL uniforms shared by every batched layer. Module level
 * on purpose: node objects are renderer-agnostic, so a device-loss rebuild
 * simply re-binds the same nodes to the new renderer.
 */
import { uniform } from "three/tsl";

/** World Y of the reflective floor plane (set once per layout from its bounds). */
export const floorY = uniform(-66);
/** Wall-clock seconds for decorative environment animation (frozen under reduced motion). */
export const envTime = uniform(0);
