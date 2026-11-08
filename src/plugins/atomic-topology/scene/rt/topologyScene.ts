/**
 * Pure, three-free mapping from the adapter's visual descriptors to the
 * ray-traced topology scene (Gate B). Unit-tested; the R3F host
 * (`RtTopologyScene.tsx`) only feeds these results to the GPU layers.
 *
 * Honesty: energy comes ONLY from measured fields (`measuredTps`,
 * `activeRequests`, device `activeJobs` / `queuedJobs`); nothing measured ->
 * idle (lower energy state). Layout positions are read, never changed.
 */
import type { EnergyInput } from "../energyState";

/** Shape of the descriptor fields this module reads (subset of AtomVisualDescriptor). */
export interface SceneAtomInput {
  id: string;
  kind: "hub" | "provider" | "gpu" | "runtime";
  position: { x: number; y: number; z: number };
  laneHue: string;
  observedModelIds?: string[];
  measuredTps: number | null;
  activeRequests: number | null;
  deviceFacts?: { activeJobs?: number | null; queuedJobs?: number | null };
  visualState: { state: "error" | "active" | "last" | "healthy" | "idle" };
}

/** The hub reads as the scene's primary atom: larger than ring atoms. */
export const HUB_SCALE = 1.6;
/** Focus emphasis (same factor as the legacy renderer's FOCUS_SCALE). */
export const FOCUS_SCALE = 1.18;
/** Floor sits this far below the lowest atom centre (the bench's approved seat). */
export const FLOOR_OFFSET = -66;
/** Same bow as the legacy EnergyLink (`ARC_FACTOR`). */
export const LINK_ARC_FACTOR = 0.25;

const finiteOrNull = (v: number | null | undefined): number | null =>
  v != null && Number.isFinite(v) ? v : null;

/** Measured-only energy input for one atom (stale/missing -> idle). */
export function atomEnergyInput(d: SceneAtomInput, reducedMotion: boolean): EnergyInput {
  const active = finiteOrNull(d.activeRequests) ?? finiteOrNull(d.deviceFacts?.activeJobs ?? null);
  return {
    measuredTps: finiteOrNull(d.measuredTps),
    activeRequests: active,
    queued: finiteOrNull(d.deviceFacts?.queuedJobs ?? null),
    stale: false,
    reducedMotion,
  };
}

/** Unknown attribution (no observed model ids) renders neutral blue-silver; the hub never does. */
export function isNeutralAtom(d: SceneAtomInput): boolean {
  return d.kind !== "hub" && !(d.observedModelIds && d.observedModelIds.length > 0);
}

export interface EnvironmentLayoutResult {
  pedestals: { x: number; z: number; y: number; scale: number; hub: boolean }[];
  nearZ: number;
  wallX: number;
  ceilY: number;
  farZ: number;
  scale: number;
  floorY: number;
  moteCenter: [number, number, number];
  moteHalf: [number, number, number];
}

/**
 * Room / platform placement derived read-only from the atom positions: the
 * reflective floor sits {@link FLOOR_OFFSET} below the lowest atom, each atom
 * gets a holographic pedestal under it (the hub a larger one), and the server
 * room corridor is widened to the layout bounds so it never cuts through the
 * topology. Total and deterministic; empty input -> the bench room.
 */
export function environmentLayoutFor(
  atoms: readonly SceneAtomInput[],
  /** Default camera pose the container must enclose (read-only; the camera is never moved). */
  enclose?: { position: readonly [number, number, number] }
): EnvironmentLayoutResult {
  let maxR = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const a of atoms) {
    const { x, y, z } = a.position;
    if (![x, y, z].every(Number.isFinite)) continue;
    maxR = Math.max(maxR, Math.hypot(x, z));
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minY)) {
    minY = 0;
    maxY = 0;
  }
  const floorY = minY + FLOOR_OFFSET;
  const pedestals = atoms
    .filter((a) => [a.position.x, a.position.y, a.position.z].every(Number.isFinite))
    .map((a) => {
      const s = a.kind === "hub" ? HUB_SCALE : 1;
      return {
        x: a.position.x,
        z: a.position.z,
        y: a.position.y + FLOOR_OFFSET,
        scale: s,
        hub: a.kind === "hub",
      };
    });
  const scale = Math.max(1, maxR / 420);
  const cam = enclose?.position ?? [0, 0, 0];
  const camOk = cam.every(Number.isFinite);
  const camZ = camOk ? cam[2] : 0;
  const camY = camOk ? cam[1] : 0;
  const camX = camOk ? Math.abs(cam[0]) : 0;
  return {
    pedestals,
    nearZ: Math.max(900, camZ + maxR * 0.5 + CONTAINER_MARGIN),
    wallX: Math.max(420, maxR + 520, camX + CONTAINER_MARGIN),
    ceilY: Math.max(300, maxY + 260 + maxR * 0.45, camY + CONTAINER_MARGIN),
    farZ: -Math.max(1700, maxR + 1600),
    scale,
    floorY,
    moteCenter: [0, (minY + maxY) / 2 + 60, 0],
    moteHalf: [maxR + 500, Math.max(220, (maxY - minY) / 2 + 220), maxR + 500],
  };
}

/** Clearance between the default camera pose and the container walls (world units). */
export const CONTAINER_MARGIN = 420;
/** Hub -> atom link curve (same endpoints and bow as the legacy EnergyLink). */
export function linkCurve(target: { x: number; y: number; z: number }): {
  a: [number, number, number];
  c: [number, number, number];
  b: [number, number, number];
} {
  const b: [number, number, number] = [target.x, target.y, target.z];
  const mid: [number, number, number] = [b[0] / 2, b[1] / 2, b[2] / 2];
  const ml = Math.hypot(mid[0], mid[1], mid[2]);
  const radial: [number, number, number] =
    ml > 1e-6 ? [mid[0] / ml, mid[1] / ml, mid[2] / ml] : [0, 0, 1];
  const len = Math.hypot(b[0], b[1], b[2]);
  const k = len * LINK_ARC_FACTOR;
  return {
    a: [0, 0, 0],
    c: [mid[0] + radial[0] * k, mid[1] + radial[1] * k, mid[2] + radial[2] * k],
    b,
  };
}

/** Steady filament intensity per state (idle = dim steady strand, no packets). */
export function linkBaseIntensity(
  state: "error" | "active" | "last" | "healthy" | "idle",
  styleOpacity: number
): number {
  const o = Number.isFinite(styleOpacity) ? Math.min(1, Math.max(0, styleOpacity)) : 0.3;
  if (state === "error") return 0.5;
  if (state === "active") return 0.9 + 0.9 * o;
  return 0.14 + 0.22 * o;
}
