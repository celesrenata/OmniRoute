/**
 * Nucleus glass optics (directive 38.4: the "nucleus clip notch"). Pure, three-free.
 *
 * Root cause of the notch: the impostor traces the nucleons ONLY through the glass
 * sphere around the nucleus (radius {@link NUCLEUS_GLASS_FACTOR} x the pack extent),
 * refracting the view ray on entry. A refracting ball magnifies what sits near its
 * rim and behind it: with the old index of refraction (1.32) the refracted image of a
 * side/rear nucleon reached the glass silhouette itself, and everything beyond that
 * silhouette is never traced. That image was cut along the glass edge, which reads as
 * a flat notch in the nucleus once the atom is large on screen (detail view telephoto).
 * {@link maxRefractedImageFraction} measures it, and the index below keeps every
 * nucleon's image strictly inside the glass with a margin.
 */
/** Glass radius around the nucleus, in pack extents (unchanged; the shell size stays as approved). */
export const NUCLEUS_GLASS_FACTOR = 1.14;
/** Index of refraction of the nucleus glass. 1.32 clipped side/rear nucleons at the rim. */
export const NUCLEUS_GLASS_IOR = 1.08;

/**
 * Largest screen-space radius (as a fraction of the glass radius) at which ANY point of
 * a nucleon of radius `rho`, on the outer shell of a pack of extent `ext`, is still seen
 * through a glass ball of radius `glassR` and index `ior` (orthographic view down -z;
 * a 2D slice through the view axis, which is where the magnification peaks). A result
 * of 1 means the image touches the silhouette and is clipped there.
 */
export function maxRefractedImageFraction(
  glassR: number,
  ior: number,
  ext = 1,
  rho = 0.22,
  samples = 2000
): number {
  let worst = 0;
  const eta = 1 / ior;
  for (let deg = 0; deg <= 180; deg += 5) {
    const a = (deg * Math.PI) / 180;
    const rc = ext - rho;
    const cx = rc * Math.sin(a);
    const cz = rc * Math.cos(a);
    for (let i = 0; i < samples; i += 1) {
      const b = (glassR * i) / samples;
      const z = Math.sqrt(glassR * glassR - b * b);
      const nx = b / glassR;
      const nz = z / glassR;
      const cosi = nz; // incident direction (0, -1) against the outward normal
      const k = 1 - eta * eta * (1 - cosi * cosi);
      if (k < 0) continue;
      const f = eta * cosi - Math.sqrt(k);
      const tx = f * nx;
      const tz = -eta + f * nz;
      const ox = b - cx;
      const oz = z - cz;
      const bb = ox * tx + oz * tz;
      const cc = ox * ox + oz * oz - rho * rho;
      const disc = bb * bb - cc;
      if (disc >= 0 && -bb - Math.sqrt(disc) > 0) worst = Math.max(worst, b / glassR);
    }
  }
  return worst;
}
