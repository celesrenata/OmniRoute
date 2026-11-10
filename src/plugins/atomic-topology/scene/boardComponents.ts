/**
 * Seeded placement of the circuit-board container's REAL 3D components
 * (OR-ATOM-010 directive 23). Pure and three-free so it is unit-testable.
 *
 * The floor (which sits under the topology) is densest; the walls and ceiling
 * are sparser. Everything is a deterministic function of the container extents
 * and the atom footprints to avoid, never of array order or `Math.random`.
 * Decorative only: nothing here encodes telemetry.
 */

export type PartKind =
  | "ic"
  | "can"
  | "mlcc"
  | "smd"
  | "axial"
  | "toroid"
  | "boxChoke"
  | "connector"
  | "heatsink"
  | "led";

export const PART_KINDS: readonly PartKind[] = [
  "ic",
  "can",
  "mlcc",
  "smd",
  "axial",
  "toroid",
  "boxChoke",
  "connector",
  "heatsink",
  "led",
];

/** Which surface a part sits on; `normal` points into the room. */
export type Surface = "floor" | "ceiling" | "wallL" | "wallR" | "wallFar";

export interface PartPlacement {
  kind: PartKind;
  surface: Surface;
  /** World position of the part's base centre on its surface. */
  x: number;
  y: number;
  z: number;
  /** Spin about the surface normal (radians). */
  spin: number;
  /** Per-instance variant 0..1 (colour / marking / blink rate). */
  variant: number;
}

export interface BoardExtent {
  wallX: number;
  ceilY: number;
  nearZ: number;
  farZ: number;
  floorY: number;
}

export interface Avoid {
  x: number;
  z: number;
  /** Keep-clear radius on the floor (pedestal / pad footprint). */
  r: number;
}

/** Per-kind footprint half-size (world units) used for spacing and keep-clear. */
export const PART_FOOTPRINT: Record<PartKind, number> = {
  ic: 24,
  can: 11,
  mlcc: 4,
  smd: 4,
  axial: 13,
  toroid: 17,
  boxChoke: 11,
  connector: 40,
  heatsink: 22,
  led: 3,
};

/** Parts that carry magnetic / high-voltage fields (haze + cool glow around them). */
export const HV_KINDS: ReadonlySet<PartKind> = new Set<PartKind>(["toroid", "boxChoke", "can"]);

/** Hard cap on instances per kind (keeps buffers and the build bounded). */
export const MAX_PER_KIND = 900;

