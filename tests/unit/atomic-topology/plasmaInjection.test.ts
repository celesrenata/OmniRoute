/**
 * Unit tests for the plasma filament shader injection (OR-ATOM-010 T10.4).
 *
 * `applyPlasmaInjection` splices the glowing-filament term into a standard
 * three.js material's shaders. It MUST:
 *   - throw loudly when a three.js anchor is missing (version drift),
 *   - splice the varying + vertex/fragment terms in the right order,
 *   - re-apply its splices on every compile (no "already injected" flag —
 *     three calls onBeforeCompile with a FRESH stock shader on every
 *     (re)compile, including after a WebGL context restore),
 *   - pin `customProgramCacheKey` to a stable constant so every plasma
 *     filament compiles into ONE shared program slot.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLASMA_FRAG_ANCHOR,
  PLASMA_FRAG_INJECTION,
  PLASMA_PROGRAM_KEY,
  PLASMA_VERT_ANCHOR,
  applyPlasmaInjection,
} from "../../../src/plugins/atomic-topology/scene/plasmaShader";

/** A fake three.js stock shader pair (the anchors as three emits them). */
function stockShaders() {
  return {
    vertexShader: [
      "attribute vec2 uv;",
      "void main() {",
      PLASMA_VERT_ANCHOR,
      "  gl_Position = vec4(0.0);",
      "}",
    ].join("\n"),
    fragmentShader: [
      "void main() {",
      PLASMA_FRAG_ANCHOR,
      "  gl_FragColor = vec4(outgoingLight, 1.0);",
      "}",
    ].join("\n"),
  };
}

function fakeMaterial() {
  const material = {
    onBeforeCompile: undefined as
      | ((shader: { vertexShader: string; fragmentShader: string }, renderer: unknown) => void)
      | undefined,
    customProgramCacheKey: undefined as (() => string) | undefined,
    needsUpdate: true,
  };
  applyPlasmaInjection(material);
  return material;
}

test("plasma injection: splices the fragment term AFTER the outgoingLight anchor", () => {
  const material = fakeMaterial();
  const shader = stockShaders();
  material.onBeforeCompile!(shader, {});

  const frag = shader.fragmentShader;
  assert.ok(frag.includes("varying vec2 vPlasmaUv;"), "missing fragment varying");
  assert.ok(
    frag.includes("vec3 outgoingLight = reflectedLight.indirectDiffuse;"),
    "stock anchor was destroyed"
  );
  assert.ok(
    frag.includes("outgoingLight +="),
    "the additive plasma term (outgoingLight += ...) is missing"
  );
  // The plasma term must land AFTER the anchor (the indirectDiffuse line).
  assert.ok(
    frag.indexOf("vec3 outgoingLight = reflectedLight.indirectDiffuse;") <
      frag.indexOf("outgoingLight +="),
    "plasma term must follow the outgoingLight assignment"
  );
});

test("plasma injection: splices `vPlasmaUv = uv;` AFTER the uv_vertex include", () => {
  const material = fakeMaterial();
  const shader = stockShaders();
  material.onBeforeCompile!(shader, {});

  const vert = shader.vertexShader;
  assert.ok(vert.includes("varying vec2 vPlasmaUv;"), "missing vertex varying");
  assert.ok(vert.includes("vPlasmaUv = uv;"), "missing uv assignment");
  assert.ok(
    vert.indexOf("#include <uv_vertex>") < vert.indexOf("vPlasmaUv = uv;"),
    "uv assignment must follow the uv_vertex include (attribute declared in prelude)"
  );
});

test("plasma injection: re-applies on every compile (no stale 'already injected' flag)", () => {
  const material = fakeMaterial();
  // three calls onBeforeCompile with a FRESH shader on each (re)compile —
  // simulate two compiles from clean stock source.
  for (let i = 0; i < 2; i += 1) {
    const shader = stockShaders();
    assert.ok(!shader.fragmentShader.includes("vPlasmaUv"), "stock source must be clean");
    material.onBeforeCompile!(shader, {});
    assert.ok(shader.fragmentShader.includes("vPlasmaUv"), "compile " + i + " lost the injection");
    assert.ok(shader.vertexShader.includes("vPlasmaUv"), "compile " + i + " lost the injection");
  }
});

test("plasma injection: throws when the fragment anchor is missing (three.js drift)", () => {
  const material = fakeMaterial();
  const shader = {
    vertexShader: stockShaders().vertexShader,
    fragmentShader: "void main() { gl_FragColor = vec4(1.0); }", // no anchor
  };
  assert.throws(() => material.onBeforeCompile!(shader, {}), /plasmaShader: fragment anchor/);
});

test("plasma injection: throws when the vertex anchor is missing (three.js drift)", () => {
  const material = fakeMaterial();
  const shader = {
    vertexShader: "void main() { gl_Position = vec4(0.0); }", // no anchor
    fragmentShader: stockShaders().fragmentShader,
  };
  assert.throws(() => material.onBeforeCompile!(shader, {}), /plasmaShader: vertex anchor/);
});

test("plasma injection: customProgramCacheKey is pinned to a stable constant", () => {
  const material = fakeMaterial();
  assert.equal(typeof material.customProgramCacheKey, "function");
  assert.equal(material.customProgramCacheKey!(), PLASMA_PROGRAM_KEY);
  assert.ok(PLASMA_PROGRAM_KEY.includes("plasma"), "program key must be identifiable");
});

test("plasma injection: the injection fragment is a valid GLSL snippet (balanced braces)", () => {
  const open = PLASMA_FRAG_INJECTION.split("{").length - 1;
  const close = PLASMA_FRAG_INJECTION.split("}").length - 1;
  assert.equal(open, close, "unbalanced braces in the injected GLSL");
  assert.ok(PLASMA_FRAG_INJECTION.includes("vPlasmaUv"), "injection must consume the varying");
});
