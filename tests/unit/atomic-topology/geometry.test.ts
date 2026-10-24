/**
 * Atomic topology — pure scene geometry helpers (OR-ATOM-003, V4/V5/V7).
 *
 * Pins the deterministic placement math behind the dense nucleus clusters
 * (`nucleusParticleField` for the hub, `atomNucleusParticleField` for ring
 * atoms) and the electron-cloud shell configuration (`electronShellConfig`).
 * No `three`, no DOM, no Math.random — every assertion is a pure function of
 * its inputs, so the rendered scene is reproducible across runs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  NUCLEUS_RADIUS,
  NUCLEUS_CLUSTER_RADIUS_FACTOR,
  PARTICLE_COUNT_HIGH,
  PROTON_COLOR,
  NEUTRON_COLOR,
  ATOM_NUCLEUS_COUNT_HIGH,
  ATOM_NUCLEUS_COUNT_LOW,
  ATOM_NUCLEUS_PARTICLE_RADIUS,
  nucleusParticleField,
  atomNucleusParticleField,
  electronShellConfig,
  SHELL_TILTS_X,
  SHELL_TILTS_Z,
  SHELL_SPEED_FACTOR,
  SHELL_RADIUS_FACTOR,
  SHELL_ELLIPTICITY,
} from "@/plugins/atomic-topology/scene/geometry";

type Particle = { position: [number, number, number] };

function assertAllFinite(particles: Particle[]): void {
  for (const p of particles) {
    for (const v of p.position) {
      assert.ok(Number.isFinite(v), `position value must be finite, got ${v}`);
    }
  }
}

function assertWithinRadius(particles: Particle[], radius: number): void {
  for (const p of particles) {
    const [x, y, z] = p.position;
    const d = Math.sqrt(x * x + y * y + z * z);
    assert.ok(d <= radius + 1e-9, `particle at distance ${d} exceeds cluster radius ${radius}`);
  }
}

/**
 * Component-wise epsilon comparison — the Fibonacci placement produces
 * `-0` at the poles (0 * cos(theta) with negative cos), and deepEqual
 * distinguishes -0 from +0, which is not a meaningful visual difference.
 */
function assertPosNear(actual: [number, number, number], x: number, y: number, z: number): void {
  assert.ok(Math.abs(actual[0] - x) < 1e-9, `x ${actual[0]} !~ ${x}`);
  assert.ok(Math.abs(actual[1] - y) < 1e-9, `y ${actual[1]} !~ ${y}`);
  assert.ok(Math.abs(actual[2] - z) < 1e-9, `z ${actual[2]} !~ ${z}`);
}

test("nucleusParticleField: clamps count, places particles on the cluster sphere", () => {
  assert.equal(nucleusParticleField(0, 30).length, 0);
  assert.equal(nucleusParticleField(-3, 30).length, 0);
  assert.equal(nucleusParticleField(48, 30).length, 48);
  assert.equal(nucleusParticleField(5.9, 30).length, 5);

  const field = nucleusParticleField(10, 30);
  assertAllFinite(field);
  assertWithinRadius(field, 30);
  // index 0 starts at the north pole; the last particle is at the south pole
  assertPosNear(field[0].position, 0, 30, 0);
  assertPosNear(field[9].position, 0, -30, 0);
});

test("nucleusParticleField: alternates proton / neutron colors in spiral order", () => {
  const field = nucleusParticleField(6, 30);
  for (let i = 0; i < field.length; i += 1) {
    assert.equal(field[i].color, i % 2 === 0 ? PROTON_COLOR : NEUTRON_COLOR);
  }
});

test("nucleusParticleField: a single particle sits at the north pole (no NaN)", () => {
  const field = nucleusParticleField(1, 30);
  assert.equal(field.length, 1);
  assertPosNear(field[0].position, 0, 30, 0);
  assertAllFinite(field);
});

test("nucleusParticleField: deterministic across calls (pure)", () => {
  const a = nucleusParticleField(
    PARTICLE_COUNT_HIGH,
    NUCLEUS_RADIUS * NUCLEUS_CLUSTER_RADIUS_FACTOR
  );
  const b = nucleusParticleField(
    PARTICLE_COUNT_HIGH,
    NUCLEUS_RADIUS * NUCLEUS_CLUSTER_RADIUS_FACTOR
  );
  assert.deepEqual(a, b);
});

test("atomNucleusParticleField: clamps count, stays inside the cluster radius", () => {
  assert.equal(atomNucleusParticleField(0, 10, ["#123456"]).length, 0);
  assert.equal(atomNucleusParticleField(-1, 10, ["#123456"]).length, 0);
  assert.equal(atomNucleusParticleField(ATOM_NUCLEUS_COUNT_HIGH, 10, []).length, 12);
  assert.equal(atomNucleusParticleField(ATOM_NUCLEUS_COUNT_LOW, 10, []).length, 6);

  const field = atomNucleusParticleField(8, 10, ["#123456"]);
  assertAllFinite(field);
  assertWithinRadius(field, 10);
});