export function fnv(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kind weights per surface (floor is richest in tall / large parts). */
const WEIGHTS: Record<"floor" | "wall", [PartKind, number][]> = {
  floor: [
    ["smd", 0.27],
    ["mlcc", 0.2],
    ["ic", 0.12],
    ["can", 0.09],
    ["led", 0.08],
    ["boxChoke", 0.06],
    ["toroid", 0.05],
    ["axial", 0.06],
    ["connector", 0.04],
    ["heatsink", 0.03],
  ],
  wall: [
    ["smd", 0.3],
    ["mlcc", 0.25],
    ["ic", 0.15],
    ["led", 0.1],
    ["can", 0.07],
    ["boxChoke", 0.05],
    ["connector", 0.05],
    ["heatsink", 0.03],
  ],
};

function pickKind(r: number, table: [PartKind, number][]): PartKind {
  let acc = 0;
  for (const [k, w] of table) {
    acc += w;
    if (r < acc) return k;
  }
  return table[0][0];
}

/** Grid cell size on the floor (world units). */
const FLOOR_CELL = 38;
/** Grid cell size on walls / ceiling. */
const WALL_CELL = 74;

export interface PlacementOptions {
  seed?: number;
  /** Fraction of floor cells that receive a part (default 0.55). */
  floorDensity?: number;
  /** Fraction of wall / ceiling cells that receive a part (default 0.22). */
  wallDensity?: number;
}

/**
 * Place parts on the container surfaces. Floor cells inside an `avoid` disc stay
 * empty; larger parts claim neighbouring cells so footprints never overlap.
 */
export function placeBoardParts(
  ext: BoardExtent,
  avoid: readonly Avoid[],
  opts: PlacementOptions = {}
): PartPlacement[] {
  const seed = opts.seed ?? 0x5ca1e;
  const floorDensity = Math.min(1, Math.max(0, opts.floorDensity ?? 0.55));
  const wallDensity = Math.min(1, Math.max(0, opts.wallDensity ?? 0.22));
  const out: PartPlacement[] = [];
  const counts = new Map<PartKind, number>();
  const room = (k: PartKind): boolean => (counts.get(k) ?? 0) < MAX_PER_KIND;
  const push = (p: PartPlacement): void => {
    out.push(p);
    counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  };

  // --- floor ---------------------------------------------------------------
  const nx = Math.max(1, Math.floor((ext.wallX * 2) / FLOOR_CELL));
  const nz = Math.max(1, Math.floor((ext.nearZ - ext.farZ) / FLOOR_CELL));
  const taken = new Uint8Array(nx * nz);
  for (let iz = 0; iz < nz; iz += 1) {
    for (let ix = 0; ix < nx; ix += 1) {
      const idx = iz * nx + ix;
      if (taken[idx]) continue;
      const cx = -ext.wallX + (ix + 0.5) * FLOOR_CELL;
      const cz = ext.farZ + (iz + 0.5) * FLOOR_CELL;
      const r = rng(fnv(`f:${ix}:${iz}:${seed}`));
      if (r() > floorDensity) continue;
      const kind = pickKind(r(), WEIGHTS.floor);
      if (!room(kind)) continue;
      const fp = PART_FOOTPRINT[kind];
      // Jitter stays inside the part's own cell footprint so neighbours never touch.
      const half = Math.max(0, (FLOOR_CELL - 2 * Math.min(fp, FLOOR_CELL / 2)) / 2);
      const jx = (r() - 0.5) * 2 * half;
      const jz = (r() - 0.5) * 2 * half;
      const x = cx + jx;
      const z = cz + jz;
      // Keep-clear around atoms (pads / pedestals).
      if (avoid.some((a) => Math.hypot(x - a.x, z - a.z) < a.r + fp)) continue;
      if (Math.abs(x) > ext.wallX - fp - 8 || z < ext.farZ + fp + 8 || z > ext.nearZ - fp - 8)
        continue;
      // Large parts claim neighbouring cells.
      const span = Math.max(0, Math.ceil((fp * 2) / FLOOR_CELL) - 1);
      let free = true;
      for (let dz = 0; dz <= span && free; dz += 1) {
        for (let dx = 0; dx <= span; dx += 1) {
          if (ix + dx >= nx || iz + dz >= nz || taken[(iz + dz) * nx + ix + dx]) {
            free = false;
            break;
          }
        }
      }
      if (!free) continue;
      for (let dz = 0; dz <= span; dz += 1)
        for (let dx = 0; dx <= span; dx += 1) taken[(iz + dz) * nx + ix + dx] = 1;
      // Axis-aligned spin (parts are laid out like a real board) with rare 45 degrees.
      const q = Math.floor(r() * 4);
      const spin = q * (Math.PI / 2) + (r() < 0.06 ? Math.PI / 4 : 0);
      push({ kind, surface: "floor", x, y: ext.floorY, z, spin, variant: r() });
    }
  }

  // --- walls + ceiling (sparser) ----------------------------------------------
  const wallH = ext.ceilY - ext.floorY;
  const surfaces: { s: Surface; cols: number; rows: number }[] = [
    {
      s: "wallL",
      cols: Math.floor((ext.nearZ - ext.farZ) / WALL_CELL),
      rows: Math.floor(wallH / WALL_CELL),
    },
    {
      s: "wallR",
      cols: Math.floor((ext.nearZ - ext.farZ) / WALL_CELL),
      rows: Math.floor(wallH / WALL_CELL),
    },
    {
      s: "wallFar",
      cols: Math.floor((ext.wallX * 2) / WALL_CELL),
      rows: Math.floor(wallH / WALL_CELL),
    },
    {
      s: "ceiling",
      cols: Math.floor((ext.wallX * 2) / WALL_CELL),
      rows: Math.floor((ext.nearZ - ext.farZ) / WALL_CELL),
    },
  ];
  for (const { s, cols, rows } of surfaces) {
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const r = rng(fnv(`${s}:${col}:${row}:${seed}`));
        if (r() > wallDensity) continue;
        const kind = pickKind(r(), WEIGHTS.wall);
        if (!room(kind)) continue;
        const a = (col + 0.2 + r() * 0.6) * WALL_CELL;
        const b = (row + 0.2 + r() * 0.6) * WALL_CELL;
        const spin = Math.floor(r() * 4) * (Math.PI / 2);
        let x = 0;
        let y = 0;
        let z = 0;
        if (s === "wallL") {
          x = -ext.wallX;
          z = ext.farZ + a;
          y = ext.floorY + b;
        } else if (s === "wallR") {
          x = ext.wallX;
          z = ext.farZ + a;
          y = ext.floorY + b;
        } else if (s === "wallFar") {
          x = -ext.wallX + a;
          z = ext.farZ;
          y = ext.floorY + b;
        } else {
          x = -ext.wallX + a;
          z = ext.farZ + b;
          y = ext.ceilY;
        }
        push({ kind, surface: s, x, y, z, spin, variant: r() });
      }
    }
  }
  return out;
}

/** Group placements by kind (stable order). */
export function groupByKind(parts: readonly PartPlacement[]): Record<PartKind, PartPlacement[]> {
  const g = {} as Record<PartKind, PartPlacement[]>;
  for (const k of PART_KINDS) g[k] = [];
  for (const p of parts) g[p.kind].push(p);
  return g;
}

/**
 * Low-resolution "haze field" over the floor: 0..1 strength around the
 * magnetic / high-voltage parts, used to refract the background behind them and
 * add the faintest cool glow. Row-major, `res` x `res`, covering
 * [-wallX, wallX] x [farZ, nearZ].
 */
export function buildHazeField(
  parts: readonly PartPlacement[],
  ext: BoardExtent,
  res = 128
): Float32Array {
  const field = new Float32Array(res * res);
  const sx = (ext.wallX * 2) / res;
  const sz = (ext.nearZ - ext.farZ) / res;
  const reach = 46;
  for (const p of parts) {
    if (p.surface !== "floor" || !HV_KINDS.has(p.kind)) continue;
    const i0 = Math.max(0, Math.floor((p.x - reach + ext.wallX) / sx));
    const i1 = Math.min(res - 1, Math.ceil((p.x + reach + ext.wallX) / sx));
    const j0 = Math.max(0, Math.floor((p.z - reach - ext.farZ) / sz));
    const j1 = Math.min(res - 1, Math.ceil((p.z + reach - ext.farZ) / sz));
    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        const wx = -ext.wallX + (i + 0.5) * sx;
        const wz = ext.farZ + (j + 0.5) * sz;
        const d = Math.hypot(wx - p.x, wz - p.z) / reach;
        if (d >= 1) continue;
        const v = (1 - d) * (1 - d) * (3 - 2 * (1 - d));
        const idx = j * res + i;
        if (v > field[idx]) field[idx] = v;
      }
    }
  }
  return field;
}