test("atomNucleusParticleField: cycles through observed model colors", () => {
  const colors = ["#aa0000", "#00aa00", "#0000aa"];
  const field = atomNucleusParticleField(7, 10, colors);
  for (let i = 0; i < field.length; i += 1) {
    assert.equal(field[i].color, colors[i % colors.length]);
  }
  // a single observed color paints every particle
  const mono = atomNucleusParticleField(6, 10, ["#ff00ff"]);
  for (const p of mono) {
    assert.equal(p.color, "#ff00ff");
  }
});

test("atomNucleusParticleField: empty colors fall back to neutral proton / neutron", () => {
  const field = atomNucleusParticleField(ATOM_NUCLEUS_COUNT_HIGH, 10, []);
  for (let i = 0; i < field.length; i += 1) {
    assert.equal(field[i].color, i % 2 === 0 ? PROTON_COLOR : NEUTRON_COLOR);
  }
});

test("atomNucleusParticleField: deterministic across calls (pure)", () => {
  const a = atomNucleusParticleField(12, ATOM_NUCLEUS_PARTICLE_RADIUS, ["#123456", "#654321"]);
  const b = atomNucleusParticleField(12, ATOM_NUCLEUS_PARTICLE_RADIUS, ["#123456", "#654321"]);
  assert.deepEqual(a, b);
});

test("electronShellConfig: clamps the shell count to 1–3", () => {
  assert.equal(electronShellConfig(60, 12, 0).length, 1);
  assert.equal(electronShellConfig(60, 12, 1).length, 1);
  assert.equal(electronShellConfig(60, 12, 2.9).length, 2);
  assert.equal(electronShellConfig(60, 12, 3).length, 3);
  assert.equal(electronShellConfig(60, 12, 5).length, 3);
});

test("electronShellConfig: per-shell geometry matches the exported constants", () => {
  const shells = electronShellConfig(60, 12, 3);
  for (let s = 0; s < 3; s += 1) {
    assert.equal(shells[s].tiltX, SHELL_TILTS_X[s]);
    assert.equal(shells[s].tiltZ, SHELL_TILTS_Z[s]);
    assert.equal(shells[s].speedFactor, SHELL_SPEED_FACTOR[s]);
    assert.equal(shells[s].ellipticity, SHELL_ELLIPTICITY[s]);
    assert.equal(shells[s].rx, 60 * SHELL_RADIUS_FACTOR[s]);
    assert.equal(shells[s].rz, shells[s].rx * SHELL_ELLIPTICITY[s]);
  }
  // the innermost shell is the tightest orbit, the outermost the widest
  assert.ok(shells[0].rx < shells[1].rx);
  assert.ok(shells[1].rx < shells[2].rx);
});

test("electronShellConfig: at least two electrons per shell, even for a zero budget", () => {
  const zero = electronShellConfig(60, 0, 3);
  for (const shell of zero) {
    assert.ok(shell.electrons.length >= 2);
  }
  const even = electronShellConfig(60, 9, 3);
  for (const shell of even) {
    assert.equal(shell.electrons.length, 3);
  }
});

test("electronShellConfig: electrons sit on their shell's ellipse (y = 0)", () => {
  const cases: Array<[number, number]> = [
    [4, 1],
    [4, 2],
    [12, 3],
    [0, 1],
  ];
  for (const [electrons, shellCount] of cases) {
    for (const shell of electronShellConfig(55, electrons, shellCount)) {
      for (const [x, y, z] of shell.electrons) {
        assert.equal(y, 0);
        const t = (x / shell.rx) ** 2 + (z / shell.rz) ** 2;
        assert.ok(Math.abs(t - 1) < 1e-9, `electron off-ellipse: t=${t}`);
      }
    }
  }
});

test("electronShellConfig: index 0 starts at angle 0 with the per-shell stagger", () => {
  const shells = electronShellConfig(50, 6, 3);
  const [x0, , z0] = shells[0].electrons[0];
  assert.ok(Math.abs(x0 - shells[0].rx) < 1e-9);
  assert.ok(Math.abs(z0) < 1e-9);
  const [x1, , z1] = shells[1].electrons[0];
  assert.ok(Math.abs(x1 - Math.cos(0.6) * shells[1].rx) < 1e-9);
  assert.ok(Math.abs(z1 - Math.sin(0.6) * shells[1].rz) < 1e-9);
});

test("electronShellConfig: deterministic across calls (pure)", () => {
  assert.deepEqual(electronShellConfig(50, 6, 3), electronShellConfig(50, 6, 3));
});
