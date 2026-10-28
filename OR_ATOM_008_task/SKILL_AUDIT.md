# OR-ATOM-008 Skill Hub Audit (S8.0 skill-discovery worker)

> **⚠️ LIVE HUB UNAVAILABLE → LOCAL-FALLBACK.** The live Skill Hub was probed on the
> running deployment at `127.0.0.1:20128`. The MCP transport is **disabled** and the WP4
> Skill-Hub REST surface is **not exposed** by the running binary, so catalog search/load
> could not be performed live. **No live skill count is claimed and no skill was live-loaded.**
> All discovery/search/load work was performed against the local `skills-import/` corpus,
> extracted read-only to `/tmp/or-atom-008-corpus`. Every technique below is sourced from
> verbatim local `SKILL.md` + referenced files included in the "FULL LOADED INSTRUCTIONS"
> section — nothing is invented.

## Connection

- **Timestamp:** 2026-10-27T20:44:47Z → 20:48Z (UTC; local America/Los_Angeles 13:44–13:48)
- **Worktree under audit:** branch `HEAD` (detached), HEAD short `fbe08518e`,
  full `fbe08518e5b2fbf4d65d6cafbc7092d9b9ac81ee`, subject "Zoo parallel task snapshot".
- **Live deployment:** `omniroute (v16.3.1)`, PID 45184, listening on `127.0.0.1:20128`,
  process started 2026-10-20 (verified via `lsof -nP -iTCP:20128`).
- **`/api/mcp/status` heartbeat (live value):** MCP `version 1.8.1`, `transport: stdio`,
  `status: offline`, `online: false`, `enabled: false`, `pidAlive: false`,
  `heartbeatAgeMs ≈ 2.3e9` (stale since 2026-10-01); `httpTransport.online: false`,
  `httpTransport.transport: null`; `activity.totalCalls24h: 1`.
- **MCP tool names verified from source (not from the live hub, which is offline):**
  - `open-sse/mcp-server/tools/skillTools.ts` → `omniroute_skills_list` (list registered skills).
  - `open-sse/mcp-server/tools/catalogTools.ts` → WP4 catalog family **`omr_catalog_search`,
    `omr_catalog_load`, `omr_catalog_resource`, `omr_catalog_execute`**.
  - Note: the mission text referenced `omr_skill_list/search/get/load`; the **actual** WP4
    catalog tool family in this codebase is the `omr_catalog_*` set above (the `omr_skill_*`
    names are not present in `open-sse/`). Because the server is offline, none of these were
    callable; names were read from source, not discovered over the wire.

### Exact HTTP calls made (all on loopback `127.0.0.1:20128`, status codes captured)

| #   | Method + URL                                                                          | Status  | Response (abridged)                                                                                                                 |
| --- | ------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api/mcp/status`                                                                 | 200     | `{"status":"offline","online":false,"enabled":false,"transport":"stdio",...,"httpTransport":{"online":false,"transport":null},...}` |
| 2   | `POST /api/mcp/stream` (JSON-RPC `initialize`)                                        | **503** | `{"error":"MCP server is disabled. Enable it from the Endpoints page."}`                                                            |
| 3   | `GET /api/mcp/sse`                                                                    | **503** | `{"error":"MCP server is disabled. Enable it from the Endpoints page."}`                                                            |
| 4   | `GET /api/skills`                                                                     | 200     | `{"data":[],"total":0,"page":1,"limit":50,"totalPages":0,"skills":[],"provider":"skillssh","popularDefaults":[...]}`                |
| 5   | `GET /api/skills/catalog?query=graphics`                                              | **405** | empty body (route not exposed by running binary)                                                                                    |
| 6   | `POST /api/skills/catalog` `{action:"load",id:"imported:general/webgpu-threejs-tsl"}` | **405** | empty body                                                                                                                          |
| 7   | `GET /api/skills/marketplace`                                                         | 200     | `{"skills":[{name:git,...},{name:terminal,...},...]}` (popular-defaults only, `installCount:0`)                                     |
| 8   | `GET /api/skills/collect/detect`                                                      | 200     | `{"tools":{"windsurf":{"installed":true,...},...}}` (local agent-tool detection)                                                    |

### Authentication method (names only — no secret values captured or written)

- All REST probes were run **unauthenticated** on loopback. No Bearer token was required for
  the surfaces that responded (200) and none was available to send. The WP4 catalog route
  (`src/app/api/skills/catalog/route.ts`) is gated by `requireManagementAuth` in source, but the
  **running v16.3.1 binary returns HTTP 405** for it — i.e. that surface is not deployed.
- `.env` is not present in this worktree (snapshot). `.env.example` is listed in the root
  `.rooignore` (`.env` / `.env.*`), so direct grep of env files was blocked by the ignore guard;
  no environment variable **values** were read or logged. Only variable presence could be checked,
  and none were needed since MCP was disabled.
- **Live hub verdict:** MCP transport disabled (503) + WP4 REST catalog not exposed (405) +
  `/api/skills` empty (total 0, provider `skillssh`) ⇒ **live catalog unavailable**; fallback
  corpus used (see Catalog).

## Catalog

- **Live catalog count:** _not claimed._ Live discovery is unavailable (MCP disabled 503;
  WP4 REST 405; `/api/skills` `total:0`). This matches the OR-ATOM-007 finding that the running
  deployment does not expose the WP4 catalog surface.
- **Fallback corpus (`skills-import/*.zip` → `/tmp/or-atom-008-corpus`), raw SKILL.md count: 1410**
  (includes the `trading/` and `TRADING SKILLS/` zips, which are the same 501-skill set duplicated
  → effective unique ≈ 909). Per-package counts:

| Package (zip)          | SKILL.md count             |
| ---------------------- | -------------------------- |
| ai-gateway             | 47                         |
| diagnosing-superpowers | 1                          |
| engineering-workflows  | 15                         |
| engineering            | 186                        |
| fullstack-development  | 67                         |
| security-audit         | 85                         |
| trading                | 501                        |
| TRADING SKILLS         | 501 (duplicate of trading) |
| web-quality            | 6                          |
| webgpu-threejs-tsl     | 1                          |
| **Total (raw)**        | **1410**                   |

### Search terms + hit counts (case-insensitive grep over every `SKILL.md`, `__MACOSX` excluded)

| Search query         | Hit count |
| -------------------- | --------- |
| graphics             | 4         |
| webgl                | 0         |
| glsl                 | 1         |
| particle             | 1         |
| particle-system      | 1         |
| plasma               | 0         |
| volumetric           | 0         |
| shader               | 2         |
| threejs              | 1         |
| webgpu               | 1         |
| glow                 | 2         |
| bloom                | 38        |
| electrical           | 0         |
| animation            | 12        |
| motion               | 127       |
| performance          | 276       |
| reduced-motion       | 3         |
| accessibility        | 28        |
| visual-design        | 1         |
| (supplementary) shad | 40        |

**Interpretation:** there are **no** dedicated `plasma`, `volumetric`, `electrical`, or `webgl`
skills in the corpus — the only skill that matches the graphics stack (`webgl`/`glsl`/`particle`/
`shader`/`threejs`/`webgpu`/`particle-system`) is **`webgpu-threejs-tsl`** (it is the single hit for
every graphics term, including `particle-system`). `plasma`/`volumetric`/`electrical` have **zero**
direct matches, so G1/G2/G4 must be composed from the graphics skill + performance/design/motion
skills. `bloom` (38) and `motion` (127) hits are mostly trading/design prose, not graphics techniques.

### Selected skills (9) — exact ID + version + description (from frontmatter)

| #   | Exact skill ID (`name`)     | Revision                    | Source (zip → path)                                                 | Why relevant                                                                                                                                           | Loaded full SKILL.md + refs? |
| --- | --------------------------- | --------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| 1   | `webgpu-threejs-tsl`        | (no version in frontmatter) | webgpu-threejs-tsl.zip → `webgpu-threejs-tsl/`                      | The ONLY graphics skill; TSL shader materials, GPU compute particles, post-processing/bloom, device-loss — the entire graphics toolkit for G1/G2/G3/G4 | Yes (16 files)               |
| 2   | `performance`               | 2.0                         | web-quality.zip → `web-quality/performance/`                        | Strict GPU/perf budgets, RUM, measurement — G4                                                                                                         | Yes (3 files)                |
| 3   | `core-web-vitals`           | 2.0                         | web-quality.zip → `web-quality/core-web-vitals/`                    | LCP/INP/CLS — canvas must not cause layout shift or long tasks — G4                                                                                    | Yes (4 files)                |
| 4   | `accessibility`             | 2.0                         | web-quality.zip → `web-quality/accessibility/`                      | WCAG 2.2 incl. `prefers-reduced-motion` — G4                                                                                                           | Yes (3 files)                |
| 5   | `accessibility-compliance`  | (no version)                | engineering.zip → `engineering/accessibility-compliance/`           | ARIA/mobile/inclusive patterns, reduced-motion — G4                                                                                                    | Yes (5 files)                |
| 6   | `web-quality-audit`         | (no version)                | web-quality.zip → `web-quality/web-quality-audit/`                  | Read-only HTML/quality analyzer + screenshot QA for rendered verification — G4                                                                         | Yes (2 files)                |
| 7   | `visual-design-foundations` | (no version)                | engineering.zip → `engineering/visual-design-foundations/`          | Color theory/design tokens — model-colored protons/neutrons, neutral-unknown palette — G3                                                              | Yes (4 files)                |
| 8   | `interaction-design`        | (no version)                | engineering.zip → `engineering/interaction-design/`                 | Motion design, micro-interactions, animation libraries — job-state pulses/discharge timing — G1/G4                                                     | Yes (4 files)                |
| 9   | `game-developer`            | 1.1.0                       | fullstack-development.zip → `fullstack-development/game-developer/` | Shader programming, 60+ FPS optimization, particle/object-pooling, ECS — G4                                                                            | Yes (1 file)                 |

**Not selected (and why):**

- `engineering/pptx-visual-assets` — "graphics" hit but PPTX-specific, not WebGL.
- `TRADING SKILLS/trading/*` + `trading/*` (501 dup) — zero graphics relevance.
- `bloom`/`motion`/`shad` prose hits (trading, iOS/React-Native design) — mention terms but carry
  no WebGL/particle technique.
- `engineering/react-native-design`, `engineering/tailwind-design-system`, `fullstack-development/react-native-expert` —
  animation hits but React-Native/Tailwind, not the WebGL canvas stack.
- `engineering/godot-gdscript-patterns` — 3D animation but Godot engine, wrong stack.
- `fullstack-development/flutter-expert` — 3D animation but Flutter engine, wrong stack.
- `web-quality/best-practices`, `web-quality/seo` — generic/SEO, no graphics or perf-canvas signal.

**Quarantined / disabled / unavailable:**

- `omniroute_skills_list` (live registry) returned nothing because `/api/skills` `total:0` and the
  MCP transport is disabled — the live registry is empty on this deployment; no quarantined entries observed.
- No skill in the fallback corpus carries an installer command or network call that was executed.
  All 9 selected skills are **instructional** (markdown + example snippets); none was "executed".

**Discovery blockers:**

- MCP transport disabled (503) — cannot use `omr_catalog_*` live.
- WP4 REST catalog not deployed on the running binary (405) — cannot search/load over REST.
- `.env.example` is `.rooignore`-blocked, so env enablement could only be checked by presence, not value.

## Techniques mapping (loaded technique → target file → goal)

Target files are the four scene modules the S8.1–S8.3 workers will edit. `scene/` = `src/plugins/atomic-topology/scene/`.

| Technique (source skill / file)                                                                                                                                                           | Target file                                | Goal    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------- |
| TSL custom node material / `MeshStandardNodeMaterial` port to WebGL2 (webgpu-threejs-tsl / `examples/custom-material.js`, `docs/materials.md`)                                            | `scene/EnergyLink.tsx`                     | G1      |
| Fine additive filament geometry + traveling emission via time-uniform (webgpu-threejs-tsl / `docs/materials.md`, `examples/earth-shader.js`)                                              | `scene/EnergyLink.tsx`                     | G1      |
| Event-driven discharge tint / branch on job state (webgpu-threejs-tsl / `docs/core-concepts.md`; interaction-design / `microinteraction-patterns.md`)                                     | `scene/EnergyLink.tsx`                     | G1      |
| GPU compute particle density / translucent orbital cloud (webgpu-threejs-tsl / `docs/compute-shaders.md`, `templates/compute-shader.js`, `examples/particle-system.js`)                   | `scene/ElectronCloud.tsx`                  | G2      |
| Soft colored haze + controlled additive glow around sprites (webgpu-threejs-tsl / `docs/post-processing.md`, `examples/post-processing.js`)                                               | `scene/ElectronCloud.tsx`                  | G2 / G4 |
| Fresnel rim / per-particle luminance for protons vs neutrons (webgpu-threejs-tsl / `docs/materials.md`)                                                                                   | `scene/AtomNode.tsx` + `scene/Nucleus.tsx` | G3      |
| Model-colored nucleus (up to 3 observed colors), neutral when unknown (visual-design-foundations / `references/color-systems.md`)                                                         | `scene/AtomNode.tsx` + `scene/Nucleus.tsx` | G3      |
| Motion timing, pulse/feedback micro-interactions, reduced-motion fallback (interaction-design / `references/animation-libraries.md`, `microinteraction-patterns.md`)                      | `scene/EnergyLink.tsx`                     | G1 / G4 |
| Perf budget, 60 FPS target, object pooling, RUM measurement (performance / `SKILL.md`, `references/RUM.md`, `MEASUREMENT.md`; game-developer / `SKILL.md`)                                | all four scene files                       | G4      |
| Core Web Vitals guard (no CLS/long-task from canvas) (core-web-vitals / `references/CLS.md`, `INP.md`, `LCP.md`)                                                                          | all four scene files                       | G4      |
| `prefers-reduced-motion` + canvas accessibility (accessibility / `SKILL.md`, `references/WCAG.md`; accessibility-compliance / `references/wcag-guidelines.md`, `mobile-accessibility.md`) | all four scene files                       | G4      |
| GPU device-loss / WebGL context-lost recovery + device limits (webgpu-threejs-tsl / `docs/device-loss.md`, `docs/limits-and-features.md`)                                                 | all four scene files                       | G4      |
| Post-render screenshot/HTML quality verification (web-quality-audit / `SKILL.md`, `scripts/analyze.sh`)                                                                                   | rendered scene QA                          | G4      |

> **HARD FREEZE reminder (from `OR_ATOM_008_CONTEXT.md`):** do **not** change camera, zoom,
> auto-fit, layout, topology positions, node count, DOM labels, label-collision logic, controls,
> navigation, provider/GPU identity, or the ReactFlow fallback. Do not replace Step 7's tilted
> shell groups + additive `spriteMaterial` electrons with static dots — build on them.

---

---

## FULL LOADED INSTRUCTIONS (verbatim, un-summarized)

> Implementation workers should work from this section directly. Each skill lists every file in
> the corpus package, verbatim, inside 5-backtick fences (safe: no file contains a 4+ backtick run).

## Skill: webgpu-threejs-tsl (webgpu-threejs-tsl.zip)

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/SKILL.md`

````{txt}
---
name: webgpu-threejs-tsl
description: Comprehensive guide for developing WebGPU-enabled Three.js applications using TSL (Three.js Shading Language). Covers WebGPU renderer setup, TSL syntax and node materials, compute shaders, post-processing effects, and WGSL integration. Use this skill when working with Three.js WebGPU, TSL shaders, node materials, or GPU compute in Three.js.
---

# WebGPU Three.js with TSL

TSL (Three.js Shading Language) is a node-based shader abstraction that lets you write GPU shaders in JavaScript instead of GLSL/WGSL strings.

## Quick Start

```javascript
import * as THREE from 'three/webgpu';
import { color, time, oscSine } from 'three/tsl';

const renderer = new THREE.WebGPURenderer();
await renderer.init();

const material = new THREE.MeshStandardNodeMaterial();
material.colorNode = color(0xff0000).mul(oscSine(time));
```

## Skill Contents

### Documentation
- `docs/core-concepts.md` - Types, operators, uniforms, control flow
- `docs/materials.md` - Node materials and all properties
- `docs/compute-shaders.md` - GPU compute with instanced arrays
- `docs/post-processing.md` - Built-in and custom effects
- `docs/wgsl-integration.md` - Custom WGSL functions
- `docs/device-loss.md` - Handling GPU device loss and recovery
- `docs/limits-and-features.md` - WebGPU device limits and optional features

### Examples
- `examples/basic-setup.js` - Minimal WebGPU project
- `examples/custom-material.js` - Custom shader material
- `examples/particle-system.js` - GPU compute particles
- `examples/post-processing.js` - Effect pipeline
- `examples/earth-shader.js` - Complete Earth with atmosphere

### Templates
- `templates/webgpu-project.js` - Starter project template
- `templates/compute-shader.js` - Compute shader template

### Reference
- `REFERENCE.md` - Quick reference cheatsheet

## Key Concepts

### Import Pattern
```javascript
// Always use the WebGPU entry point
import * as THREE from 'three/webgpu';
import { /* TSL functions */ } from 'three/tsl';
```

### Node Materials
Replace standard material properties with TSL nodes:
```javascript
material.colorNode = texture(map);        // instead of material.map
material.roughnessNode = float(0.5);      // instead of material.roughness
material.positionNode = displaced;         // vertex displacement
```

### Method Chaining
TSL uses method chaining for operations:
```javascript
// Instead of: sin(time * 2.0 + offset) * 0.5 + 0.5
time.mul(2.0).add(offset).sin().mul(0.5).add(0.5)
```

### Custom Functions
Use `Fn()` for reusable shader logic:
```javascript
const fresnel = Fn(([power = 2.0]) => {
  const nDotV = normalWorld.dot(viewDir).saturate();
  return float(1.0).sub(nDotV).pow(power);
});
```

## When to Use This Skill

- Setting up Three.js with WebGPU renderer
- Creating custom shader materials with TSL
- Writing GPU compute shaders
- Building post-processing pipelines
- Migrating from GLSL to TSL
- Implementing visual effects (particles, water, terrain, etc.)

## Resources

- [Three.js TSL Wiki](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language)
- [WebGPU Examples](https://github.com/mrdoob/three.js/tree/master/examples) (files prefixed with `webgpu_`)
````

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/REFERENCE.md`

````{txt}
# TSL Quick Reference

## Imports

```javascript
// WebGPU Three.js
import * as THREE from 'three/webgpu';

// Core TSL
import {
  float, int, uint, bool,
  vec2, vec3, vec4, color,
  mat2, mat3, mat4,
  uniform, texture, uv,
  Fn, If, Loop, Break, Continue,
  time, deltaTime
} from 'three/tsl';
```

## Types

| TSL | WGSL | Example |
|-----|------|---------|
| `float(1.0)` | `f32` | Scalar float |
| `int(1)` | `i32` | Signed integer |
| `uint(1)` | `u32` | Unsigned integer |
| `bool(true)` | `bool` | Boolean |
| `vec2(x, y)` | `vec2<f32>` | 2D vector |
| `vec3(x, y, z)` | `vec3<f32>` | 3D vector |
| `vec4(x, y, z, w)` | `vec4<f32>` | 4D vector |
| `color(0xff0000)` | `vec3<f32>` | RGB color |
| `uniform(value)` | uniform | Dynamic value |

## Operators

| Operation | TSL | GLSL Equivalent |
|-----------|-----|-----------------|
| Add | `a.add(b)` | `a + b` |
| Subtract | `a.sub(b)` | `a - b` |
| Multiply | `a.mul(b)` | `a * b` |
| Divide | `a.div(b)` | `a / b` |
| Modulo | `a.mod(b)` | `mod(a, b)` |
| Negate | `a.negate()` | `-a` |
| Less Than | `a.lessThan(b)` | `a < b` |
| Greater Than | `a.greaterThan(b)` | `a > b` |
| Equal | `a.equal(b)` | `a == b` |
| And | `a.and(b)` | `a && b` |
| Or | `a.or(b)` | `a \|\| b` |
| Assign | `a.assign(b)` | `a = b` |
| Add Assign | `a.addAssign(b)` | `a += b` |

## Swizzling

```javascript
const v = vec3(1, 2, 3);
v.x        // 1
v.xy       // vec2(1, 2)
v.zyx      // vec3(3, 2, 1)
v.rgb      // same as xyz
```

## Math Functions

| Function | Description |
|----------|-------------|
| `abs(x)` | Absolute value |
| `sign(x)` | Sign (-1, 0, 1) |
| `floor(x)` | Round down |
| `ceil(x)` | Round up |
| `fract(x)` | Fractional part |
| `min(a, b)` | Minimum |
| `max(a, b)` | Maximum |
| `clamp(x, lo, hi)` | Clamp to range |
| `mix(a, b, t)` | Linear interpolation |
| `step(edge, x)` | Step function |
| `smoothstep(a, b, x)` | Smooth step |
| `sin(x)`, `cos(x)` | Trigonometry |
| `pow(x, y)` | Power |
| `sqrt(x)` | Square root |
| `length(v)` | Vector length |
| `distance(a, b)` | Distance |
| `dot(a, b)` | Dot product |
| `cross(a, b)` | Cross product |
| `normalize(v)` | Unit vector |
| `reflect(i, n)` | Reflection |

## Geometry Nodes

| Node | Description |
|------|-------------|
| `positionLocal` | Model space position |
| `positionWorld` | World space position |
| `positionView` | Camera space position |
| `normalLocal` | Model space normal |
| `normalWorld` | World space normal |
| `normalView` | Camera space normal |
| `uv()` | UV coordinates |
| `uv(1)` | Secondary UVs |
| `tangentLocal` | Tangent vector |
| `vertexColor()` | Vertex colors |

## Camera Nodes

| Node | Description |
|------|-------------|
| `cameraPosition` | Camera world position |
| `cameraNear` | Near plane |
| `cameraFar` | Far plane |
| `cameraViewMatrix` | View matrix |
| `cameraProjectionMatrix` | Projection matrix |
| `screenUV` | Screen UV (0-1) |
| `screenSize` | Screen dimensions |

## Time

| Node | Description |
|------|-------------|
| `time` | Seconds since start |
| `deltaTime` | Frame delta |
| `oscSine(t)` | Sine wave (0-1) |
| `oscSquare(t)` | Square wave |
| `oscTriangle(t)` | Triangle wave |
| `oscSawtooth(t)` | Sawtooth wave |

## Material Properties

```javascript
const mat = new THREE.MeshStandardNodeMaterial();

// Basic
mat.colorNode = color(0xff0000);
mat.opacityNode = float(0.8);
mat.alphaTestNode = float(0.5);

// PBR
mat.roughnessNode = float(0.5);
mat.metalnessNode = float(0.0);
mat.emissiveNode = color(0x000000);
mat.normalNode = normalMap(tex);

// Physical (MeshPhysicalNodeMaterial)
mat.clearcoatNode = float(1.0);
mat.transmissionNode = float(0.9);
mat.iridescenceNode = float(1.0);
mat.sheenNode = float(1.0);

// Vertex
mat.positionNode = displaced;
```

## Control Flow

```javascript
// If-Else
If(condition, () => {
  // true
}).ElseIf(other, () => {
  // other true
}).Else(() => {
  // false
});

// Select (ternary)
const result = select(condition, trueVal, falseVal);

// Loop
Loop(10, ({ i }) => {
  // i = 0 to 9
});

// Loop control
Break();
Continue();
Discard();  // Fragment only
```

## Custom Functions

```javascript
// Basic function
const myFn = Fn(([a, b]) => {
  return a.add(b);
});

// With defaults
const myFn = Fn(([a = 1.0, b = 2.0]) => {
  return a.add(b);
});

// Usage
myFn(x, y);
myFn();  // uses defaults
```

## Compute Shaders

```javascript
// Storage buffers (read-write)
const positions = instancedArray(count, 'vec3');
const values = instancedArray(count, 'float');

// Read-only storage buffers
const lookupTable = attributeArray(data, 'float');

// Compute shader
const compute = Fn(() => {
  const pos = positions.element(instanceIndex);
  pos.addAssign(vec3(0.01, 0, 0));
})().compute(count);

// Execute (after await renderer.init())
renderer.compute(compute);

// Workgroup size
const compute2 = Fn(() => { /* ... */ })().compute(count, [64]);
```

## Post-Processing

```javascript
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

// Setup (RenderPipeline replaced PostProcessing in r183)
const renderPipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const color = scenePass.getTextureNode('output');

// Apply effects
const bloomPass = bloom(color);
renderPipeline.outputNode = color.add(bloomPass);

// Render
renderPipeline.render();
```

## Common Patterns

### Fresnel

```javascript
const viewDir = cameraPosition.sub(positionWorld).normalize();
const fresnel = float(1).sub(normalWorld.dot(viewDir).saturate()).pow(3);
```

### Animated UV

```javascript
const animUV = uv().add(vec2(time.mul(0.1), 0));
```

### Noise Hash

```javascript
const noise = fract(position.dot(vec3(12.9898, 78.233, 45.543)).sin().mul(43758.5453));
```

### Dissolve

```javascript
const noise = hash(positionLocal.mul(50));
If(noise.lessThan(threshold), () => Discard());
```

### Color Gradient

```javascript
const gradient = mix(colorA, colorB, positionLocal.y.mul(0.5).add(0.5));
```

## Node Materials

| Material | Use Case |
|----------|----------|
| `MeshBasicNodeMaterial` | Unlit |
| `MeshStandardNodeMaterial` | PBR |
| `MeshPhysicalNodeMaterial` | Advanced PBR |
| `MeshPhongNodeMaterial` | Phong shading |
| `MeshToonNodeMaterial` | Cel shading |
| `PointsNodeMaterial` | Point clouds |
| `LineBasicNodeMaterial` | Lines |
| `SpriteNodeMaterial` | Sprites |

## Device Loss Handling

```javascript
// Listen for device loss
renderer.backend.device.lost.then((info) => {
  if (info.reason === 'unknown') {
    // Unexpected loss - recover
    renderer.dispose();
    initWebGPU();  // Reinitialize
  }
});

// Simulate loss for testing
renderer.backend.device.destroy();
```

| Loss Reason | Meaning |
|-------------|---------|
| `'destroyed'` | Intentional via `destroy()` |
| `'unknown'` | Unexpected (driver crash, timeout, etc.) |

**Recovery tips:**
- Always get fresh adapter before new device
- Save/restore application state (not transient data)
- Use Chrome `about:gpucrash` to test real GPU crashes

## Compute Shader Built-ins

| Node | Description |
|------|-------------|
| `instanceIndex` | Current instance/invocation index |
| `vertexIndex` | Current vertex index |
| `drawIndex` | Current draw call index |
| `globalId` | Global invocation position (uvec3) |
| `localId` | Local workgroup position (uvec3) |
| `workgroupId` | Workgroup index (uvec3) |
| `numWorkgroups` | Number of workgroups dispatched (uvec3) |
| `subgroupSize` | Size of the subgroup |

## Device Limits

WebGPU devices use **default minimums** unless you request higher limits. This is critical for large buffers.

```javascript
// Three.js: pass requiredLimits to the renderer
const renderer = new THREE.WebGPURenderer({
  requiredLimits: {
    maxBufferSize: 1024 * 1024 * 1024,            // 1 GiB
    maxStorageBufferBindingSize: 1024 * 1024 * 512, // 512 MiB
  },
});
await renderer.init();
```

| Limit | Default | Common Need |
|-------|---------|-------------|
| `maxBufferSize` | 256 MiB | Large vertex/storage buffers |
| `maxStorageBufferBindingSize` | 128 MiB | Large compute buffers |
| `maxStorageBuffersPerShaderStage` | 8 | Many storage buffers |

**Check before requesting:**
```javascript
const adapter = await navigator.gpu?.requestAdapter();
if (adapter.limits.maxBufferSize >= desiredSize) {
  // Safe to request
}
```

See `docs/limits-and-features.md` for full details.

## Version Notes

**r178+:**
- `PI2` is deprecated → use `TWO_PI`
- `transformedNormalView` → use `normalView`
- `transformedNormalWorld` → use `normalWorld`

**r171+:**
- Recommended minimum version for stable TSL
- Requires separate `three/webgpu` import map entry

## Resources

- [TSL Wiki](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language)
- [TSL Docs](https://threejs.org/docs/pages/TSL.html)
- [WebGPU Examples](https://github.com/mrdoob/three.js/tree/master/examples)
- [Three.js Docs](https://threejs.org/docs/)
- [WebGPU Best Practices - Device Loss](https://toji.dev/webgpu-best-practices/device-loss)
````

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/docs/core-concepts.md`

````{txt}
# TSL Core Concepts

## Types and Constructors

### Scalar Types
```javascript
import { float, int, uint, bool } from 'three/tsl';

const f = float(1.0);
const i = int(42);
const u = uint(100);
const b = bool(true);
```

### Vector Types
```javascript
import { vec2, vec3, vec4, color } from 'three/tsl';

const v2 = vec2(1.0, 2.0);
const v3 = vec3(1.0, 2.0, 3.0);
const v4 = vec4(1.0, 2.0, 3.0, 1.0);

// Color (RGB, accepts hex or components)
const c = color(0xff0000);     // Red
const c2 = color(1, 0.5, 0);   // Orange
```

### Matrix Types
```javascript
import { mat2, mat3, mat4 } from 'three/tsl';

const m3 = mat3();
const m4 = mat4();
```

### Type Conversion
```javascript
const v = vec3(1, 2, 3);
const v4 = v.toVec4(1.0);      // vec4(1, 2, 3, 1)
const f = int(42).toFloat();   // 42.0
const c = v.toColor();         // Convert to color
```

## Vector Swizzling

Access and reorder vector components using standard notation:

```javascript
const v = vec3(1.0, 2.0, 3.0);

// Single component access
v.x  // 1.0
v.y  // 2.0
v.z  // 3.0

// Multiple components
v.xy   // vec2(1.0, 2.0)
v.xyz  // vec3(1.0, 2.0, 3.0)

// Reorder components
v.zyx  // vec3(3.0, 2.0, 1.0)
v.xxy  // vec3(1.0, 1.0, 2.0)
v.rrr  // vec3(1.0, 1.0, 1.0) - same as xxx

// Alternative accessors (all equivalent)
v.xyz  // position
v.rgb  // color
v.stp  // texture coordinates
```

## Uniforms

Uniforms pass values from JavaScript to shaders:

```javascript
import { uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';

// Create uniforms
const myColor = uniform(new THREE.Color(0x0066ff));
const myFloat = uniform(0.5);
const myVec3 = uniform(new THREE.Vector3(1, 2, 3));

// Update at runtime
myColor.value.set(0xff0000);
myFloat.value = 0.8;
myVec3.value.set(4, 5, 6);

// Use in material
material.colorNode = myColor;
```

### Auto-Updating Uniforms

```javascript
// Update every frame
const animatedValue = uniform(0).onFrameUpdate((frame) => {
  return Math.sin(frame.time);
});

// Update per object render
const perObjectValue = uniform(0).onObjectUpdate((object) => {
  return object.userData.customValue;
});

// Update once per render cycle
const renderValue = uniform(0).onRenderUpdate((state) => {
  return state.delta;
});
```

## Operators

### Arithmetic
```javascript
// Method chaining (preferred)
const result = a.add(b).mul(c).sub(d).div(e);

// Individual operations
a.add(b)   // a + b
a.sub(b)   // a - b
a.mul(b)   // a * b
a.div(b)   // a / b
a.mod(b)   // a % b
a.negate() // -a
```

### Comparison
```javascript
a.equal(b)            // a == b
a.notEqual(b)         // a != b
a.lessThan(b)         // a < b
a.greaterThan(b)      // a > b
a.lessThanEqual(b)    // a <= b
a.greaterThanEqual(b) // a >= b
```

### Logical
```javascript
a.and(b)   // a && b
a.or(b)    // a || b
a.not()    // !a
a.xor(b)   // a ^ b
```

### Bitwise
```javascript
a.bitAnd(b)      // a & b
a.bitOr(b)       // a | b
a.bitXor(b)      // a ^ b
a.bitNot()       // ~a
a.shiftLeft(n)   // a << n
a.shiftRight(n)  // a >> n
```

### Assignment (for variables)
```javascript
const v = vec3(0).toVar();  // Create mutable variable

v.assign(vec3(1, 2, 3));    // v = vec3(1, 2, 3)
v.addAssign(vec3(1));       // v += vec3(1)
v.subAssign(vec3(1));       // v -= vec3(1)
v.mulAssign(2.0);           // v *= 2.0
v.divAssign(2.0);           // v /= 2.0
```

## Variables

### Mutable Variables
```javascript
// Create mutable variable with toVar()
const myVar = vec3(1, 0, 0).toVar();
myVar.assign(vec3(0, 1, 0));
myVar.addAssign(vec3(0, 0, 1));

// Name the variable (useful for debugging)
const named = vec3(0).toVar('myPosition');
```

### Constants
```javascript
// Create compile-time constant
const PI_HALF = float(Math.PI / 2).toConst();
```

### Properties (named values for shader stages)
```javascript
import { property } from 'three/tsl';

// Create named property
const myProp = property('vec3', 'customColor');
myProp.assign(vec3(1, 0, 0));
```

## Control Flow

### ⚠️ CRITICAL: Property Assignment vs Variable Reassignment

**TSL intercepts property assignments on nodes, but NOT JavaScript variable reassignment.**

| Pattern | Works? | Why |
|---------|--------|-----|
| `node.y = value` | ✅ | Property setter - TSL intercepts |
| `node.x.assign(value)` | ✅ | TSL method call |
| `variable = variable.add(1)` | ❌ | JS variable reassignment |

**This WORKS (vec3 property assignment):**
```javascript
const result = vec3(position);
If(result.y.greaterThan(limit), () => {
  result.y = limit;  // ✅ Property assignment - TSL intercepts!
});
```

**This DOES NOT work (scalar variable reassignment):**
```javascript
let value = buffer.element(index).toFloat();  // Scalar - no .x/.y properties
If(condition, () => {
  value = value.add(1.0);  // ❌ JS variable reassignment - TSL can't see this!
});
return value;  // Returns ORIGINAL node!
```

**Solutions for scalars:**
```javascript
// ✅ Use select() for conditional values
const result = select(condition, valueIfTrue, valueIfFalse);

// ✅ Use .toVar() for mutable variables
const value = buffer.element(index).toVar();
If(condition, () => {
  value.assign(value.add(1.0));  // Works with .toVar()!
});

// ✅ Use direct .assign() on buffer elements
If(condition, () => {
  element.assign(element.add(1.0));  // Direct buffer writes work!
});
```

### Conditionals

```javascript
import { If, select } from 'three/tsl';

// If-ElseIf-Else (use with .toVar() or direct .assign())
const result = vec3(0).toVar();

If(value.greaterThan(0.5), () => {
  result.assign(vec3(1, 0, 0));  // Red
}).ElseIf(value.greaterThan(0.25), () => {
  result.assign(vec3(0, 1, 0));  // Green
}).Else(() => {
  result.assign(vec3(0, 0, 1));  // Blue
});

// Ternary operator (select) - PREFERRED for simple conditionals
const color = select(
  condition,           // if true
  vec3(1, 0, 0),      // return this
  vec3(0, 0, 1)       // else return this
);
```

### Switch-Case

```javascript
import { Switch } from 'three/tsl';

const col = vec3(0).toVar();

Switch(intValue)
  .Case(0, () => { col.assign(color(1, 0, 0)); })
  .Case(1, () => { col.assign(color(0, 1, 0)); })
  .Case(2, () => { col.assign(color(0, 0, 1)); })
  .Default(() => { col.assign(color(1, 1, 1)); });
```

### Loops

```javascript
import { Loop, Break, Continue } from 'three/tsl';

// Simple loop (0 to 9)
const sum = float(0).toVar();
Loop(10, ({ i }) => {
  sum.addAssign(float(i));
});

// Ranged loop with options
Loop({ start: int(0), end: int(count), type: 'int' }, ({ i }) => {
  // Loop body
});

// Nested loops
Loop(width, height, ({ i, j }) => {
  // i = outer loop index
  // j = inner loop index
});

// Loop control
Loop(100, ({ i }) => {
  If(shouldStop, () => {
    Break();  // Exit loop
  });
  If(shouldSkip, () => {
    Continue();  // Skip to next iteration
  });
});
```

### Flow Control

```javascript
import { Discard, Return } from 'three/tsl';

// Discard fragment (make transparent)
If(alpha.lessThan(0.5), () => {
  Discard();
});

// Return from function
const myFn = Fn(() => {
  If(condition, () => {
    Return(vec3(1, 0, 0));
  });
  return vec3(0, 0, 1);
});
```

## Custom Functions with Fn()

### Basic Function
```javascript
import { Fn } from 'three/tsl';

const addVectors = Fn(([a, b]) => {
  return a.add(b);
});

// Usage
const result = addVectors(vec3(1, 0, 0), vec3(0, 1, 0));
```

### Default Parameters
```javascript
const oscillate = Fn(([frequency = 1.0, amplitude = 1.0]) => {
  return time.mul(frequency).sin().mul(amplitude);
});

// Call variations
oscillate();           // Uses defaults
oscillate(2.0);        // frequency = 2.0
oscillate(2.0, 0.5);   // frequency = 2.0, amplitude = 0.5
```

### Named Parameters (Object Style)
```javascript
const createGradient = Fn(({ colorA = vec3(0), colorB = vec3(1), t = 0.5 }) => {
  return mix(colorA, colorB, t);
});

// Call with named parameters
createGradient({ colorA: vec3(1, 0, 0), t: uv().x });
```

### Function with Context
```javascript
// Access shader context
const customShader = Fn(({ material, geometry, object }) => {
  if (material.userData.customColor) {
    return uniform(material.userData.customColor);
  }
  return vec3(1);
});
```

## Time and Animation

```javascript
import { time, deltaTime } from 'three/tsl';

// time - seconds since start
const rotation = time.mul(0.5);  // Half rotation per second

// deltaTime - time since last frame
const velocity = speed.mul(deltaTime);
```

### Oscillators

```javascript
import { oscSine, oscSquare, oscTriangle, oscSawtooth } from 'three/tsl';

// All oscillators return 0-1 range
oscSine(time)      // Smooth sine wave
oscSquare(time)    // Square wave (0 or 1)
oscTriangle(time)  // Triangle wave
oscSawtooth(time)  // Sawtooth wave

// Custom frequency
oscSine(time.mul(2.0))  // 2Hz oscillation
```

## Math Functions

### Basic Math
```javascript
import { abs, sign, floor, ceil, fract, mod, min, max, clamp } from 'three/tsl';

abs(x)           // Absolute value
sign(x)          // -1, 0, or 1
floor(x)         // Round down
ceil(x)          // Round up
fract(x)         // Fractional part (x - floor(x))
mod(x, y)        // Modulo
min(x, y)        // Minimum
max(x, y)        // Maximum
clamp(x, 0, 1)   // Clamp to range
```

### Trigonometry
```javascript
import { sin, cos, tan, asin, acos, atan, atan2 } from 'three/tsl';

sin(x)
cos(x)
tan(x)
asin(x)
acos(x)
atan(x)
atan2(y, x)
```

### Exponential
```javascript
import { pow, exp, log, sqrt, inverseSqrt } from 'three/tsl';

pow(x, 2.0)      // x^2
exp(x)           // e^x
log(x)           // Natural log
sqrt(x)          // Square root
inverseSqrt(x)   // 1 / sqrt(x)
```

### Interpolation
```javascript
import { mix, step, smoothstep } from 'three/tsl';

mix(a, b, 0.5)              // Linear interpolation
step(0.5, x)                // 0 if x < 0.5, else 1
smoothstep(0.0, 1.0, x)     // Smooth 0-1 transition
```

### Vector Math
```javascript
import { length, distance, dot, cross, normalize, reflect, refract } from 'three/tsl';

length(v)              // Vector length
distance(a, b)         // Distance between points
dot(a, b)              // Dot product
cross(a, b)            // Cross product (vec3 only)
normalize(v)           // Unit vector
reflect(incident, normal)
refract(incident, normal, eta)
```

### Constants
```javascript
import { PI, TWO_PI, HALF_PI, EPSILON } from 'three/tsl';

PI        // 3.14159...
TWO_PI    // 6.28318...
HALF_PI   // 1.57079...
EPSILON   // Very small number
```

## Utility Functions

```javascript
import { hash, checker, remap, range, rotate } from 'three/tsl';

// Pseudo-random hash
hash(seed)                    // Returns 0-1

// Checkerboard pattern
checker(uv())                 // Returns 0 or 1

// Remap value from one range to another
remap(x, 0, 1, -1, 1)        // Map 0-1 to -1 to 1

// Generate value in range
range(min, max)               // Random in range (per instance)

// Rotate 2D vector
rotate(vec2(1, 0), angle)
```
````

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/docs/materials.md`

````{txt}
# TSL Node Materials

## Available Material Types

| Material | Description |
|----------|-------------|
| `MeshBasicNodeMaterial` | Unlit, no lighting calculations |
| `MeshStandardNodeMaterial` | PBR material with metalness/roughness |
| `MeshPhysicalNodeMaterial` | Advanced PBR with clearcoat, transmission, etc. |
| `MeshPhongNodeMaterial` | Classic Phong shading |
| `MeshToonNodeMaterial` | Cel/toon shading |
| `MeshLambertNodeMaterial` | Diffuse-only lighting |
| `MeshNormalNodeMaterial` | Visualize normals |
| `MeshMatcapNodeMaterial` | Matcap texture shading |
| `PointsNodeMaterial` | For point clouds |
| `LineBasicNodeMaterial` | For lines |
| `LineDashedNodeMaterial` | For dashed lines |
| `SpriteNodeMaterial` | For sprites/billboards |

## Creating Node Materials

```javascript
import * as THREE from 'three/webgpu';

// Standard PBR material
const material = new THREE.MeshStandardNodeMaterial();

// Physical material with advanced features
const physicalMat = new THREE.MeshPhysicalNodeMaterial();

// Unlit material
const basicMat = new THREE.MeshBasicNodeMaterial();
```

## Material Properties

### Color and Opacity

```javascript
import { texture, color, float } from 'three/tsl';

// Color from texture
material.colorNode = texture(diffuseMap);

// Solid color
material.colorNode = color(0xff0000);

// Computed color
material.colorNode = positionLocal.normalize();

// Opacity (requires material.transparent = true)
material.opacityNode = float(0.8);
material.transparent = true;

// Alpha test threshold
material.alphaTestNode = float(0.5);
```

### PBR Properties (MeshStandardNodeMaterial)

```javascript
import { texture, float, color } from 'three/tsl';

// Metalness (0 = dielectric, 1 = metal)
material.metalnessNode = texture(metalMap).r;
material.metalnessNode = float(0.0);

// Roughness (0 = smooth/mirror, 1 = rough)
material.roughnessNode = texture(roughnessMap).r;
material.roughnessNode = float(0.5);

// Emissive (self-illumination)
material.emissiveNode = color(0xff0000).mul(2.0);
material.emissiveNode = texture(emissiveMap);
```

### Normal Mapping

```javascript
import { texture, normalMap, bumpMap } from 'three/tsl';

// Normal map
material.normalNode = normalMap(texture(normalMapTexture));

// Normal map with strength
material.normalNode = normalMap(texture(normalMapTexture), float(0.5));

// Bump map (height to normal)
material.normalNode = bumpMap(texture(heightMap), 0.05);
```

### Physical Properties (MeshPhysicalNodeMaterial)

```javascript
const material = new THREE.MeshPhysicalNodeMaterial();

// Clearcoat (car paint effect)
material.clearcoatNode = float(1.0);
material.clearcoatRoughnessNode = float(0.1);
material.clearcoatNormalNode = normalMap(texture(clearcoatNormalMap));

// Transmission (glass/translucency)
material.transmissionNode = float(0.9);
material.thicknessNode = float(0.5);
material.attenuationDistanceNode = float(1.0);
material.attenuationColorNode = color(0xffffff);

// Iridescence (soap bubble effect)
material.iridescenceNode = float(1.0);
material.iridescenceIORNode = float(1.3);
material.iridescenceThicknessNode = float(400);

// Sheen (fabric effect)
material.sheenNode = float(1.0);
material.sheenRoughnessNode = float(0.5);
material.sheenColorNode = color(0xffffff);

// Anisotropy (brushed metal)
material.anisotropyNode = float(1.0);
material.anisotropyRotationNode = float(0);

// Specular
material.specularIntensityNode = float(1.0);
material.specularColorNode = color(0xffffff);

// Index of Refraction
material.iorNode = float(1.5);

// Dispersion (rainbow effect in glass)
material.dispersionNode = float(0.0);
```

### Environment and Lighting

```javascript
import { cubeTexture, envMap } from 'three/tsl';

// Environment map reflection
material.envMapNode = cubeTexture(envCubeMap);

// Custom lights
material.lightsNode = lights();
```

## Vertex Manipulation

### Position Displacement

```javascript
import { positionLocal, normalLocal, texture } from 'three/tsl';

// Displace vertices along normals
const displacement = texture(heightMap).r.mul(0.1);
material.positionNode = positionLocal.add(normalLocal.mul(displacement));

// Wave displacement
const wave = positionLocal.x.add(time).sin().mul(0.1);
material.positionNode = positionLocal.add(vec3(0, wave, 0));
```

### Custom Vertex Shader

```javascript
// Complete vertex position override
material.vertexNode = customVertexPosition;
```

## Fragment Override

```javascript
// Complete fragment output override
material.fragmentNode = vec4(finalColor, 1.0);

// Output node (respects lighting)
material.outputNode = outputStruct;
```

## Geometry Attributes

### Position Nodes

```javascript
import {
  positionGeometry,  // Original mesh position
  positionLocal,     // Position in model space
  positionWorld,     // Position in world space
  positionView       // Position in camera space
} from 'three/tsl';
```

### Normal Nodes

```javascript
import {
  normalGeometry,    // Original mesh normal
  normalLocal,       // Normal in model space
  normalWorld,       // Normal in world space (use for lighting)
  normalView         // Normal in camera space
} from 'three/tsl';
```

### Tangent/Bitangent

```javascript
import {
  tangentLocal, tangentWorld, tangentView,
  bitangentLocal, bitangentWorld, bitangentView
} from 'three/tsl';
```

### UV Coordinates

```javascript
import { uv } from 'three/tsl';

uv()    // Primary UV set (UV0)
uv(1)   // Secondary UV set (UV1)
uv(2)   // Tertiary UV set (UV2)
```

### Other Attributes

```javascript
import { vertexColor, instanceIndex, vertexIndex } from 'three/tsl';

vertexColor()    // Vertex colors (if present)
instanceIndex    // Index for instanced meshes
vertexIndex      // Current vertex index
```

## Camera Nodes

```javascript
import {
  cameraPosition,         // Camera world position
  cameraNear,             // Near plane distance
  cameraFar,              // Far plane distance
  cameraViewMatrix,       // View matrix
  cameraProjectionMatrix, // Projection matrix
  cameraWorldMatrix       // Camera world matrix
} from 'three/tsl';
```

## Screen Space Nodes

```javascript
import {
  screenUV,         // Screen UV (0-1)
  screenCoordinate, // Pixel coordinates
  screenSize,       // Screen dimensions
  viewportUV,       // Viewport UV
  viewport,         // Viewport dimensions
  depth             // Fragment depth
} from 'three/tsl';
```

## Examples

### Animated Color Material

```javascript
import * as THREE from 'three/webgpu';
import { color, time, oscSine, mix } from 'three/tsl';

const material = new THREE.MeshStandardNodeMaterial();

const colorA = color(0xff0000);
const colorB = color(0x0000ff);
const t = oscSine(time.mul(0.5));

material.colorNode = mix(colorA, colorB, t);
material.roughnessNode = float(0.5);
material.metalnessNode = float(0.0);
```

### Triplanar Mapping Material

```javascript
import * as THREE from 'three/webgpu';
import { texture, triplanarTexture, float } from 'three/tsl';

const material = new THREE.MeshStandardNodeMaterial();

// Apply texture from all three axes
material.colorNode = triplanarTexture(
  texture(diffuseMap),
  null,           // Y-axis texture (optional)
  null,           // Z-axis texture (optional)
  float(0.1)      // Blend sharpness
);
```

### Glass Material

```javascript
import * as THREE from 'three/webgpu';
import { float, color } from 'three/tsl';

const material = new THREE.MeshPhysicalNodeMaterial();

material.colorNode = color(0xffffff);
material.transmissionNode = float(0.95);
material.roughnessNode = float(0.0);
material.metalnessNode = float(0.0);
material.iorNode = float(1.5);
material.thicknessNode = float(0.5);
```

### Fresnel Rim Material

```javascript
import * as THREE from 'three/webgpu';
import {
  color, float, normalWorld, positionWorld,
  cameraPosition, Fn
} from 'three/tsl';

const fresnel = Fn(() => {
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const nDotV = normalWorld.dot(viewDir).saturate();
  return float(1.0).sub(nDotV).pow(3.0);
});

const material = new THREE.MeshStandardNodeMaterial();
material.colorNode = color(0x222222);
material.emissiveNode = color(0x00ffff).mul(fresnel());
```

### Dissolve Effect Material

```javascript
import * as THREE from 'three/webgpu';
import {
  color, float, hash, positionLocal, uniform,
  If, Discard, smoothstep
} from 'three/tsl';

const threshold = uniform(0.5);

const material = new THREE.MeshStandardNodeMaterial();

const noise = hash(positionLocal.mul(50));

// Discard fragments below threshold
If(noise.lessThan(threshold), () => {
  Discard();
});

// Edge glow
const edge = smoothstep(threshold, threshold.add(0.1), noise);
material.colorNode = color(0x333333);
material.emissiveNode = color(0xff5500).mul(float(1.0).sub(edge));
```
````

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/docs/compute-shaders.md`

````{txt}
# TSL Compute Shaders

Compute shaders run on the GPU for parallel processing of data. TSL makes them accessible through JavaScript.

## CRITICAL: TSL Node Property Assignment vs JS Variable Reassignment

**TSL can intercept property assignments on nodes, but NOT JavaScript variable reassignment.**

### What Works vs What Doesn't

| Pattern | Works? | Why |
|---------|--------|-----|
| `node.y = value` | ✅ | Property setter - TSL intercepts |
| `node.x.assign(value)` | ✅ | TSL method call |
| `buffer.element(i).assign(v)` | ✅ | TSL method call |
| `variable = variable.add(1)` | ❌ | JS variable reassignment - TSL can't see it |

### This WORKS (property assignment on vec3):

```javascript
// ✅ CORRECT - Property assignment on node object
const computeShader = Fn(() => {
  const result = vec3(position);

  If(result.y.greaterThan(limit), () => {
    result.y = limit;  // TSL intercepts property setters!
  });

  return result;
})();
```

### This does NOT work (JS variable reassignment):

```javascript
// ❌ WRONG - JavaScript variable reassignment inside If()
const computeShader = Fn(() => {
  let value = buffer.element(index).toFloat();  // Scalar float - no .x/.y properties

  If(condition, () => {
    value = value.add(1.0);  // JS reassigns variable to NEW node - TSL can't track this!
  });

  buffer.element(index).assign(value);  // Uses ORIGINAL node, not the add result!
})().compute(count);
```

**Why it fails:** `value = value.add(1.0)` creates a new TSL node and reassigns the JavaScript variable to point to it. But TSL can't intercept JavaScript variable assignment - it can only intercept property setters and method calls on TSL node objects. Since `value` is a scalar float (no `.x`/`.y` properties), you can't use property assignment.

### Solution 1: Use `select()` for Conditional Values

```javascript
// ✅ CORRECT - Use select() for inline conditionals
import { select } from 'three/tsl';

const computeShader = Fn(() => {
  const currentValue = buffer.element(index).toFloat();

  // select(condition, valueIfTrue, valueIfFalse)
  const newValue = select(
    condition,
    currentValue.add(1.0),  // If true
    currentValue            // If false
  );

  buffer.element(index).assign(newValue);
})().compute(count);
```

### Solution 2: Use `.assign()` Directly on Buffer Elements Inside If()

```javascript
// ✅ CORRECT - Direct buffer assignment inside If() works
const computeShader = Fn(() => {
  const element = buffer.element(index);

  If(condition, () => {
    // Direct assignment to buffer element works!
    element.assign(element.add(1.0));
  });
})().compute(count);
```

### Solution 3: Use `.toVar()` for Mutable Variables

```javascript
// ✅ CORRECT - Use .toVar() for variables that need mutation
const computeShader = Fn(() => {
  // .toVar() creates a proper GPU variable that can be reassigned
  const value = buffer.element(index).toFloat().toVar();

  If(condition, () => {
    value.assign(value.add(1.0));  // This works with .toVar()!
  });

  buffer.element(index).assign(value);
})().compute(count);
```

### Quick Reference: When to Use What

| Pattern | Use Case |
|---------|----------|
| `select(cond, a, b)` | Simple conditional value selection |
| `element.assign()` inside `If()` | Direct buffer writes |
| `.toVar()` + `assign()` | Complex logic with multiple conditionals |
| Regular `If()` with direct assigns | Multiple buffer element updates |

### Example: Correct Stamp/Fade Pattern

```javascript
// ✅ CORRECT implementation of conditional stamping
const computeShader = Fn(() => {
  const currentFoam = foamBuffer.element(index).toFloat();

  // Calculate distance
  const dist = worldPos.distance(stampPos);
  const radius = float(50.0);

  // Calculate falloff (will be 0 outside radius due to select)
  const falloff = float(1.0).sub(dist.div(radius));

  // Use select() - returns falloff if inside radius, 0 if outside
  const foamToAdd = select(dist.lessThan(radius), falloff, float(0.0));

  // Combine and write
  const newFoam = max(currentFoam, foamToAdd);
  foamBuffer.element(index).assign(clamp(newFoam, 0.0, 1.0));
})().compute(bufferSize);
```

---

## Basic Setup

```javascript
import * as THREE from 'three/webgpu';
import { Fn, instancedArray, instanceIndex, vec3 } from 'three/tsl';

// Create storage buffer
const count = 100000;
const positions = instancedArray(count, 'vec3');

// Create compute shader
const computeShader = Fn(() => {
  const position = positions.element(instanceIndex);
  position.x.addAssign(0.01);
})().compute(count);

// Initialize renderer first, then use synchronous compute
await renderer.init();
renderer.compute(computeShader);
```

### Read-Only Storage Buffers

```javascript
import { attributeArray } from 'three/tsl';

// attributeArray() creates read-only storage buffers (vs instancedArray for read-write)
const lookupTable = attributeArray(data, 'float');

// Use in compute or materials - data is read-only on GPU
const value = lookupTable.element(index);
```

## Storage Buffers

### Instanced Arrays

```javascript
import { instancedArray } from 'three/tsl';

// Create typed storage buffers
const positions = instancedArray(count, 'vec3');
const velocities = instancedArray(count, 'vec3');
const colors = instancedArray(count, 'vec4');
const indices = instancedArray(count, 'uint');
const values = instancedArray(count, 'float');
```

### Accessing Elements

```javascript
const computeShader = Fn(() => {
  // Get element at current index
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // Read values
  const x = position.x;
  const speed = velocity.length();

  // Write values
  position.assign(vec3(0, 0, 0));
  position.x.assign(1.0);
  position.addAssign(velocity);
})().compute(count);
```

### Accessing Other Elements

```javascript
const computeShader = Fn(() => {
  const myIndex = instanceIndex;
  const neighborIndex = myIndex.add(1).mod(count);

  const myPos = positions.element(myIndex);
  const neighborPos = positions.element(neighborIndex);

  // Calculate distance to neighbor
  const dist = myPos.distance(neighborPos);
})().compute(count);
```

## Compute Shader Patterns

### Initialize Particles

```javascript
const computeInit = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // Random positions using hash
  position.x.assign(hash(instanceIndex).mul(10).sub(5));
  position.y.assign(hash(instanceIndex.add(1)).mul(10).sub(5));
  position.z.assign(hash(instanceIndex.add(2)).mul(10).sub(5));

  // Zero velocity
  velocity.assign(vec3(0));
})().compute(count);

// Run once at startup (after await renderer.init())
renderer.compute(computeInit);
```

### Physics Update

```javascript
const gravity = uniform(-9.8);
const deltaTimeUniform = uniform(0);
const groundY = uniform(0);

const computeUpdate = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);
  const dt = deltaTimeUniform;

  // Apply gravity
  velocity.y.addAssign(gravity.mul(dt));

  // Update position
  position.addAssign(velocity.mul(dt));

  // Ground collision
  If(position.y.lessThan(groundY), () => {
    position.y.assign(groundY);
    velocity.y.assign(velocity.y.negate().mul(0.8)); // Bounce
    velocity.xz.mulAssign(0.95); // Friction
  });
})().compute(count);

// In animation loop
function animate() {
  deltaTimeUniform.value = clock.getDelta();
  renderer.compute(computeUpdate);
  renderer.render(scene, camera);
}
```

### Attraction to Point

```javascript
const attractorPos = uniform(new THREE.Vector3(0, 0, 0));
const attractorStrength = uniform(1.0);

const computeAttract = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // Direction to attractor
  const toAttractor = attractorPos.sub(position);
  const distance = toAttractor.length();
  const direction = toAttractor.normalize();

  // Apply force (inverse square falloff)
  const force = direction.mul(attractorStrength).div(distance.mul(distance).add(0.1));
  velocity.addAssign(force.mul(deltaTimeUniform));
})().compute(count);
```

### Neighbor Interaction (Boids-like)

```javascript
const computeBoids = Fn(() => {
  const myPos = positions.element(instanceIndex);
  const myVel = velocities.element(instanceIndex);

  const separation = vec3(0).toVar();
  const alignment = vec3(0).toVar();
  const cohesion = vec3(0).toVar();
  const neighborCount = int(0).toVar();

  // Check nearby particles
  Loop(count, ({ i }) => {
    If(i.notEqual(instanceIndex), () => {
      const otherPos = positions.element(i);
      const otherVel = velocities.element(i);
      const dist = myPos.distance(otherPos);

      If(dist.lessThan(2.0), () => {
        // Separation
        const diff = myPos.sub(otherPos).normalize().div(dist);
        separation.addAssign(diff);

        // Alignment
        alignment.addAssign(otherVel);

        // Cohesion
        cohesion.addAssign(otherPos);

        neighborCount.addAssign(1);
      });
    });
  });

  If(neighborCount.greaterThan(0), () => {
    const n = neighborCount.toFloat();
    alignment.divAssign(n);
    cohesion.divAssign(n);
    cohesion.assign(cohesion.sub(myPos));

    myVel.addAssign(separation.mul(0.05));
    myVel.addAssign(alignment.sub(myVel).mul(0.05));
    myVel.addAssign(cohesion.mul(0.05));
  });

  // Limit speed
  const speed = myVel.length();
  If(speed.greaterThan(2.0), () => {
    myVel.assign(myVel.normalize().mul(2.0));
  });

  myPos.addAssign(myVel.mul(deltaTimeUniform));
})().compute(count);
```

## Workgroups and Synchronization

### Workgroup Size

```javascript
// Default workgroup size is typically 64 or 256
// Pass workgroup size as an array
const computeShader = Fn(() => {
  // shader code
})().compute(count, [64]);

// 2D workgroup
const compute2D = Fn(() => {
  // shader code
})().compute(width * height, [8, 8]);
```

### Compute Builtins

```javascript
import {
  globalId, localId, workgroupId, numWorkgroups, subgroupSize,
  invocationLocalIndex, invocationSubgroupIndex, subgroupIndex
} from 'three/tsl';

const computeShader = Fn(() => {
  // Global invocation ID across all workgroups
  const gid = globalId;

  // Local invocation ID within the workgroup
  const lid = localId;

  // Workgroup ID
  const wid = workgroupId;

  // Total number of workgroups
  const nwg = numWorkgroups;
})().compute(count, [64]);
```

### Barriers

```javascript
import { workgroupBarrier, storageBarrier, textureBarrier } from 'three/tsl';

const computeShader = Fn(() => {
  // Write data
  sharedData.element(localIndex).assign(value);

  // Ensure all workgroup threads reach this point
  workgroupBarrier();

  // Now safe to read data written by other threads
  const neighborValue = sharedData.element(localIndex.add(1));
})().compute(count);
```

## Atomic Operations

For thread-safe read-modify-write operations:

```javascript
import { atomicAdd, atomicSub, atomicMax, atomicMin, atomicAnd, atomicOr, atomicXor } from 'three/tsl';

const counter = instancedArray(1, 'uint');

const computeShader = Fn(() => {
  // Atomically increment counter
  atomicAdd(counter.element(0), 1);

  // Atomic max
  atomicMax(maxValue.element(0), localValue);
})().compute(count);
```

## Using Compute Results in Materials

### Instanced Mesh with Computed Positions

```javascript
// Create instanced mesh
const geometry = new THREE.SphereGeometry(0.1, 16, 16);
const material = new THREE.MeshStandardNodeMaterial();

// Use computed positions
material.positionNode = positions.element(instanceIndex);

// Optionally use computed colors
material.colorNode = colors.element(instanceIndex);

const mesh = new THREE.InstancedMesh(geometry, material, count);
scene.add(mesh);
```

### Points with Computed Positions

```javascript
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));

const material = new THREE.PointsNodeMaterial();
material.positionNode = positions.element(instanceIndex);
material.colorNode = colors.element(instanceIndex);
material.sizeNode = float(5.0);

const points = new THREE.Points(geometry, material);
scene.add(points);
```

## Execution Methods

```javascript
// IMPORTANT: Always initialize the renderer first
await renderer.init();

// Synchronous compute (preferred since r181)
renderer.compute(computeShader);

// Multiple computes
renderer.compute(computeInit);
renderer.compute(computePhysics);
renderer.compute(computeCollisions);

// Note: computeAsync() is deprecated since r181.
// Use await renderer.init() at startup, then renderer.compute() synchronously.
```

## Reading Back Data (GPU to CPU)

```javascript
// Create buffer for readback
const readBuffer = new Float32Array(count * 3);

// Read data back from GPU
await renderer.readRenderTargetPixelsAsync(
  computeTexture,
  0, 0, width, height,
  readBuffer
);
```

## Complete Example: Particle System

```javascript
import * as THREE from 'three/webgpu';
import {
  Fn, If, instancedArray, instanceIndex, uniform,
  vec3, float, hash, time
} from 'three/tsl';

// Setup
const count = 50000;
const positions = instancedArray(count, 'vec3');
const velocities = instancedArray(count, 'vec3');
const lifetimes = instancedArray(count, 'float');

// Uniforms
const emitterPos = uniform(new THREE.Vector3(0, 0, 0));
const gravity = uniform(-2.0);
const dt = uniform(0);

// Initialize
const computeInit = Fn(() => {
  const pos = positions.element(instanceIndex);
  const vel = velocities.element(instanceIndex);
  const life = lifetimes.element(instanceIndex);

  pos.assign(emitterPos);

  // Random velocity in cone
  const angle = hash(instanceIndex).mul(Math.PI * 2);
  const speed = hash(instanceIndex.add(1)).mul(2).add(1);
  vel.x.assign(angle.cos().mul(speed).mul(0.3));
  vel.y.assign(speed);
  vel.z.assign(angle.sin().mul(speed).mul(0.3));

  // Random lifetime
  life.assign(hash(instanceIndex.add(2)).mul(2).add(1));
})().compute(count);

// Update
const computeUpdate = Fn(() => {
  const pos = positions.element(instanceIndex);
  const vel = velocities.element(instanceIndex);
  const life = lifetimes.element(instanceIndex);

  // Apply gravity
  vel.y.addAssign(gravity.mul(dt));

  // Update position
  pos.addAssign(vel.mul(dt));

  // Decrease lifetime
  life.subAssign(dt);

  // Respawn dead particles
  If(life.lessThan(0), () => {
    pos.assign(emitterPos);
    const angle = hash(instanceIndex.add(time.mul(1000))).mul(Math.PI * 2);
    const speed = hash(instanceIndex.add(time.mul(1000)).add(1)).mul(2).add(1);
    vel.x.assign(angle.cos().mul(speed).mul(0.3));
    vel.y.assign(speed);
    vel.z.assign(angle.sin().mul(speed).mul(0.3));
    life.assign(hash(instanceIndex.add(time.mul(1000)).add(2)).mul(2).add(1));
  });
})().compute(count);

// Material
const material = new THREE.PointsNodeMaterial();
material.positionNode = positions.element(instanceIndex);
material.sizeNode = float(3.0);
material.colorNode = vec3(1, 0.5, 0.2);

// Geometry (dummy positions)
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));

const points = new THREE.Points(geometry, material);
scene.add(points);

// Init (after await renderer.init())
renderer.compute(computeInit);

// Animation loop
function animate() {
  dt.value = Math.min(clock.getDelta(), 0.1);
  renderer.compute(computeUpdate);
  renderer.render(scene, camera);
}
```
````

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/docs/post-processing.md`

````{txt}
# TSL Post-Processing

Post-processing applies effects to the rendered image. TSL provides both built-in effects and the ability to create custom effects.

> **Note:** `PostProcessing` was renamed to `RenderPipeline` in r183. `PostProcessing` still works as a compatibility wrapper but is deprecated.

## Basic Setup

```javascript
import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';

// Create renderer
const renderer = new THREE.WebGPURenderer();
await renderer.init();

// Create render pipeline (formerly PostProcessing, renamed in r183)
const renderPipeline = new THREE.RenderPipeline(renderer);

// Create scene pass
const scenePass = pass(scene, camera);
const scenePassColor = scenePass.getTextureNode('output');

// Output (passthrough)
renderPipeline.outputNode = scenePassColor;

// Render with post-processing
function animate() {
  renderPipeline.render();  // Not renderer.render()
}
```

## Built-in Effects

### Bloom

```javascript
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

const scenePass = pass(scene, camera);
const scenePassColor = scenePass.getTextureNode('output');

// Add bloom
const bloomPass = bloom(scenePassColor);

// Configure
bloomPass.threshold.value = 0.5;   // Brightness threshold
bloomPass.strength.value = 1.0;    // Bloom intensity
bloomPass.radius.value = 0.5;      // Blur radius

// Combine original + bloom
renderPipeline.outputNode = scenePassColor.add(bloomPass);
```

### Gaussian Blur

```javascript
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';

const blurred = gaussianBlur(scenePassColor, vec2(2.0)); // Blur strength (sigma)
renderPipeline.outputNode = blurred;
```

> **Note (r177):** Sigma values were rescaled — double previous sigma values to get the same blur strength. Also, `resolution` was renamed to `resolutionScale` (now a scalar, not a Vector2) in r180.

### FXAA (Anti-aliasing)

```javascript
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

renderPipeline.outputNode = fxaa(scenePassColor);
```

### SMAA (Anti-aliasing)

```javascript
import { smaa } from 'three/addons/tsl/display/SMAANode.js';

renderPipeline.outputNode = smaa(scenePassColor);
```

### Depth of Field

```javascript
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';

const scenePass = pass(scene, camera);
const colorNode = scenePass.getTextureNode('output');
const viewZNode = scenePass.getViewZNode();

// dof(colorNode, viewZNode, focusDistance, focalLength, bokehScale)
const dofPass = dof(colorNode, viewZNode, 5.0, 25.0, 1.0);

renderPipeline.outputNode = dofPass;
```

> **Note:** The DOF API was completely reimplemented in r181. The old `dof(color, depth, { focus, aperture, maxblur })` options-object signature no longer works.

### Motion Blur

```javascript
import { motionBlur } from 'three/addons/tsl/display/MotionBlurNode.js';

const scenePass = pass(scene, camera);
const velocityPass = scenePass.getTextureNode('velocity');

const motionBlurPass = motionBlur(scenePassColor, velocityPass);
renderPipeline.outputNode = motionBlurPass;
```

### Screen Space Reflections (SSR)

```javascript
import { ssr } from 'three/addons/tsl/display/SSRNode.js';

const scenePass = pass(scene, camera);
const colorNode = scenePass.getTextureNode('output');
const depthNode = scenePass.getTextureNode('depth');
const normalNode = scenePass.getTextureNode('normal');

const ssrPass = ssr(colorNode, depthNode, normalNode, camera);
renderPipeline.outputNode = ssrPass;
```

### Ambient Occlusion (SSAO)

```javascript
import { ao } from 'three/addons/tsl/display/AmbientOcclusionNode.js';

const scenePass = pass(scene, camera);
const depthNode = scenePass.getTextureNode('depth');
const normalNode = scenePass.getTextureNode('normal');

const aoPass = ao(depthNode, normalNode, camera);
renderPipeline.outputNode = scenePassColor.mul(aoPass);
```

### Film Grain

```javascript
import { film } from 'three/addons/tsl/display/FilmNode.js';

const filmPass = film(scenePassColor, {
  intensity: 0.5,
  grayscale: false
});
renderPipeline.outputNode = filmPass;
```

### Outline

```javascript
import { outline } from 'three/addons/tsl/display/OutlineNode.js';

const outlinePass = outline(scene, camera, selectedObjects, {
  edgeStrength: 3.0,
  edgeGlow: 0.0,
  edgeThickness: 1.0,
  visibleEdgeColor: new THREE.Color(0xffffff),
  hiddenEdgeColor: new THREE.Color(0x190a05)
});

renderPipeline.outputNode = scenePassColor.add(outlinePass);
```

### Chromatic Aberration

```javascript
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';

const caPass = chromaticAberration(scenePassColor, {
  offset: vec2(0.002, 0.002)
});
renderPipeline.outputNode = caPass;
```

## Color Adjustments

### Grayscale

```javascript
import { grayscale } from 'three/tsl';

renderPipeline.outputNode = grayscale(scenePassColor);
```

### Saturation

```javascript
import { saturation } from 'three/tsl';

// 0 = grayscale, 1 = normal, 2 = oversaturated
renderPipeline.outputNode = saturation(scenePassColor, 1.5);
```

### Hue Shift

```javascript
import { hue } from 'three/tsl';

// Shift hue by radians
renderPipeline.outputNode = hue(scenePassColor, time.mul(0.5));
```

### Vibrance

```javascript
import { vibrance } from 'three/tsl';

renderPipeline.outputNode = vibrance(scenePassColor, 0.5);
```

### Posterize

```javascript
import { posterize } from 'three/tsl';

// Reduce color levels
renderPipeline.outputNode = posterize(scenePassColor, 8);
```

### Sepia

```javascript
import { sepia } from 'three/addons/tsl/display/SepiaNode.js';

renderPipeline.outputNode = sepia(scenePassColor);
```

### 3D LUT

```javascript
import { lut3D } from 'three/addons/tsl/display/Lut3DNode.js';

const lutTexture = new THREE.Data3DTexture(lutData, size, size, size);
renderPipeline.outputNode = lut3D(scenePassColor, lutTexture, size);
```

## Custom Post-Processing

### Basic Custom Effect

```javascript
import { Fn, screenUV, float, vec4 } from 'three/tsl';

const customEffect = Fn(() => {
  const color = scenePassColor.toVar();

  // Invert colors
  color.rgb.assign(float(1.0).sub(color.rgb));

  return color;
});

renderPipeline.outputNode = customEffect();
```

### Vignette Effect

```javascript
const vignette = Fn(() => {
  const color = scenePassColor.toVar();

  // Distance from center
  const uv = screenUV;
  const dist = uv.sub(0.5).length();

  // Vignette falloff
  const vignette = float(1.0).sub(dist.mul(1.5)).clamp(0, 1);

  color.rgb.mulAssign(vignette);
  return color;
});

renderPipeline.outputNode = vignette();
```

### CRT/Scanline Effect

```javascript
import { viewportSharedTexture } from 'three/tsl';

const crtEffect = Fn(() => {
  const uv = screenUV;

  // Sample scene at offset UVs for RGB separation (chromatic aberration)
  const uvR = uv.add(vec2(0.002, 0));
  const uvG = uv;
  const uvB = uv.sub(vec2(0.002, 0));

  // Use viewportSharedTexture to sample at different UV coordinates
  const r = viewportSharedTexture(uvR).r;
  const g = viewportSharedTexture(uvG).g;
  const b = viewportSharedTexture(uvB).b;

  const color = vec4(r, g, b, 1.0).toVar();

  // Scanlines
  const scanline = uv.y.mul(screenSize.y).mul(0.5).sin().mul(0.1).add(0.9);
  color.rgb.mulAssign(scanline);

  // Vignette
  const dist = uv.sub(0.5).length();
  color.rgb.mulAssign(float(1.0).sub(dist.mul(0.5)));

  return color;
});

// Note: For this effect, apply after scene rendering
renderPipeline.outputNode = crtEffect();
```

### Pixelate Effect

```javascript
const pixelSize = uniform(8.0);

const pixelate = Fn(() => {
  const uv = screenUV;
  const pixelUV = uv.mul(screenSize).div(pixelSize).floor().mul(pixelSize).div(screenSize);
  return texture(scenePassColor, pixelUV);
});

renderPipeline.outputNode = pixelate();
```

### Edge Detection (Sobel)

```javascript
const sobelEdge = Fn(() => {
  const uv = screenUV;
  const texelSize = vec2(1.0).div(screenSize);

  // Sample 3x3 kernel
  const tl = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(-1, -1)))));
  const tc = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(0, -1)))));
  const tr = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(1, -1)))));
  const ml = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(-1, 0)))));
  const mr = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(1, 0)))));
  const bl = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(-1, 1)))));
  const bc = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(0, 1)))));
  const br = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(1, 1)))));

  // Sobel operators
  const gx = tl.add(ml.mul(2)).add(bl).sub(tr).sub(mr.mul(2)).sub(br);
  const gy = tl.add(tc.mul(2)).add(tr).sub(bl).sub(bc.mul(2)).sub(br);

  const edge = sqrt(gx.mul(gx).add(gy.mul(gy)));

  return vec4(vec3(edge), 1.0);
});

renderPipeline.outputNode = sobelEdge();
```

## Multiple Render Targets (MRT)

Access multiple buffers from the scene pass:

```javascript
import { mrt, output } from 'three/tsl';

const scenePass = pass(scene, camera);

// Set up MRT
scenePass.setMRT(mrt({
  output: output,           // Color output
  normal: normalView,       // View-space normals
  depth: depth              // Depth buffer
}));

// Access individual targets
const colorTexture = scenePass.getTextureNode('output');
const normalTexture = scenePass.getTextureNode('normal');
const depthTexture = scenePass.getTextureNode('depth');
```

### Selective Bloom with MRT

Bloom only emissive objects by rendering emissive to a separate target:

```javascript
import { pass, mrt, output, emissive } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

const renderPipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);

// Render both color and emissive to separate targets
scenePass.setMRT(mrt({
  output: output,
  emissive: emissive
}));

// Get the texture nodes
const colorTexture = scenePass.getTextureNode('output');
const emissiveTexture = scenePass.getTextureNode('emissive');

// Apply bloom only to emissive
const bloomPass = bloom(emissiveTexture);
bloomPass.threshold.value = 0.0;  // Bloom all emissive
bloomPass.strength.value = 1.5;
bloomPass.radius.value = 0.5;

// Combine: original color + bloomed emissive
renderPipeline.outputNode = colorTexture.add(bloomPass);
```

This approach prevents non-emissive bright areas (like white surfaces) from blooming.

## Chaining Effects

```javascript
const scenePass = pass(scene, camera);
const color = scenePass.getTextureNode('output');

// Chain multiple effects
let output = color;

// 1. Apply bloom
const bloomPass = bloom(output);
output = output.add(bloomPass.mul(0.5));

// 2. Apply color grading
output = saturation(output, 1.2);

// 3. Apply vignette
const dist = screenUV.sub(0.5).length();
const vignette = float(1.0).sub(dist.mul(0.5));
output = output.mul(vignette);

// 4. Apply FXAA
output = fxaa(output);

renderPipeline.outputNode = output;
```

## Conditional Effects

```javascript
const effectEnabled = uniform(true);

const conditionalEffect = Fn(() => {
  const color = scenePassColor;
  return select(effectEnabled, grayscale(color), color);
});

renderPipeline.outputNode = conditionalEffect();

// Toggle at runtime
effectEnabled.value = false;
```

## Transitions

```javascript
import { transition } from 'three/addons/tsl/display/TransitionNode.js';

const scenePassA = pass(sceneA, camera);
const scenePassB = pass(sceneB, camera);

const transitionProgress = uniform(0);

const transitionPass = transition(
  scenePassA.getTextureNode('output'),
  scenePassB.getTextureNode('output'),
  transitionProgress,
  texture(transitionTexture)  // Optional transition texture
);

renderPipeline.outputNode = transitionPass;

// Animate transition
function animate() {
  transitionProgress.value = Math.sin(time) * 0.5 + 0.5;
  renderPipeline.render();
}
```

## Additional Effects (r182+)

These effects were added in recent Three.js releases:

```javascript
// Volumetric god rays (r183)
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
const godraysPass = godrays(scenePassColor, depthNode, camera, lightPosition);

// Retro/CRT effect (r183)
import { retroPass } from 'three/addons/tsl/display/RetroNode.js';

// Anamorphic lens flare
import { anamorphic } from 'three/addons/tsl/display/AnamorphicNode.js';
const anamorphicPass = anamorphic(scenePassColor);

// Lens flare
import { lensflare } from 'three/addons/tsl/display/LensflareNode.js';

// Denoising
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';

// Screen-space global illumination
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';

// Temporal anti-aliasing (replaces FXAA/SMAA for better quality)
import { traa } from 'three/addons/tsl/display/TRAANode.js';

// Alternative blur modes
import { boxBlur } from 'three/addons/tsl/display/BoxBlurNode.js';       // Mobile-friendly
import { hashBlur } from 'three/addons/tsl/display/HashBlurNode.js';     // Single-pass
import { bilateralBlur } from 'three/addons/tsl/display/BilateralBlurNode.js'; // Edge-preserving

// 3D texture sampling (r182)
import { texture3DLoad, texture3DLevel } from 'three/tsl';
```
````

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/docs/wgsl-integration.md`

````{txt}
# WGSL Integration

TSL allows embedding raw WGSL (WebGPU Shading Language) code when you need direct GPU control.

## wgslFn - Custom WGSL Functions

### Basic Usage

```javascript
import { wgslFn, float, vec3 } from 'three/tsl';

// Define WGSL function
const gammaCorrect = wgslFn(`
  fn gammaCorrect(color: vec3<f32>, gamma: f32) -> vec3<f32> {
    return pow(color, vec3<f32>(1.0 / gamma));
  }
`);

// Use in TSL
material.colorNode = gammaCorrect(inputColor, float(2.2));
```

### Function with Multiple Parameters

```javascript
const blendColors = wgslFn(`
  fn blendColors(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> {
    return mix(a, b, t);
  }
`);

material.colorNode = blendColors(colorA, colorB, blendFactor);
```

### Advanced Math Functions

```javascript
const fresnelSchlick = wgslFn(`
  fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - cosTheta, 5.0);
  }
`);

const GGX = wgslFn(`
  fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;

    let num = a2;
    let denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = 3.14159265359 * denom * denom;

    return num / denom;
  }
`);
```

### Noise Functions

```javascript
const simplexNoise = wgslFn(`
  fn mod289(x: vec3<f32>) -> vec3<f32> {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
  }

  fn permute(x: vec3<f32>) -> vec3<f32> {
    return mod289(((x * 34.0) + 1.0) * x);
  }

  fn snoise(v: vec2<f32>) -> f32 {
    let C = vec4<f32>(
      0.211324865405187,
      0.366025403784439,
      -0.577350269189626,
      0.024390243902439
    );

    var i = floor(v + dot(v, C.yy));
    let x0 = v - i + dot(i, C.xx);

    var i1: vec2<f32>;
    if (x0.x > x0.y) {
      i1 = vec2<f32>(1.0, 0.0);
    } else {
      i1 = vec2<f32>(0.0, 1.0);
    }

    var x12 = x0.xyxy + C.xxzz;
    x12 = vec4<f32>(x12.xy - i1, x12.zw);

    i = mod289(vec3<f32>(i, 0.0)).xy;
    let p = permute(permute(i.y + vec3<f32>(0.0, i1.y, 1.0)) + i.x + vec3<f32>(0.0, i1.x, 1.0));

    var m = max(vec3<f32>(0.5) - vec3<f32>(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3<f32>(0.0));
    m = m * m;
    m = m * m;

    let x = 2.0 * fract(p * C.www) - 1.0;
    let h = abs(x) - 0.5;
    let ox = floor(x + 0.5);
    let a0 = x - ox;

    m = m * (1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h));

    let g = vec3<f32>(
      a0.x * x0.x + h.x * x0.y,
      a0.y * x12.x + h.y * x12.y,
      a0.z * x12.z + h.z * x12.w
    );

    return 130.0 * dot(m, g);
  }
`);

// Use noise
const noiseValue = simplexNoise(uv().mul(10.0));
```

### FBM (Fractal Brownian Motion)

```javascript
const fbm = wgslFn(`
  fn fbm(p: vec2<f32>, octaves: i32) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var frequency = 1.0;
    var pos = p;

    for (var i = 0; i < octaves; i = i + 1) {
      value = value + amplitude * snoise(pos * frequency);
      amplitude = amplitude * 0.5;
      frequency = frequency * 2.0;
    }

    return value;
  }
`);
```

## WGSL Types Reference

### Scalar Types
```wgsl
bool        // Boolean
i32         // 32-bit signed integer
u32         // 32-bit unsigned integer
f32         // 32-bit float
f16         // 16-bit float (if enabled)
```

### Vector Types
```wgsl
vec2<f32>   // 2D float vector
vec3<f32>   // 3D float vector
vec4<f32>   // 4D float vector
vec2<i32>   // 2D integer vector
vec2<u32>   // 2D unsigned integer vector
```

### Matrix Types
```wgsl
mat2x2<f32> // 2x2 matrix
mat3x3<f32> // 3x3 matrix
mat4x4<f32> // 4x4 matrix
mat2x3<f32> // 2 columns, 3 rows
```

### Texture Types
```wgsl
texture_2d<f32>
texture_3d<f32>
texture_cube<f32>
texture_storage_2d<rgba8unorm, write>
```

## WGSL Syntax Reference

### Variables
```wgsl
let x = 1.0;              // Immutable
var y = 2.0;              // Mutable
const PI = 3.14159;       // Compile-time constant
```

### Control Flow
```wgsl
// If-else
if (condition) {
  // ...
} else if (other) {
  // ...
} else {
  // ...
}

// For loop
for (var i = 0; i < 10; i = i + 1) {
  // ...
}

// While loop
while (condition) {
  // ...
}

// Switch
switch (value) {
  case 0: { /* ... */ }
  case 1, 2: { /* ... */ }
  default: { /* ... */ }
}
```

### Built-in Functions
```wgsl
// Math
abs(x), sign(x), floor(x), ceil(x), round(x)
fract(x), trunc(x)
min(a, b), max(a, b), clamp(x, lo, hi)
mix(a, b, t), step(edge, x), smoothstep(lo, hi, x)
sin(x), cos(x), tan(x), asin(x), acos(x), atan(x), atan2(y, x)
pow(x, y), exp(x), log(x), exp2(x), log2(x)
sqrt(x), inverseSqrt(x)

// Vector
length(v), distance(a, b)
dot(a, b), cross(a, b)
normalize(v), faceForward(n, i, nref)
reflect(i, n), refract(i, n, eta)

// Matrix
transpose(m), determinant(m)

// Texture
textureSample(t, s, coord)
textureLoad(t, coord, level)
textureStore(t, coord, value)
textureDimensions(t)
```

## Combining TSL and WGSL

### TSL Wrapper for WGSL

```javascript
import { Fn, wgslFn, float, vec2, vec3 } from 'three/tsl';

// WGSL implementation
const wgslNoise = wgslFn(`
  fn noise2d(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
  }
`);

// TSL wrapper with nice API
const noise = Fn(([position, scale = 1.0]) => {
  return wgslNoise(position.xy.mul(scale));
});

// Use
material.colorNode = vec3(noise(positionWorld, 10.0));
```

### Hybrid Approach

```javascript
// Complex math in WGSL
const complexMath = wgslFn(`
  fn complexOperation(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> {
    let blended = mix(a, b, t);
    let rotated = vec3<f32>(
      blended.x * cos(t) - blended.y * sin(t),
      blended.x * sin(t) + blended.y * cos(t),
      blended.z
    );
    return normalize(rotated);
  }
`);

// Simple logic in TSL
const finalColor = Fn(() => {
  const base = texture(diffuseMap).rgb;
  const processed = complexMath(base, vec3(1, 0, 0), time);
  return mix(base, processed, oscSine(time));
});

material.colorNode = finalColor();
```

## Performance Tips

### Avoid Branching When Possible
```wgsl
// Instead of:
if (x > 0.5) {
  result = a;
} else {
  result = b;
}

// Use:
result = mix(b, a, step(0.5, x));
```

### Use Local Variables
```wgsl
fn compute(p: vec2<f32>) -> f32 {
  // Cache repeated calculations
  let p2 = p * p;
  let p4 = p2 * p2;
  return p2.x + p2.y + p4.x * p4.y;
}
```

### Minimize Texture Samples
```wgsl
// Sample once, use multiple times
let sample = textureSample(tex, sampler, uv);
let r = sample.r;
let g = sample.g;
let b = sample.b;
```
````

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/docs/device-loss.md`

````{txt}
# WebGPU Device Loss Handling

## What Is Device Loss?

Device loss occurs when the GPU driver cannot continue processing commands. Causes include:

- Driver crashes
- Extreme resource pressure
- Long-running shaders (GPU watchdog triggers after ~10 seconds)
- Driver updates
- Significant device configuration changes

When a device is lost, the `GPUDevice` object and **all objects created with it become unusable**. All buffers, textures, pipelines, and GPU memory are discarded.

## Listening for Device Loss

Detect loss by attaching a callback to the device's `lost` promise:

```javascript
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) { return; }
const device = await adapter.requestDevice();

device.lost.then((info) => {
  console.error('WebGPU device lost:', info.message);
  // Handle recovery
});
```

**Important:** Don't `await` this promise directly - it will block indefinitely if loss never occurs.

### Device Loss Information

The `GPUDeviceLostInfo` object provides:

| Property | Description |
|----------|-------------|
| `reason` | `'destroyed'` (intentional via `destroy()`) or `'unknown'` (unexpected) |
| `message` | Human-readable debugging info (don't parse programmatically) |

```javascript
device.lost.then((info) => {
  if (info.reason === 'unknown') {
    // Unexpected loss - attempt recovery
    handleUnexpectedDeviceLoss();
  } else {
    // Intentional destruction - expected behavior
  }
});
```

### Devices Starting Lost

`adapter.requestDevice()` always returns a `GPUDevice`, but it may already be lost if creation failed. This occurs when the adapter was "consumed" (used previously) or "expired."

**Best practice:** Always get a new adapter right before requesting a device.

## Recovery Strategies

### Minimal Recovery (Page Reload)

For simple applications:

```javascript
device.lost.then((info) => {
  if (info.reason === 'unknown') {
    // Warn user before reload
    alert('Graphics error occurred. The page will reload.');
    location.reload();
  }
});
```

### Restart GPU Content Only (Recommended for Three.js)

Recreate the device and reconfigure the canvas without full page reload:

```javascript
import * as THREE from 'three/webgpu';

let renderer;
let scene, camera;

async function initWebGPU() {
  renderer = new THREE.WebGPURenderer();
  await renderer.init();

  // Access the underlying WebGPU device
  const device = renderer.backend.device;

  device.lost.then((info) => {
    console.error('Device lost:', info.message);
    if (info.reason === 'unknown') {
      // Dispose current renderer
      renderer.dispose();
      // Reinitialize
      initWebGPU();
    }
  });

  // Configure canvas
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // Recreate scene content
  setupScene();
}

function setupScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  // ... add meshes, lights, etc.
}

initWebGPU();
```

### Restore with Application State

For applications with user progress or configuration:

```javascript
let appState = {
  cameraPosition: { x: 0, y: 5, z: 10 },
  settings: {},
  // Don't save transient data like particle positions
};

// Save state periodically
function saveState() {
  appState.cameraPosition = {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z
  };
  localStorage.setItem('appState', JSON.stringify(appState));
}

// Restore on recovery
async function initWebGPU() {
  renderer = new THREE.WebGPURenderer();
  await renderer.init();

  const savedState = localStorage.getItem('appState');
  if (savedState) {
    appState = JSON.parse(savedState);
  }

  setupScene();

  // Restore camera position
  camera.position.set(
    appState.cameraPosition.x,
    appState.cameraPosition.y,
    appState.cameraPosition.z
  );

  renderer.backend.device.lost.then((info) => {
    if (info.reason === 'unknown') {
      saveState();
      renderer.dispose();
      initWebGPU();
    }
  });
}
```

## When Recovery Fails

If `requestAdapter()` returns `null` after device loss, the OS or browser has blocked GPU access:

```javascript
async function initWebGPU() {
  const adapter = await navigator.gpu.requestAdapter();

  if (!adapter) {
    // Check if this is initial failure or post-loss failure
    if (hadPreviousDevice) {
      showMessage('GPU access lost. Please restart your browser.');
    } else {
      showMessage('WebGPU is not supported on this device.');
    }
    return;
  }

  // Continue with device creation...
}
```

## Testing Device Loss

### Using destroy()

Call `device.destroy()` to simulate loss:

```javascript
let simulatedLoss = false;

function simulateDeviceLoss() {
  simulatedLoss = true;
  renderer.backend.device.destroy();
}

// In your device.lost handler:
device.lost.then((info) => {
  if (info.reason === 'unknown' || simulatedLoss) {
    simulatedLoss = false;
    // Treat as unexpected loss for testing
    handleDeviceLoss();
  }
});

// Add debug keybinding
window.addEventListener('keydown', (e) => {
  if (e.key === 'L' && e.ctrlKey && e.shiftKey) {
    simulateDeviceLoss();
  }
});
```

**Limitations of destroy():**
- Unmaps buffers immediately (real loss doesn't)
- Always allows device recovery (real loss may not)

### Chrome GPU Process Crash Testing

Navigate to `about:gpucrash` in a **separate tab** to crash the GPU process.

Chrome enforces escalating restrictions:

| Crash | Effect |
|-------|--------|
| 1st | New adapters allowed |
| 2nd within 2 min | Adapter requests fail (resets on page refresh) |
| 3rd within 2 min | All pages blocked (reset after 2 min or browser restart) |
| 3-6 within 5 min | GPU process stops restarting; browser restart required |

### Chrome Testing Flags

Bypass crash limits for development:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --disable-domain-blocking-for-3d-apis \
  --disable-gpu-process-crash-limit

# Windows
chrome.exe --disable-domain-blocking-for-3d-apis --disable-gpu-process-crash-limit

# Linux
google-chrome --disable-domain-blocking-for-3d-apis --disable-gpu-process-crash-limit
```

## Complete Example

```javascript
import * as THREE from 'three/webgpu';
import { color, time, oscSine } from 'three/tsl';

let renderer, scene, camera, mesh;
let hadPreviousDevice = false;

async function init() {
  // Check WebGPU support
  if (!navigator.gpu) {
    showError('WebGPU not supported');
    return;
  }

  // Create renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });

  try {
    await renderer.init();
  } catch (e) {
    if (hadPreviousDevice) {
      showError('GPU recovery failed. Please restart browser.');
    } else {
      showError('Failed to initialize WebGPU.');
    }
    return;
  }

  hadPreviousDevice = true;

  // Setup device loss handler
  const device = renderer.backend.device;
  device.lost.then(handleDeviceLoss);

  // Setup scene
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 5;

  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = color(0x00ff00).mul(oscSine(time));

  mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(5, 5, 5);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0x404040));

  animate();
}

function handleDeviceLoss(info) {
  console.error('Device lost:', info.reason, info.message);

  if (info.reason === 'unknown') {
    // Cleanup
    if (renderer) {
      renderer.domElement.remove();
      renderer.dispose();
    }

    // Attempt recovery after short delay
    setTimeout(() => {
      init();
    }, 100);
  }
}

function animate() {
  if (!renderer) return;

  requestAnimationFrame(animate);
  mesh.rotation.x += 0.01;
  mesh.rotation.y += 0.01;
  renderer.render(scene, camera);
}

function showError(message) {
  const div = document.createElement('div');
  div.textContent = message;
  div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:20px;background:#f44;color:#fff;border-radius:8px;';
  document.body.appendChild(div);
}

init();
```

## Best Practices

1. **Always listen for device loss** - Even if you just show an error message
2. **Get a fresh adapter before each device request** - The GPU hardware may have changed
3. **Don't parse the message field** - It's implementation-specific and changes between browsers
4. **Save critical application state** - Restore user progress after recovery
5. **Don't save transient state** - Particle positions, physics state can be reset
6. **Test your recovery path** - Use `destroy()` and Chrome's `about:gpucrash`
7. **Handle adapter failure gracefully** - Distinguish between initial failure and post-loss failure
8. **Add a short delay before recovery** - Give the system time to stabilize
````

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/docs/limits-and-features.md`

````{txt}
# WebGPU Limits and Features

## Why This Matters

WebGPU devices have **default limits** (guaranteed minimums) that may be lower than what your application needs. For example, the default `maxBufferSize` is 256 MiB — if you create a large compute buffer, you'll silently get errors unless you request a higher limit. Similarly, optional **features** like `float32-filterable` must be explicitly enabled.

## Limits

Limits define numeric constraints on resources. Every WebGPU implementation guarantees a set of minimum values, but most GPUs support much higher limits.

Common limits you may need to increase:

| Limit | Default | When to Increase |
|-------|---------|------------------|
| `maxBufferSize` | 268435456 (256 MiB) | Large storage/vertex buffers |
| `maxStorageBufferBindingSize` | 134217728 (128 MiB) | Large compute storage buffers |
| `maxStorageBuffersPerShaderStage` | 8 | Many storage buffers in one shader |
| `maxComputeWorkgroupSizeX` | 128 | Large workgroup dimensions |
| `maxComputeInvocationsPerWorkgroup` | 128 | Dense compute workgroups |
| `maxColorAttachments` | 8 | Many render targets |

### Querying Adapter Limits

```javascript
const adapter = await navigator.gpu?.requestAdapter();
console.log(adapter.limits.maxBufferSize);
console.log(adapter.limits.maxStorageBufferBindingSize);
```

### Requesting Increased Limits

You must request higher limits when creating the device — otherwise you get the defaults, not the adapter's maximums.

**Raw WebGPU:**
```javascript
const adapter = await navigator.gpu?.requestAdapter();
const device = await adapter.requestDevice({
  requiredLimits: {
    maxBufferSize: 1024 * 1024 * 1024,            // 1 GiB
    maxStorageBufferBindingSize: 1024 * 1024 * 512, // 512 MiB
  },
});
```

**Three.js WebGPURenderer:**

Three.js accepts `requiredLimits` as a renderer constructor option, which gets passed through to `requestDevice()`:

```javascript
const renderer = new THREE.WebGPURenderer({
  requiredLimits: {
    maxBufferSize: 1024 * 1024 * 1024,            // 1 GiB
    maxStorageBufferBindingSize: 1024 * 1024 * 512, // 512 MiB
  },
});
await renderer.init();
```

If the adapter doesn't support the requested limit, `requestDevice()` (or `renderer.init()`) will fail.

### Safe Pattern: Check Before Requesting

```javascript
const adapter = await navigator.gpu?.requestAdapter();

const desiredBufferSize = 1024 * 1024 * 1024; // 1 GiB
const requiredLimits = {};

if (adapter.limits.maxBufferSize >= desiredBufferSize) {
  requiredLimits.maxBufferSize = desiredBufferSize;
} else {
  console.warn('Adapter does not support 1 GiB buffers, using default');
}

const renderer = new THREE.WebGPURenderer({ requiredLimits });
await renderer.init();
```

## Features

Features are optional capabilities that vary by GPU. Unlike limits, features are either present or absent — there's no numeric value to adjust.

### How Three.js Handles Features

Three.js automatically requests **all features supported by the adapter**. You generally don't need to manage features manually when using Three.js.

### Querying Available Features (Raw WebGPU)

```javascript
const adapter = await navigator.gpu?.requestAdapter();
// adapter.features is a Set
console.log(adapter.features.has('float32-filterable'));
console.log(adapter.features.has('shader-f16'));
```

### Common Optional Features

| Feature | Purpose |
|---------|---------|
| `float32-filterable` | Linear filtering on float32 textures |
| `float32-blendable` | Blending on float32 render targets |
| `shader-f16` | 16-bit floats in shaders |
| `texture-compression-bc` | BC (desktop) texture compression |
| `texture-compression-etc2` | ETC2 (mobile) texture compression |
| `texture-compression-astc` | ASTC (mobile) texture compression |
| `timestamp-query` | GPU timing measurements |
| `depth-clip-control` | Disable depth clipping |
| `dual-source-blending` | Two blend sources from one shader |
| `subgroups` | Subgroup operations in compute |
| `clip-distances` | Custom clip planes in vertex shader |

## Best Practices

1. **Only request limits you actually need** — requesting maximums hides portability issues where your app works on your GPU but fails on weaker ones
2. **Check adapter limits before requesting** — gracefully degrade when limits aren't available
3. **Don't forget storage buffer binding size** — `maxStorageBufferBindingSize` is often the bottleneck, not `maxBufferSize`
4. **Use [webgpureport.org](https://webgpureport.org)** to check what limits/features different GPUs support

## Debugging

If you're hitting buffer size errors or validation failures:

```javascript
// Log all adapter limits
const adapter = await navigator.gpu?.requestAdapter();
for (const [key, value] of Object.entries(Object.getPrototypeOf(adapter.limits))) {
  if (typeof value !== 'function') {
    console.log(`${key}: ${adapter.limits[key]}`);
  }
}
```

Check Chrome DevTools console for WebGPU validation errors — they often mention which limit was exceeded.
````

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/examples/basic-setup.js`

```{txt}
/**
 * Basic WebGPU Three.js Setup
 *
 * Minimal example showing WebGPU renderer initialization
 * with a simple animated mesh using TSL.
 *
 * Based on Three.js examples (MIT License)
 * https://github.com/mrdoob/three.js
 */

import * as THREE from 'three/webgpu';
import { color, time, oscSine, positionLocal, normalWorld } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;

async function init() {
  // Camera
  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.z = 4;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0x404040);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(5, 5, 5);
  scene.add(directionalLight);

  // Create mesh with TSL material
  const geometry = new THREE.TorusKnotGeometry(1, 0.3, 128, 32);
  const material = new THREE.MeshStandardNodeMaterial();

  // Animated color using TSL
  material.colorNode = color(0x0088ff).mul(
    oscSine(time.mul(0.5)).mul(0.5).add(0.5)
  );

  // Add slight position wobble
  material.positionNode = positionLocal.add(
    normalWorld.mul(oscSine(time.mul(2.0).add(positionLocal.y)).mul(0.05))
  );

  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);

  // Initialize WebGPU
  await renderer.init();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Handle resize
  window.addEventListener('resize', onWindowResize);

  // Start animation loop
  renderer.setAnimationLoop(animate);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  controls.update();
  renderer.render(scene, camera);
}

init();
```

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/examples/custom-material.js`

```{txt}
/**
 * Custom TSL Material Example
 *
 * Demonstrates creating custom shader effects using TSL:
 * - Fresnel rim lighting
 * - Animated patterns
 * - Dynamic displacement
 *
 * Based on Three.js examples (MIT License)
 * https://github.com/mrdoob/three.js
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  color,
  float,
  vec2,
  vec3,
  uniform,
  texture,
  uv,
  time,
  mix,
  smoothstep,
  sin,
  cos,
  positionLocal,
  positionWorld,
  normalLocal,
  normalWorld,
  cameraPosition
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;
let rimColor, patternScale, displacementStrength;

async function init() {
  // Setup
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.z = 3;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // Uniforms for runtime control
  rimColor = uniform(new THREE.Color(0x00ffff));
  patternScale = uniform(5.0);
  displacementStrength = uniform(0.1);

  // Create custom material
  const material = createCustomMaterial();

  // Mesh
  const geometry = new THREE.IcosahedronGeometry(1, 64);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Events
  window.addEventListener('resize', onWindowResize);

  // GUI (optional - requires lil-gui)
  setupGUI();

  renderer.setAnimationLoop(animate);
}

function createCustomMaterial() {
  const material = new THREE.MeshStandardNodeMaterial();

  // --- Fresnel Rim Effect ---
  const fresnel = Fn(() => {
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    const nDotV = normalWorld.dot(viewDir).saturate();
    return float(1.0).sub(nDotV).pow(3.0);
  });

  // --- Animated Pattern ---
  const animatedPattern = Fn(() => {
    const uvCoord = uv().mul(patternScale);
    const t = time.mul(0.5);

    // Create animated wave pattern
    const wave1 = sin(uvCoord.x.mul(10.0).add(t)).mul(0.5).add(0.5);
    const wave2 = sin(uvCoord.y.mul(10.0).sub(t.mul(1.3))).mul(0.5).add(0.5);
    const wave3 = sin(uvCoord.x.add(uvCoord.y).mul(7.0).add(t.mul(0.7))).mul(0.5).add(0.5);

    return wave1.mul(wave2).mul(wave3);
  });

  // --- Displacement ---
  const displacement = Fn(() => {
    const pattern = animatedPattern();
    return normalLocal.mul(pattern.mul(displacementStrength));
  });

  // Apply displacement
  material.positionNode = positionLocal.add(displacement());

  // --- Color ---
  const baseColor = color(0x222244);
  const highlightColor = color(0x4444ff);

  // Mix colors based on pattern
  const pattern = animatedPattern();
  const surfaceColor = mix(baseColor, highlightColor, pattern);

  material.colorNode = surfaceColor;

  // --- Rim lighting ---
  material.emissiveNode = rimColor.mul(fresnel());

  // --- PBR properties ---
  material.roughnessNode = float(0.3).add(pattern.mul(0.4));
  material.metalnessNode = float(0.1);

  return material;
}

function setupGUI() {
  // Only setup if lil-gui is available
  if (typeof window.GUI === 'undefined') {
    console.log('Add lil-gui for interactive controls');
    return;
  }

  const gui = new GUI();
  const params = {
    rimColor: '#00ffff',
    patternScale: 5.0,
    displacementStrength: 0.1
  };

  gui.addColor(params, 'rimColor').onChange((value) => {
    rimColor.value.set(value);
  });

  gui.add(params, 'patternScale', 1, 20).onChange((value) => {
    patternScale.value = value;
  });

  gui.add(params, 'displacementStrength', 0, 0.5).onChange((value) => {
    displacementStrength.value = value;
  });
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  controls.update();
  renderer.render(scene, camera);
}

init();
```

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/examples/earth-shader.js`

```{txt}
/**
 * Earth Shader Example
 *
 * Complete procedural Earth with:
 * - Day/night texture blending
 * - Atmospheric glow (fresnel)
 * - Cloud layer
 * - City lights at night
 * - Bump mapping
 *
 * Based on Three.js webgpu_tsl_earth example (MIT License)
 * https://github.com/mrdoob/three.js
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  vec2,
  vec3,
  vec4,
  color,
  uniform,
  texture,
  uv,
  time,
  mix,
  smoothstep,
  pow,
  clamp,
  normalize,
  dot,
  max,
  positionWorld,
  normalWorld,
  normalLocal,
  cameraPosition,
  bumpMap
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;
let earth, clouds, atmosphere;

// Uniforms
const sunDirection = uniform(new THREE.Vector3(1, 0.2, 0.5).normalize());
const atmosphereDayColor = uniform(new THREE.Color(0x4db2ff));
const atmosphereTwilightColor = uniform(new THREE.Color(0xbd5f1b));
const cloudSpeed = uniform(0.01);
const cityLightIntensity = uniform(1.5);

async function init() {
  // Camera
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 4);

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000011);

  // Load textures
  const loader = new THREE.TextureLoader();

  // Note: Replace with actual texture paths
  const earthDayTexture = loader.load('textures/earth_day.jpg');
  const earthNightTexture = loader.load('textures/earth_night.jpg');
  const earthCloudsTexture = loader.load('textures/earth_clouds.jpg');
  const earthBumpTexture = loader.load('textures/earth_bump.jpg');

  // Set texture properties
  [earthDayTexture, earthNightTexture, earthCloudsTexture, earthBumpTexture].forEach((tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  });

  // Create Earth
  earth = createEarth(earthDayTexture, earthNightTexture, earthBumpTexture);
  scene.add(earth);

  // Create cloud layer
  clouds = createClouds(earthCloudsTexture);
  scene.add(clouds);

  // Create atmosphere glow
  atmosphere = createAtmosphere();
  scene.add(atmosphere);

  // Stars background
  createStars();

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 2;
  controls.maxDistance = 10;

  // Events
  window.addEventListener('resize', onWindowResize);

  renderer.setAnimationLoop(animate);
}

function createEarth(dayTex, nightTex, bumpTex) {
  const geometry = new THREE.SphereGeometry(1, 64, 64);
  const material = new THREE.MeshStandardNodeMaterial();

  // Sun illumination factor
  const sunOrientation = Fn(() => {
    return normalWorld.dot(sunDirection).mul(0.5).add(0.5);
  });

  // Day/night color mixing
  material.colorNode = Fn(() => {
    const dayColor = texture(dayTex, uv());
    const nightColor = texture(nightTex, uv());

    const orientation = sunOrientation();
    const dayNight = smoothstep(0.4, 0.6, orientation);

    // Add city lights on night side
    const cityLights = nightColor.mul(cityLightIntensity).mul(
      float(1.0).sub(dayNight)
    );

    const baseColor = mix(nightColor, dayColor, dayNight);
    return baseColor.add(cityLights.mul(float(1.0).sub(orientation).pow(2.0)));
  })();

  // Bump mapping for terrain
  material.normalNode = bumpMap(texture(bumpTex, uv()), 0.03);

  // PBR properties vary with day/night
  material.roughnessNode = Fn(() => {
    const orientation = sunOrientation();
    return mix(float(0.8), float(0.4), smoothstep(0.3, 0.7, orientation));
  })();

  material.metalnessNode = float(0.0);

  // Subtle atmospheric rim on day side
  material.emissiveNode = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = pow(float(1.0).sub(normalWorld.dot(viewDir).saturate()), 4.0);

    const orientation = sunOrientation();
    const atmosphereColor = mix(atmosphereTwilightColor, atmosphereDayColor, orientation);

    return atmosphereColor.mul(fresnel).mul(orientation).mul(0.3);
  })();

  return new THREE.Mesh(geometry, material);
}

function createClouds(cloudsTex) {
  const geometry = new THREE.SphereGeometry(1.01, 64, 64);
  const material = new THREE.MeshStandardNodeMaterial();

  // Animated UV for cloud movement
  const cloudUV = Fn(() => {
    const baseUV = uv();
    const offset = time.mul(cloudSpeed);
    return vec2(baseUV.x.add(offset), baseUV.y);
  });

  // Cloud color (white with transparency)
  material.colorNode = color(0xffffff);

  // Cloud opacity from texture
  material.opacityNode = Fn(() => {
    const cloudAlpha = texture(cloudsTex, cloudUV()).r;

    // Fade clouds on night side
    const sunOrientation = normalWorld.dot(sunDirection).mul(0.5).add(0.5);
    const dayFactor = smoothstep(0.2, 0.5, sunOrientation);

    return cloudAlpha.mul(0.8).mul(dayFactor.mul(0.5).add(0.5));
  })();

  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;

  // Slight self-illumination
  material.emissiveNode = Fn(() => {
    const sunOrientation = normalWorld.dot(sunDirection).mul(0.5).add(0.5);
    return color(0xffffff).mul(sunOrientation.mul(0.1));
  })();

  return new THREE.Mesh(geometry, material);
}

function createAtmosphere() {
  const geometry = new THREE.SphereGeometry(1.15, 64, 64);
  const material = new THREE.MeshBasicNodeMaterial();

  material.colorNode = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = pow(float(1.0).sub(normalWorld.dot(viewDir).abs()), 3.0);

    const sunOrientation = normalWorld.dot(sunDirection).mul(0.5).add(0.5);
    const atmosphereColor = mix(atmosphereTwilightColor, atmosphereDayColor, sunOrientation);

    return atmosphereColor;
  })();

  material.opacityNode = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = pow(float(1.0).sub(normalWorld.dot(viewDir).abs()), 2.5);

    // Stronger on day side
    const sunOrientation = normalWorld.dot(sunDirection).mul(0.5).add(0.5);

    return fresnel.mul(sunOrientation.mul(0.5).add(0.3));
  })();

  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.BackSide;

  return new THREE.Mesh(geometry, material);
}

function createStars() {
  const starsGeometry = new THREE.BufferGeometry();
  const starCount = 2000;

  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);

  for (let i = 0; i < starCount; i++) {
    // Random position on sphere
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const radius = 50 + Math.random() * 50;

    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);

    // Slight color variation
    const brightness = 0.5 + Math.random() * 0.5;
    colors[i * 3] = brightness;
    colors[i * 3 + 1] = brightness;
    colors[i * 3 + 2] = brightness + Math.random() * 0.2;
  }

  starsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starsGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const starsMaterial = new THREE.PointsNodeMaterial();
  starsMaterial.colorNode = Fn(() => {
    return vec3(1.0);
  })();
  starsMaterial.sizeNode = float(2.0);
  starsMaterial.vertexColors = true;

  const stars = new THREE.Points(starsGeometry, starsMaterial);
  scene.add(stars);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  // Rotate Earth slowly
  earth.rotation.y += 0.001;
  clouds.rotation.y += 0.0012;

  // Animate sun direction (optional - creates day/night cycle)
  // const angle = time.value * 0.1;
  // sunDirection.value.set(Math.cos(angle), 0.2, Math.sin(angle)).normalize();

  controls.update();
  renderer.render(scene, camera);
}

init();

// Export for external control
export { sunDirection, atmosphereDayColor, atmosphereTwilightColor, cloudSpeed, cityLightIntensity };
```

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/examples/particle-system.js`

```{txt}
/**
 * GPU Particle System with Compute Shaders
 *
 * Demonstrates TSL compute shaders for particle simulation:
 * - Instanced array buffers
 * - Physics simulation on GPU
 * - Mouse interaction
 *
 * Based on Three.js webgpu_compute_particles example (MIT License)
 * https://github.com/mrdoob/three.js
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  uniform,
  float,
  vec3,
  color,
  instancedArray,
  instanceIndex,
  hash,
  time
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;
let computeInit, computeUpdate, computeHit;

// Particle count
const PARTICLE_COUNT = 100000;

// Storage buffers
const positions = instancedArray(PARTICLE_COUNT, 'vec3');
const velocities = instancedArray(PARTICLE_COUNT, 'vec3');

// Uniforms
const gravity = uniform(-9.8);
const bounce = uniform(0.7);
const friction = uniform(0.98);
const deltaTimeUniform = uniform(0);
const clickPosition = uniform(new THREE.Vector3());
const hitStrength = uniform(5.0);

async function init() {
  // Camera
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 5, 15);

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111122);

  // Create compute shaders
  createComputeShaders();

  // Create particle mesh
  createParticleMesh();

  // Floor
  const floorGeometry = new THREE.PlaneGeometry(30, 30);
  const floorMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x333333
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Lights
  const ambientLight = new THREE.AmbientLight(0x404040);
  scene.add(ambientLight);

  const pointLight = new THREE.PointLight(0xffffff, 100);
  pointLight.position.set(5, 10, 5);
  scene.add(pointLight);

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  // Initialize particles (renderer already initialized above)
  renderer.compute(computeInit);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 2, 0);

  // Events
  window.addEventListener('resize', onWindowResize);
  renderer.domElement.addEventListener('click', onClick);

  renderer.setAnimationLoop(animate);
}

function createComputeShaders() {
  // Grid dimensions for initialization
  const gridSize = Math.ceil(Math.sqrt(PARTICLE_COUNT));
  const spacing = 0.15;
  const offset = (gridSize * spacing) / 2;

  // Initialize particles in a grid
  computeInit = Fn(() => {
    const position = positions.element(instanceIndex);
    const velocity = velocities.element(instanceIndex);

    // Calculate grid position
    const x = instanceIndex.mod(gridSize);
    const z = instanceIndex.div(gridSize);

    // Set position
    position.x.assign(x.toFloat().mul(spacing).sub(offset));
    position.y.assign(float(5.0).add(hash(instanceIndex).mul(2.0)));
    position.z.assign(z.toFloat().mul(spacing).sub(offset));

    // Random initial velocity
    velocity.x.assign(hash(instanceIndex.add(1)).sub(0.5).mul(2.0));
    velocity.y.assign(hash(instanceIndex.add(2)).mul(-2.0));
    velocity.z.assign(hash(instanceIndex.add(3)).sub(0.5).mul(2.0));
  })().compute(PARTICLE_COUNT);

  // Physics update
  computeUpdate = Fn(() => {
    const position = positions.element(instanceIndex);
    const velocity = velocities.element(instanceIndex);
    const dt = deltaTimeUniform;

    // Apply gravity
    velocity.y.addAssign(gravity.mul(dt));

    // Update position
    position.addAssign(velocity.mul(dt));

    // Apply friction
    velocity.mulAssign(friction);

    // Ground collision
    If(position.y.lessThan(0), () => {
      position.y.assign(0);
      velocity.y.assign(velocity.y.abs().mul(bounce)); // Reverse and dampen

      // Extra friction on ground
      velocity.x.mulAssign(0.9);
      velocity.z.mulAssign(0.9);
    });

    // Boundary walls
    If(position.x.abs().greaterThan(15), () => {
      position.x.assign(position.x.sign().mul(15));
      velocity.x.assign(velocity.x.negate().mul(bounce));
    });

    If(position.z.abs().greaterThan(15), () => {
      position.z.assign(position.z.sign().mul(15));
      velocity.z.assign(velocity.z.negate().mul(bounce));
    });
  })().compute(PARTICLE_COUNT);

  // Hit/explosion effect
  computeHit = Fn(() => {
    const position = positions.element(instanceIndex);
    const velocity = velocities.element(instanceIndex);

    // Distance to click
    const toClick = position.sub(clickPosition);
    const distance = toClick.length();

    // Apply force within radius
    If(distance.lessThan(3.0), () => {
      const direction = toClick.normalize();
      const force = float(3.0).sub(distance).div(3.0).mul(hitStrength);

      // Add randomness
      const randomForce = force.mul(hash(instanceIndex.add(time.mul(1000))).mul(0.5).add(0.75));

      velocity.addAssign(direction.mul(randomForce));
      velocity.y.addAssign(randomForce.mul(0.5));
    });
  })().compute(PARTICLE_COUNT);
}

function createParticleMesh() {
  // Simple sphere geometry for each particle
  const geometry = new THREE.SphereGeometry(0.08, 8, 8);

  // Material using computed positions
  const material = new THREE.MeshStandardNodeMaterial();

  // Position from compute buffer
  material.positionNode = positions.element(instanceIndex);

  // Color based on velocity
  material.colorNode = Fn(() => {
    const velocity = velocities.element(instanceIndex);
    const speed = velocity.length();

    // Color gradient: blue (slow) -> orange (fast)
    const t = speed.div(10.0).saturate();
    return color(0x0066ff).mix(color(0xff6600), t);
  })();

  material.roughnessNode = float(0.5);
  material.metalnessNode = float(0.2);

  // Create instanced mesh
  const mesh = new THREE.InstancedMesh(geometry, material, PARTICLE_COUNT);
  scene.add(mesh);
}

function onClick(event) {
  // Raycast to find click position on floor
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1
  );

  raycaster.setFromCamera(mouse, camera);

  // Intersect with floor plane (y = 0)
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const intersection = new THREE.Vector3();
  raycaster.ray.intersectPlane(plane, intersection);

  if (intersection) {
    // Raise click position slightly
    intersection.y = 0.5;
    clickPosition.value.copy(intersection);

    // Run hit compute shader
    renderer.compute(computeHit);
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

const clock = new THREE.Clock();

function animate() {
  // Update delta time
  deltaTimeUniform.value = Math.min(clock.getDelta(), 0.1);

  // Run physics compute
  renderer.compute(computeUpdate);

  controls.update();
  renderer.render(scene, camera);
}

init();
```

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/examples/post-processing.js`

```{txt}
/**
 * Post-Processing Pipeline Example
 *
 * Demonstrates TSL post-processing:
 * - Bloom effect
 * - Custom vignette
 * - Color grading
 * - Effect chaining
 *
 * Based on Three.js webgpu_postprocessing examples (MIT License)
 * https://github.com/mrdoob/three.js
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  color,
  uniform,
  pass,
  screenUV,
  screenSize,
  time,
  oscSine,
  mix,
  smoothstep,
  texture,
  grayscale,
  saturation
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;
let postProcessing;

// Effect uniforms
const bloomStrength = uniform(1.0);
const bloomThreshold = uniform(0.5);
const vignetteIntensity = uniform(0.5);
const saturationAmount = uniform(1.2);
const colorTint = uniform(new THREE.Color(1.0, 0.95, 0.9));

async function init() {
  // Camera
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 2, 8);

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  // Add objects with emissive materials (for bloom)
  createScene();

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  // Create post-processing pipeline
  setupPostProcessing();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 1, 0);

  // Events
  window.addEventListener('resize', onWindowResize);

  renderer.setAnimationLoop(animate);
}

function createScene() {
  // Floor
  const floorGeometry = new THREE.PlaneGeometry(20, 20);
  const floorMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x222222
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Emissive spheres (will bloom)
  const sphereGeometry = new THREE.SphereGeometry(0.5, 32, 32);

  const colors = [0xff0044, 0x00ff88, 0x4488ff, 0xffaa00, 0xff00ff];

  for (let i = 0; i < 5; i++) {
    const material = new THREE.MeshStandardNodeMaterial();

    // Base color
    material.colorNode = color(colors[i]).mul(0.3);

    // Animated emissive
    material.emissiveNode = Fn(() => {
      const pulse = oscSine(time.mul(1.0 + i * 0.2)).mul(0.5).add(0.5);
      return color(colors[i]).mul(pulse.mul(2.0).add(0.5));
    })();

    material.roughnessNode = float(0.2);
    material.metalnessNode = float(0.8);

    const sphere = new THREE.Mesh(sphereGeometry, material);
    sphere.position.set(
      Math.cos((i / 5) * Math.PI * 2) * 3,
      1 + Math.sin(i) * 0.5,
      Math.sin((i / 5) * Math.PI * 2) * 3
    );
    scene.add(sphere);
  }

  // Central reflective sphere
  const centerMaterial = new THREE.MeshStandardNodeMaterial();
  centerMaterial.colorNode = color(0x888888);
  centerMaterial.roughnessNode = float(0.1);
  centerMaterial.metalnessNode = float(1.0);

  const centerSphere = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64), centerMaterial);
  centerSphere.position.y = 1;
  scene.add(centerSphere);

  // Lights
  const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
  scene.add(ambientLight);

  const pointLight = new THREE.PointLight(0xffffff, 50);
  pointLight.position.set(5, 10, 5);
  scene.add(pointLight);
}

function setupPostProcessing() {
  // Create post-processing instance
  postProcessing = new THREE.RenderPipeline(renderer);

  // Create scene pass
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');

  // --- Effect Chain ---

  // 1. Bloom
  const bloomPass = bloom(sceneColor);
  bloomPass.threshold = bloomThreshold;
  bloomPass.strength = bloomStrength;
  bloomPass.radius = uniform(0.5);

  // Add bloom to scene
  let output = sceneColor.add(bloomPass);

  // 2. Color Grading
  output = saturation(output, saturationAmount);
  output = output.mul(colorTint);

  // 3. Vignette (custom effect)
  const vignette = Fn(() => {
    const uv = screenUV;
    const dist = uv.sub(0.5).length();
    return float(1.0).sub(dist.mul(vignetteIntensity).pow(2.0)).saturate();
  });

  output = output.mul(vignette());

  // 4. Optional: Scanlines
  const scanlines = Fn(() => {
    const scanline = screenUV.y.mul(screenSize.y).mul(0.5).sin().mul(0.05).add(0.95);
    return scanline;
  });

  // Uncomment for CRT effect:
  // output = output.mul(scanlines());

  // Set final output
  postProcessing.outputNode = output;
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  controls.update();

  // Render with post-processing
  postProcessing.render();
}

init();

// Export uniforms for external control (e.g., GUI)
export { bloomStrength, bloomThreshold, vignetteIntensity, saturationAmount, colorTint };
```

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/templates/webgpu-project.js`

```{txt}
/**
 * WebGPU Three.js Project Template
 *
 * A complete starter template with:
 * - WebGPU renderer setup
 * - TSL material example
 * - Post-processing ready
 * - Responsive design
 * - Animation loop
 *
 * Usage:
 * 1. Copy this file to your project
 * 2. Install Three.js: npm install three
 * 3. Replace placeholder content with your scene
 */

import * as THREE from 'three/webgpu';
import {
  // Types
  float,
  vec2,
  vec3,
  vec4,
  color,
  uniform,

  // Geometry
  positionLocal,
  positionWorld,
  normalLocal,
  normalWorld,
  uv,

  // Camera
  cameraPosition,

  // Time
  time,
  deltaTime,

  // Math
  mix,
  smoothstep,
  clamp,
  sin,
  cos,

  // Texture
  texture,

  // Functions
  Fn,
  If,
  Loop,

  // Post-processing
  pass
} from 'three/tsl';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // Renderer
  antialias: true,
  pixelRatio: Math.min(window.devicePixelRatio, 2),

  // Camera
  fov: 60,
  near: 0.1,
  far: 1000,
  position: new THREE.Vector3(0, 2, 5),

  // Scene
  backgroundColor: 0x111111,

  // Controls
  enableDamping: true,
  dampingFactor: 0.05
};

// ============================================
// GLOBALS
// ============================================

let camera, scene, renderer, controls;
let clock;

// Add your uniforms here
const uniforms = {
  // Example: myColor: uniform(new THREE.Color(0xff0000))
};

// ============================================
// INITIALIZATION
// ============================================

async function init() {
  // Clock
  clock = new THREE.Clock();

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.backgroundColor);

  // Camera
  camera = new THREE.PerspectiveCamera(
    CONFIG.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.near,
    CONFIG.far
  );
  camera.position.copy(CONFIG.position);

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: CONFIG.antialias });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(CONFIG.pixelRatio);
  document.body.appendChild(renderer.domElement);

  // Initialize WebGPU
  await renderer.init();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = CONFIG.enableDamping;
  controls.dampingFactor = CONFIG.dampingFactor;

  // Setup scene content
  setupLights();
  setupScene();

  // Optional: Setup post-processing
  // setupPostProcessing();

  // Events
  window.addEventListener('resize', onWindowResize);

  // Start animation loop
  renderer.setAnimationLoop(animate);
}

// ============================================
// SCENE SETUP
// ============================================

function setupLights() {
  // Ambient light
  const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
  scene.add(ambientLight);

  // Directional light
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(5, 10, 5);
  directionalLight.castShadow = true;
  scene.add(directionalLight);

  // Add more lights as needed
}

function setupScene() {
  // ========================================
  // ADD YOUR SCENE CONTENT HERE
  // ========================================

  // Example: Create a mesh with TSL material
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = createExampleMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Example: Add a floor
  const floorGeometry = new THREE.PlaneGeometry(10, 10);
  const floorMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x333333
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.5;
  scene.add(floor);
}

function createExampleMaterial() {
  const material = new THREE.MeshStandardNodeMaterial();

  // ========================================
  // CUSTOMIZE YOUR MATERIAL HERE
  // ========================================

  // Example: Animated color
  material.colorNode = Fn(() => {
    const t = time.mul(0.5).sin().mul(0.5).add(0.5);
    return mix(color(0x0066ff), color(0xff6600), t);
  })();

  // Example: PBR properties
  material.roughnessNode = float(0.5);
  material.metalnessNode = float(0.0);

  // Example: Simple fresnel rim
  material.emissiveNode = Fn(() => {
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    const fresnel = float(1.0).sub(normalWorld.dot(viewDir).saturate()).pow(3.0);
    return color(0x00ffff).mul(fresnel).mul(0.5);
  })();

  return material;
}

// ============================================
// POST-PROCESSING (Optional)
// ============================================

let postProcessing;

function setupPostProcessing() {
  // Uncomment and customize as needed

  // postProcessing = new THREE.RenderPipeline(renderer);
  // const scenePass = pass(scene, camera);
  // const sceneColor = scenePass.getTextureNode('output');
  //
  // // Add effects here
  // postProcessing.outputNode = sceneColor;
}

// ============================================
// ANIMATION LOOP
// ============================================

function animate() {
  const delta = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  // ========================================
  // UPDATE YOUR SCENE HERE
  // ========================================

  // Example: Rotate mesh
  const mesh = scene.children.find((child) => child.type === 'Mesh');
  if (mesh) {
    mesh.rotation.y += delta * 0.5;
  }

  // Update controls
  controls.update();

  // Render
  if (postProcessing) {
    postProcessing.render();
  } else {
    renderer.render(scene, camera);
  }
}

// ============================================
// EVENT HANDLERS
// ============================================

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ============================================
// START
// ============================================

init().catch(console.error);

// Export for external access if needed
export { scene, camera, renderer, uniforms };
```

### `/tmp/or-atom-008-corpus/webgpu-threejs-tsl/templates/compute-shader.js`

```{txt}
/**
 * Compute Shader Template
 *
 * A template for GPU compute shaders with:
 * - Storage buffer setup
 * - Initialize and update shaders
 * - Visualization with instanced mesh
 *
 * Usage:
 * 1. Modify PARTICLE_COUNT and buffer types
 * 2. Implement your initialization logic
 * 3. Implement your update logic
 * 4. Customize visualization
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  float,
  int,
  vec2,
  vec3,
  vec4,
  color,
  uniform,
  instancedArray,
  instanceIndex,
  hash,
  time,
  deltaTime,
  select,  // Use for conditional value selection
  max,
  clamp
} from 'three/tsl';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ============================================
// CONFIGURATION
// ============================================

const PARTICLE_COUNT = 50000;

// ============================================
// STORAGE BUFFERS
// ============================================

// Define your storage buffers here
// Available types: 'float', 'vec2', 'vec3', 'vec4', 'int', 'uint'

const positions = instancedArray(PARTICLE_COUNT, 'vec3');
const velocities = instancedArray(PARTICLE_COUNT, 'vec3');
// Add more buffers as needed:
// const colors = instancedArray(PARTICLE_COUNT, 'vec3');
// const lifetimes = instancedArray(PARTICLE_COUNT, 'float');
// const states = instancedArray(PARTICLE_COUNT, 'uint');

// ============================================
// UNIFORMS
// ============================================

const dt = uniform(0);
// Add your uniforms here:
// const gravity = uniform(-9.8);
// const attractorPosition = uniform(new THREE.Vector3());
// const forceStrength = uniform(1.0);

// ============================================
// COMPUTE SHADERS
// ============================================

/**
 * ⚠️  CRITICAL TSL GOTCHA - READ THIS FIRST!
 *
 * TSL intercepts PROPERTY ASSIGNMENTS on nodes, but NOT JS variable reassignment.
 *
 *   // ✅ WORKS - Property assignment on vec3 node
 *   const result = vec3(position);
 *   If(result.y.greaterThan(limit), () => {
 *     result.y = limit;  // TSL intercepts property setters!
 *   });
 *
 *   // ❌ WRONG - JS variable reassignment (scalars have no .x/.y properties)
 *   let value = buffer.element(index).toFloat();
 *   If(condition, () => {
 *     value = value.add(1.0);  // JS reassignment - TSL can't see this!
 *   });
 *   buffer.element(index).assign(value);  // Uses ORIGINAL node!
 *
 * Solutions for scalars:
 *
 *   // ✅ Use select() for conditional values
 *   const newValue = select(condition, valueIfTrue, valueIfFalse);
 *
 *   // ✅ Use .toVar() for mutable scalars
 *   const value = buffer.element(index).toVar();
 *   If(condition, () => {
 *     value.assign(value.add(1.0));  // Works with .toVar()!
 *   });
 *
 *   // ✅ Use direct .assign() on buffer elements
 *   If(condition, () => {
 *     element.assign(element.add(1.0));
 *   });
 */

/**
 * Initialize particles
 * Called once at startup
 */
const computeInit = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // ========================================
  // IMPLEMENT YOUR INITIALIZATION HERE
  // ========================================

  // Example: Random positions in a cube
  position.x.assign(hash(instanceIndex).sub(0.5).mul(10));
  position.y.assign(hash(instanceIndex.add(1)).sub(0.5).mul(10));
  position.z.assign(hash(instanceIndex.add(2)).sub(0.5).mul(10));

  // Example: Zero velocity
  velocity.assign(vec3(0));
})().compute(PARTICLE_COUNT);

/**
 * Update particles each frame
 * Called every frame in animation loop
 */
const computeUpdate = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // ========================================
  // IMPLEMENT YOUR UPDATE LOGIC HERE
  // ========================================

  // Example: Simple gravity
  velocity.y.addAssign(float(-9.8).mul(dt));

  // Example: Update position
  position.addAssign(velocity.mul(dt));

  // Example: Ground bounce
  If(position.y.lessThan(0), () => {
    position.y.assign(0);
    velocity.y.assign(velocity.y.negate().mul(0.8));
  });

  // Example: Boundary wrapping
  // If(position.x.abs().greaterThan(5), () => {
  //   position.x.assign(position.x.negate());
  // });
})().compute(PARTICLE_COUNT);

/**
 * Optional: Additional compute pass (e.g., for interactions)
 */
const computeInteraction = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // ========================================
  // IMPLEMENT INTERACTION LOGIC HERE
  // ========================================

  // Example: Attract to point
  // const toTarget = attractorPosition.sub(position);
  // const dist = toTarget.length();
  // const force = toTarget.normalize().mul(forceStrength).div(dist.add(0.1));
  // velocity.addAssign(force.mul(dt));
})().compute(PARTICLE_COUNT);

// ============================================
// VISUALIZATION
// ============================================

function createVisualization(scene) {
  // Choose visualization type:
  // - Points (fastest, simplest)
  // - Instanced Mesh (more control)

  // Option 1: Points
  // return createPointsVisualization(scene);

  // Option 2: Instanced Mesh
  return createInstancedVisualization(scene);
}

function createPointsVisualization(scene) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(new Float32Array(PARTICLE_COUNT * 3), 3)
  );

  const material = new THREE.PointsNodeMaterial();

  // Position from compute buffer
  material.positionNode = positions.element(instanceIndex);

  // ========================================
  // CUSTOMIZE POINT APPEARANCE HERE
  // ========================================

  material.sizeNode = float(3.0);

  material.colorNode = Fn(() => {
    // Example: Color based on velocity
    const velocity = velocities.element(instanceIndex);
    const speed = velocity.length();
    return mix(color(0x0066ff), color(0xff6600), speed.div(5).saturate());
  })();

  const points = new THREE.Points(geometry, material);
  scene.add(points);
  return points;
}

function createInstancedVisualization(scene) {
  // Geometry for each instance
  const geometry = new THREE.SphereGeometry(0.05, 8, 8);
  // Or use simpler geometry for better performance:
  // const geometry = new THREE.IcosahedronGeometry(0.05, 0);

  const material = new THREE.MeshStandardNodeMaterial();

  // Position from compute buffer
  material.positionNode = positions.element(instanceIndex);

  // ========================================
  // CUSTOMIZE MESH APPEARANCE HERE
  // ========================================

  material.colorNode = Fn(() => {
    // Example: Color based on position
    const position = positions.element(instanceIndex);
    return color(0x0088ff).add(position.mul(0.05));
  })();

  material.roughnessNode = float(0.5);
  material.metalnessNode = float(0.2);

  const mesh = new THREE.InstancedMesh(geometry, material, PARTICLE_COUNT);
  scene.add(mesh);
  return mesh;
}

// ============================================
// MAIN SETUP
// ============================================

let camera, scene, renderer, controls;
let visualization;

async function init() {
  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111122);

  // Camera
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 5, 15);

  // Lights
  const ambientLight = new THREE.AmbientLight(0x404040);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(5, 10, 5);
  scene.add(directionalLight);

  // Optional: Ground plane
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardNodeMaterial({ color: 0x333333 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  // Initialize particles (renderer already initialized above)
  renderer.compute(computeInit);

  // Create visualization
  visualization = createVisualization(scene);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 2, 0);

  // Events
  window.addEventListener('resize', onWindowResize);

  // Start
  renderer.setAnimationLoop(animate);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

const clock = new THREE.Clock();

function animate() {
  // Update delta time uniform
  dt.value = Math.min(clock.getDelta(), 0.1);

  // Run compute shaders
  renderer.compute(computeUpdate);
  // renderer.compute(computeInteraction);

  // Update controls
  controls.update();

  // Render
  renderer.render(scene, camera);
}

init().catch(console.error);

// Export for external control
export {
  positions,
  velocities,
  dt,
  computeInit,
  computeUpdate,
  computeInteraction
};
```

## Skill: performance (web-quality.zip, web-quality/performance/)

### `/tmp/or-atom-008-corpus/web-quality/performance/SKILL.md`

````{txt}
---
name: performance
description: Optimize web performance for faster loading and better user experience. Use when asked to "speed up my site", "optimize performance", "reduce load time", "fix slow loading", "improve page speed", or "performance audit".
license: MIT
metadata:
  version: "2.0"
---

# Performance optimization

Evidence-led performance optimization using real-user signals for prioritization and browser traces for diagnosis. Focuses on loading speed, runtime responsiveness, and resource delivery.

## How it works

1. If a page can run, read [the measurement workflow](references/MEASUREMENT.md) and establish a field-plus-lab baseline before editing.
2. Prioritize poor real-user Core Web Vitals. Use a DevTools performance trace and its focused insights to find the cause.
3. Inspect and change only the code or assets connected to measured bottlenecks.
4. Re-run equivalent lab measurements and report before/after values, conditions, and uncertainty. Field verification remains pending until enough new user data arrives.

When no runnable page exists, perform static inspection but call findings **hypotheses**, not measured regressions. Include the command or browser workflow that can verify each high-impact hypothesis.

Prefer a browser tool that records a performance trace and exposes focused insights. With Chrome DevTools MCP, use `performance_start_trace` and `performance_analyze_insight`; do not route performance through `lighthouse_audit`, which covers non-performance Lighthouse categories.

## Starting performance budget

Budgets must reflect the product's target devices, networks, page types, and user journeys. The values below are initial guardrails for a typical content or commerce page, not universal pass/fail criteria. Preserve an existing project budget when one is already defined.

| Resource | Budget | Rationale |
|----------|--------|-----------|
| Total page weight | < 1.5 MB | Bounds transfer time and data cost on constrained target networks; calibrate with representative pages |
| JavaScript (compressed) | < 300 KB | Protect parse and execution cost |
| CSS (compressed) | < 100 KB | Limit render-blocking work |
| Images (above-fold) | < 500 KB | Protect likely LCP resources |
| Fonts | < 100 KB | Limit critical font transfer |
| Third-party | < 200 KB | Bound code outside product control |

## Critical rendering path

### Server response
* **TTFB < 800ms.** Time to First Byte should be fast. Use CDN, caching, and efficient backends.
* **Enable compression.** Gzip or Brotli for text assets. Brotli preferred (15-20% smaller).
* **HTTP/2 or HTTP/3.** Multiplexing reduces connection overhead.
* **Edge caching.** Cache HTML at CDN edge when possible.
* **Consider Early Hints (HTTP 103) for measured document latency.** If a trace shows slow HTML generation and stable critical subresources, send an interim `103` with `Link` headers before the normal final response from the same request. Use HTTP/2 or later. A CDN may synthesize the `103` from `Link` headers on an earlier `200`, or the origin/edge handler can emit it directly. Unsupported clients continue to the final response, but confirm current browser and infrastructure support. Limit hints to proven critical preloads or preconnects: inaccurate hints waste bandwidth. Cloudflare reported a 20–30% LCP improvement in an artificial, image-heavy test; treat that as a vendor case study, not an expected saving, and measure your result. See [MDN's 103 implementation example](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/103) and [the Cloudflare study](https://blog.cloudflare.com/early-hints-performance/).

### Resource loading

**Preconnect to required origins:**
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://cdn.example.com" crossorigin>
```

**Preload critical resources:**

Preload only resources whose late discovery is visible in the trace. Each preload competes for bandwidth and an unnecessary high-priority request can delay LCP.

```html
<!-- LCP image -->
<link rel="preload" href="/hero.webp" as="image" fetchpriority="high">

<!-- Critical font -->
<link rel="preload" href="/font.woff2" as="font" type="font/woff2" crossorigin>
```

**Prerender likely-next navigations** with the [Speculation Rules API](https://developer.chrome.com/docs/web-platform/prerender-pages):
```html
<script type="speculationrules">
{
  "prerender": [{
    "where": { "href_matches": "/*" },
    "eagerness": "moderate"
  }]
}
</script>
```
`moderate` waits for a stronger intent signal than eager modes. Measure prediction hit rate, transferred bytes, and server cost; a wrong prerender is roughly an unused navigation. See [core-web-vitals → LCP](../core-web-vitals/SKILL.md#lcp-largest-contentful-paint) for the tradeoffs and the `prerenderingchange` gating needed for analytics.

**Defer non-critical CSS:**
```html
<!-- Critical CSS inlined -->
<style>/* Above-fold styles */</style>

<!-- Non-critical CSS -->
<link rel="preload" href="/styles.css" as="style" onload="this.onload=null;this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="/styles.css"></noscript>
```

### JavaScript optimization

**Defer non-essential scripts:**
```html
<!-- Parser-blocking (avoid) -->
<script src="/critical.js"></script>

<!-- Deferred (preferred) -->
<script defer src="/app.js"></script>

<!-- Async (for independent scripts) -->
<script async src="/analytics.js"></script>

<!-- Module (deferred by default) -->
<script type="module" src="/app.mjs"></script>
```

**Code splitting patterns:**
```javascript
// Route-based splitting
const Dashboard = lazy(() => import('./Dashboard'));

// Component-based splitting
const HeavyChart = lazy(() => import('./HeavyChart'));

// Feature-based splitting
if (user.isPremium) {
  const PremiumFeatures = await import('./PremiumFeatures');
}
```

**Tree shaking best practices:**
```javascript
// ❌ Imports entire library
import _ from 'lodash';
_.debounce(fn, 300);

// ✅ Imports only what's needed
import debounce from 'lodash/debounce';
debounce(fn, 300);
```

## Image optimization

### Format selection
| Format | Use case | Browser support |
|--------|----------|-----------------|
| AVIF | Photos, best compression | 92%+ |
| WebP | Photos, good fallback | 97%+ |
| PNG | Graphics with transparency | Universal |
| SVG | Icons, logos, illustrations | Universal |

### Responsive images
```html
<picture>
  <!-- AVIF for modern browsers -->
  <source
    type="image/avif"
    srcset="hero-400.avif 400w,
            hero-800.avif 800w,
            hero-1200.avif 1200w"
    sizes="(max-width: 600px) 100vw, 50vw">

  <!-- WebP fallback -->
  <source
    type="image/webp"
    srcset="hero-400.webp 400w,
            hero-800.webp 800w,
            hero-1200.webp 1200w"
    sizes="(max-width: 600px) 100vw, 50vw">

  <!-- JPEG fallback -->
  <img
    src="hero-800.jpg"
    srcset="hero-400.jpg 400w,
            hero-800.jpg 800w,
            hero-1200.jpg 1200w"
    sizes="(max-width: 600px) 100vw, 50vw"
    width="1200"
    height="600"
    alt="Hero image"
    loading="lazy"
    decoding="async">
</picture>
```

### LCP image priority
```html
<!-- Above-fold LCP image: eager loading, high priority -->
<img
  src="hero.webp"
  fetchpriority="high"
  loading="eager"
  decoding="sync"
  alt="Hero">

<!-- Below-fold images: lazy loading -->
<img
  src="product.webp"
  loading="lazy"
  decoding="async"
  alt="Product">
```

## Font optimization

### Loading strategy
```css
/* System font stack as fallback */
body {
  font-family: 'Custom Font', -apple-system, BlinkMacSystemFont,
               'Segoe UI', Roboto, sans-serif;
}

/* Prevent invisible text */
@font-face {
  font-family: 'Custom Font';
  src: url('/fonts/custom.woff2') format('woff2');
  font-display: swap; /* or optional for non-critical */
  font-weight: 400;
  font-style: normal;
  unicode-range: U+0000-00FF; /* Subset to Latin */
}
```

### Preloading critical fonts
```html
<link rel="preload" href="/fonts/heading.woff2" as="font" type="font/woff2" crossorigin>
```

### Variable fonts
```css
/* One file instead of multiple weights */
@font-face {
  font-family: 'Inter';
  src: url('/fonts/Inter-Variable.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-display: swap;
}
```

## Caching strategy

### Cache-Control headers
```
# HTML (short or no cache)
Cache-Control: no-cache, must-revalidate

# Static assets with hash (immutable)
Cache-Control: public, max-age=31536000, immutable

# Static assets without hash
Cache-Control: public, max-age=86400, stale-while-revalidate=604800

# API responses
Cache-Control: private, max-age=0, must-revalidate
```

### Service worker caching
```javascript
// Cache-first for static assets
self.addEventListener('fetch', (event) => {
  if (event.request.destination === 'image' ||
      event.request.destination === 'style' ||
      event.request.destination === 'script') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open('static-v1').then((cache) => cache.put(event.request, clone));
          return response;
        });
      })
    );
  }
});
```

## Runtime performance

### Avoid layout thrashing
```javascript
// ❌ Forces multiple reflows
elements.forEach(el => {
  const height = el.offsetHeight; // Read
  el.style.height = height + 10 + 'px'; // Write
});

// ✅ Batch reads, then batch writes
const heights = elements.map(el => el.offsetHeight); // All reads
elements.forEach((el, i) => {
  el.style.height = heights[i] + 10 + 'px'; // All writes
});
```

### Debounce expensive operations
```javascript
function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

// Debounce scroll/resize handlers
window.addEventListener('scroll', debounce(handleScroll, 100));
```

### Use requestAnimationFrame
```javascript
// ❌ May cause jank
setInterval(animate, 16);

// ✅ Synced with display refresh
function animate() {
  // Animation logic
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
```

### Virtualize long lists
```javascript
// For lists > 100 items, render only visible items
// Use libraries like react-window, vue-virtual-scroller, or native CSS:
.virtual-list {
  content-visibility: auto;
  contain-intrinsic-size: 0 50px; /* Estimated item height */
}
```

### Smooth navigations with View Transitions

The [View Transitions API](https://developer.chrome.com/docs/web-platform/view-transitions) lets the browser cross-fade (or custom-animate) between two DOM states using a single GPU-composited snapshot — no double-render, no layout thrash, and the snapshot doesn't count toward CLS.

**Same-document (SPA-style) — Baseline 2026:**
```javascript
// Wrap the DOM mutation that swaps the view
function navigate(newView) {
  if (!document.startViewTransition) return swapDOM(newView);
  document.startViewTransition(() => swapDOM(newView));
}
```

**Cross-document (MPA-style) — Chromium-stable, progressive enhancement elsewhere:**
```css
/* On both source and destination pages */
@view-transition { navigation: auto; }
```
That's the entire integration — same-origin navigations now fade automatically. To opt specific elements into shared-element transitions (e.g. a thumbnail expanding into a hero), give them a matching `view-transition-name`:
```css
.product-thumb[data-id="42"], .product-hero { view-transition-name: product-42; }
```

Pair this with Speculation Rules (above) for instant + animated navigations.

## Third-party scripts

### Load strategies
```javascript
// ❌ Blocks main thread
<script src="https://analytics.example.com/script.js"></script>

// ✅ Async loading
<script async src="https://analytics.example.com/script.js"></script>

// ✅ Delay until interaction
<script>
document.addEventListener('DOMContentLoaded', () => {
  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      const script = document.createElement('script');
      script.src = 'https://widget.example.com/embed.js';
      document.body.appendChild(script);
      observer.disconnect();
    }
  });
  observer.observe(document.querySelector('#widget-container'));
});
</script>
```

### Facade pattern
```html
<!-- Show static placeholder until interaction -->
<div class="youtube-facade"
     data-video-id="abc123"
     onclick="loadYouTube(this)">
  <img src="/thumbnails/abc123.jpg" alt="Video title">
  <button aria-label="Play video">▶</button>
</div>
```

## Measurement

Use [the measurement workflow](references/MEASUREMENT.md) whenever a URL is runnable. It defines Chrome DevTools MCP routing, CrUX and fallback sources, repeatable lab conditions, and a compact evidence format.

| Metric | Kind | Interpretation |
|--------|------|----------------|
| LCP, INP, CLS at p75 | Field | User-outcome Core Web Vitals; use for pass/fail prioritization |
| LCP, CLS in a trace | Lab | Reproducible diagnostic values for one navigation |
| TBT | Lab | Main-thread blocking diagnostic and a rough INP proxy, not field INP |
| FCP, Speed Index | Lab | Loading diagnostics, not Core Web Vitals |

Raw `PerformanceObserver` snippets are useful for the current browser session but are not real-user data by themselves. When the user wants production telemetry, read [the first-party RUM reference](references/RUM.md) and prefer `web-vitals` over a hand-rolled metric implementation.

## References

For Core Web Vitals specific optimizations, see [Core Web Vitals](../core-web-vitals/SKILL.md).
````

### `/tmp/or-atom-008-corpus/web-quality/performance/references/MEASUREMENT.md`

```{txt}
# Performance measurement workflow

Use this workflow when a runnable URL is available, the user asks for measured performance, or a change needs before/after verification.

## Keep the evidence types separate

| Evidence | What it represents | Best use |
|----------|--------------------|----------|
| CrUX field data | Aggregated experiences from eligible real Chrome users, normally a rolling 28-day window | Decide whether users have a Core Web Vitals problem |
| First-party RUM | Measurements collected and reported from the site's own user sessions | Segment and diagnose current production experience |
| DevTools performance trace | One observed browser session under stated local or emulated conditions | Find LCP, INP, CLS, network, and main-thread causes |
| Lighthouse lab run | A controlled synthetic navigation | Reproduce load problems and prevent regressions |
| Static code inspection | Potential issues inferred from source | Form hypotheses when no page can run |

A `PerformanceObserver` result injected into one browser page is a **single-session lab observation**, not field data. It becomes RUM only when measurements from actual users are reported and aggregated.

## Preferred low-friction route

When browser tooling can record a performance trace and run Lighthouse audits, prefer this route. With Chrome DevTools MCP:

1. Navigate to the exact route and state being audited. Record whether it is public, authenticated, local, or staging.
2. Record a reload trace with auto-stop for page-load performance (`performance_start_trace`). Current trace summaries can include both observed lab metrics and CrUX field metrics when CrUX has eligible data. Record whether field scope is URL or origin.
3. Analyze only the relevant failing or suspicious insights (`performance_analyze_insight`). Common examples are `LCPBreakdown`, `LCPDiscovery`, `DocumentLatency`, `RenderBlocking`, and `ThirdParties`.
4. Run the Lighthouse audit capability (`lighthouse_audit`) for Accessibility, SEO, Best Practices, and Agentic Browsing. It deliberately excludes performance; do not treat it as the performance path.
5. Re-run the same lab measurement after a fix. Field data will not reflect a new deployment immediately.

Use mobile conditions by default for a general public-site audit. Add desktop when the user asks for it, desktop traffic matters, or the product is desktop-oriented. Test authenticated and unauthenticated states separately when they render different pages.

When using emulation, set the viewport, network conditions, and CPU rate explicitly before the trace, confirm the reported conditions, and reset them before testing another profile.

Chrome DevTools MCP's Lighthouse navigation mode reloads the page. Use snapshot mode for the current state when a reload would lose an authenticated or user-created state. Do not run a navigation audit on an unsaved form or destructive workflow.

### Token-efficient tool use

* Start with one trace and one Lighthouse audit rather than broad DOM, network, console, and source dumps.
* Preserve large reports or traces to temporary files when the tool supports `filePath` or `outputDirPath`; summarize only actionable failures.
* Drill into the few insights tied to a poor field metric or a reproducible lab bottleneck.
* Filter and paginate network or console requests. Fetch individual request details only when they support a finding.
* Take a text snapshot before a screenshot unless visual inspection is necessary.

## Fallbacks when DevTools tools are unavailable

Use the first available option; do not block the audit on optional setup.

1. **Lighthouse CLI for lab data:** run the project's compatible Lighthouse version against the runnable URL. Keep JSON for comparison and avoid installing a permanent dependency unless the user wants one.
2. **PageSpeed Insights web UI for a public URL:** it provides a zero-setup view of Lighthouse lab diagnostics and available CrUX field data.
3. **CrUX Vis for history:** use it when trend data matters and the URL or origin is eligible.
4. **CrUX API or History API for automation:** both are free to use but require a Google Cloud API key. Do not make a key a prerequisite for an ordinary audit.
5. **Static inspection:** if nothing can run, label every performance finding as a hypothesis and provide the exact measurement needed to verify it.

The PageSpeed Insights API may be called without a key for occasional use, but a key is recommended for repeated automation. Google has announced that CrUX field data will be removed from that API, so new integrations should query the CrUX API directly.

## Reading CrUX correctly

* Prefer page-level data for the audited URL. If only origin data exists, label it as origin scope; it is context, not proof for that route.
* Compare the p75 value with the Core Web Vitals threshold and include the percentage of good experiences when available.
* Keep phone and desktop data separate. Do not combine form factors to answer a device-specific question.
* Treat missing CrUX data as **unavailable**, never as passing. Localhost, staging, new, private, and low-traffic pages commonly have no CrUX record.
* CrUX is aggregated and delayed. Use it to prioritize user outcomes, not to verify a change deployed minutes ago.

## Repeatable lab comparisons

Record these conditions with the result:

* final URL and page state
* browser and Lighthouse/tool version
* viewport or form factor
* CPU and network throttling
* cold or warm cache
* authentication, consent, and experiment state

For a decision based on a headline lab metric, run at least three equivalent navigations and report the median plus range. Do not compare a single local trace directly with the CrUX p75 or claim that the two should match.

Use metric values as the evidence. A Lighthouse score is a diagnostic summary whose weighting and implementation can change between versions.

## Reconciling lab and field

| Field | Lab | Interpretation |
|-------|-----|----------------|
| Poor | Poor | Reproducible user problem; trace and fix the dominant bottleneck |
| Poor | Good | Local run missed real-user conditions; segment first-party RUM or test representative devices, routes, cache states, and interactions |
| Good | Poor | The synthetic cold/throttled case is fragile, but do not claim users are currently failing |
| Unavailable | Any | Use lab data for diagnosis and recommend RUM if production impact matters |

## Compact audit output

Start reports with an evidence table:

| Signal | Scope and conditions | Baseline | After | Source |
|--------|----------------------|----------|-------|--------|
| LCP | URL, phone, p75/28 days | 3.1s | Pending field window | CrUX |
| LCP | URL, mobile lab, cold cache, median of 3 | 3.8s | 2.6s | DevTools trace |

Then separate:

1. measured failures
2. trace-backed causes
3. source-code hypotheses
4. fixes made or recommended
5. verification status and remaining uncertainty

## Sources

* [Chrome DevTools MCP tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)
* [Chrome UX Report API](https://developer.chrome.com/docs/crux/api)
* [Getting started with measuring Web Vitals](https://web.dev/articles/vitals-measurement-getting-started)
* [PageSpeed Insights API](https://developers.google.com/speed/docs/insights/v5/get-started)
```

### `/tmp/or-atom-008-corpus/web-quality/performance/references/RUM.md`

````{txt}
# First-party real-user monitoring

Read this only when the user wants to add, review, or improve production RUM.

## Before changing the site

Telemetry changes affect production data collection and privacy. Reuse an existing analytics or RUM pipeline when possible. If adding a new endpoint, vendor, cookie, or consent behavior was not requested, propose the change and get authorization before implementing it.

Prefer the `web-vitals` library over hand-written `PerformanceObserver` code. It follows the metric lifecycle and browser edge cases used by Google's tooling. Switch to the attribution build only when the extra diagnostic context will be reviewed and deliberately allowlisted.

## Minimal collection pattern

```javascript
import {onCLS, onINP, onLCP} from 'web-vitals';

function sendToRum({name, value, rating, id, navigationType}) {
  const body = JSON.stringify({
    name,
    value,
    rating,
    id,
    navigationType,
    path: location.pathname,
    release: window.APP_RELEASE
  });

  if (!navigator.sendBeacon?.('/rum', body)) {
    fetch('/rum', {method: 'POST', body, keepalive: true});
  }
}

onCLS(sendToRum);
onINP(sendToRum);
onLCP(sendToRum);
```

Adapt the payload to the existing backend. Do not include query strings, user-entered text, full DOM fragments, or other personal data. The `web-vitals/attribution` build can add element or script details; review them and send only explicit, low-cardinality fields that fit the site's privacy model.

## Collection rules

* Record a stable release or experiment identifier so regressions can be attributed to a change.
* Group by route template rather than creating a high-cardinality bucket for every URL.
* Retain device/form factor, navigation type, and coarse connection context when the privacy model allows it.
* Sample deliberately and record the sampling rate. Do not compare cohorts collected with different sampling rules as if they were equal.
* Let the library report final metric values. `reportAllChanges` is useful for local debugging but usually creates noisy production telemetry.
* Handle consent and regional privacy requirements through the site's existing policy.

## Aggregation and reporting

For each route or product journey, report:

* p75 for LCP, INP, and CLS
* percentage of visits in good, needs-improvement, and poor buckets
* sample count and time window
* important segments such as form factor, release, and navigation type

Do not use an average as the pass/fail signal. Assess each Core Web Vital at p75; all three p75 values must meet their good thresholds for the route or origin to pass the combined assessment.

CrUX and first-party RUM can disagree because they cover different users, browsers, routes, sampling rules, and time windows. Document those differences before treating either source as wrong.

## Sources

* [web-vitals library](https://github.com/GoogleChrome/web-vitals)
* [Best practices for measuring Web Vitals in the field](https://web.dev/articles/vitals-field-measurement-best-practices)
* [Find slow interactions in the field](https://web.dev/articles/find-slow-interactions-in-the-field)
````

## Skill: core-web-vitals (web-quality.zip, web-quality/core-web-vitals/)

### `/tmp/or-atom-008-corpus/web-quality/core-web-vitals/SKILL.md`

````{txt}
---
name: core-web-vitals
description: Optimize Core Web Vitals (LCP, INP, CLS) for better page experience using field and lab evidence. Use when asked to "improve Core Web Vitals", "fix LCP", "reduce CLS", "optimize INP", "page experience optimization", or "fix layout shifts".
license: MIT
metadata:
  version: "2.0"
---

# Core Web Vitals optimization

Targeted optimization for the three Core Web Vitals using field data to identify user impact and browser traces to diagnose causes.

## Measure before optimizing

When a runnable URL is available, read [the performance measurement workflow](../performance/references/MEASUREMENT.md). Prefer this sequence:

1. Check page-level CrUX p75 data, with a clearly labeled origin fallback when page data is unavailable.
2. Record a browser performance trace under stated conditions. With Chrome DevTools MCP, trace summaries can include CrUX alongside the observed lab metrics.
3. Analyze only the insights associated with the failing metric, then inspect the implicated code and resources.
4. Re-run equivalent lab measurements after the fix. Do not claim an immediate field improvement; CrUX and first-party RUM need new user visits.

If only source code is available, identify likely causes but do not claim that LCP, INP, or CLS is failing without runtime evidence.

## The three metrics

| Metric | Measures | Good | Needs work | Poor |
|--------|----------|------|------------|------|
| **LCP** | Loading | ≤ 2.5s | 2.5s – 4s | > 4s |
| **INP** | Interactivity | ≤ 200ms | 200ms – 500ms | > 500ms |
| **CLS** | Visual Stability | ≤ 0.1 | 0.1 – 0.25 | > 0.25 |

Google measures at the **75th percentile** — 75% of page visits must meet "Good" thresholds.

---

## LCP: Largest Contentful Paint

LCP measures when the largest visible content element renders. Usually this is:
- Hero image or video
- Large text block
- Background image
- `<svg>` element

### Common LCP issues

**1. Slow server response (TTFB > 800ms)**
```
Fix: CDN, caching, optimized backend, edge rendering
```

**2. Render-blocking resources**
```html
<!-- ❌ Blocks rendering -->
<link rel="stylesheet" href="/all-styles.css">

<!-- ✅ Critical CSS inlined, rest deferred -->
<style>/* Critical above-fold CSS */</style>
<link rel="preload" href="/styles.css" as="style"
      onload="this.onload=null;this.rel='stylesheet'">
```

**3. Slow resource load times**
```html
<!-- ❌ LCP image is discovered only after a stylesheet loads -->
<div class="hero"></div>

<!-- ✅ Discoverable in initial HTML and prioritized -->
<link rel="preload" href="/hero.webp" as="image" fetchpriority="high">
<img src="/hero.webp" alt="Hero" fetchpriority="high">
```

Prefer a discoverable `<img>` with `fetchpriority="high"`. Add the preload only when the trace shows that the resource would otherwise be discovered late; duplicate or speculative preloads can compete for bandwidth.

**4. Client-side rendering delays**
```javascript
// ❌ Content loads after JavaScript
useEffect(() => {
  fetch('/api/hero-text').then(r => r.json()).then(setHeroText);
}, []);

// ✅ Server-side or static rendering
// Use SSR, SSG, or streaming to send HTML with content
export async function getServerSideProps() {
  const heroText = await fetchHeroText();
  return { props: { heroText } };
}
```

**5. Make navigations instant with the Speculation Rules API**

For sites with predictable same-origin journeys, prerendering a likely next page can make a successful subsequent navigation much faster. Treat this as a measured navigation optimization, not a substitute for fixing the current page's LCP.

```html
<script type="speculationrules">
{
  "prerender": [{
    "where": { "href_matches": "/*" },
    "eagerness": "moderate"
  }]
}
</script>
```

Current Chrome behavior is specific enough to guide the choice:

| `eagerness` | Trigger |
|-------------|---------|
| `conservative` | Pointer or touch down |
| `moderate` | Desktop: 200ms hover, or earlier pointer down; mobile: viewport heuristics |
| `eager` | Chrome 143+: desktop 10ms hover; mobile 50ms after the anchor enters the viewport |
| `immediate` | As soon as the rules are observed |

Start conservatively and measure prediction hit rate, transferred bytes, server load, and navigation improvement before expanding the rules. Recheck [Chrome's maintained eagerness documentation](https://developer.chrome.com/docs/web-platform/prerender-pages#eagerness) before hardcoding timing-sensitive behavior.

Caveats:
- **Bandwidth/CPU cost.** Each prerender is roughly a full page load. Scope `where` carefully (`href_matches` patterns, exclude logout/checkout) and avoid `immediate` outside small sites.
- **Side effects fire early.** Analytics, ads, and any code that runs on load will fire when the prerender starts, not when the user navigates. Gate side effects on the [`prerenderingchange` event](https://developer.chrome.com/docs/web-platform/prerender-pages#detect_when_a_page_is_prerendered_or_used_for_a_full_navigation) or `document.prerendering`.
- **Chromium-only.** Safari and Firefox ignore the script — it's a progressive enhancement, never a regression.

### LCP optimization checklist

```markdown
- [ ] TTFB < 800ms (use CDN, edge caching)
- [ ] LCP resource is discoverable in initial HTML and prioritized; preload only if the trace shows late discovery
- [ ] LCP image optimized (WebP/AVIF, correct size)
- [ ] Critical CSS inlined (< 14KB)
- [ ] No render-blocking JavaScript in <head>
- [ ] Fonts don't block text rendering (font-display: swap)
- [ ] LCP element in initial HTML (not JS-rendered)
- [ ] Speculation Rules added for likely-next navigations (moderate eagerness)
```

### LCP element identification

This snippet diagnoses the current page session. It is not field data.

```javascript
// Find your LCP element
new PerformanceObserver((list) => {
  const entries = list.getEntries();
  const lastEntry = entries[entries.length - 1];
  console.log('LCP element:', lastEntry.element);
  console.log('LCP time:', lastEntry.startTime);
}).observe({ type: 'largest-contentful-paint', buffered: true });
```

---

## INP: Interaction to Next Paint

INP measures responsiveness across clicks, taps, and key presses during a visit. Diagnose its input delay, processing time, and presentation delay separately; a slow interaction may involve main-thread contention before the handler, expensive application work, or delayed rendering after it.

When field INP is poor or a trace identifies a slow interaction, read [the INP reference](references/INP.md) for trace interpretation, yielding patterns, third-party and rendering causes, a single-session observer, and first-party attribution.

---

## CLS: Cumulative Layout Shift

CLS measures unexpected layout shifts across a page visit. Use field attribution or a trace to identify the shifted node and the trigger; do not assume the visible victim caused the shift.

When field CLS is poor or a trace reports shifts, read [the CLS reference](references/CLS.md) for reserved-space patterns, dynamic content, font and animation fixes, a debugging observer, and a verification checklist.

---

## Measurement sources

| Source | Use |
|--------|-----|
| Browser performance trace (Chrome DevTools MCP: `performance_start_trace`) | Observe one load or interaction and diagnose focused insights; use included CrUX context when available |
| CrUX or Search Console | Prioritize aggregated real-user outcomes at p75 |
| Lighthouse CLI or PageSpeed Insights | Controlled lab fallback when DevTools tools are unavailable |
| First-party RUM | Segment current production experience by route, device, release, and attribution |
| Raw `PerformanceObserver` | Inspect one page session during debugging |

Do not route performance through Chrome DevTools MCP's `lighthouse_audit`; that capability intentionally covers non-performance Lighthouse categories. Do not compare a single lab value directly with a field p75 as if they were equivalent samples.

When adding or reviewing production collection, read [the first-party RUM reference](../performance/references/RUM.md). Prefer the `web-vitals` library because raw browser APIs do not by themselves implement every Core Web Vital's lifecycle and reporting rules.

---

## Framework quick fixes

### Next.js
```jsx
// LCP: Use next/image with priority
import Image from 'next/image';
<Image src="/hero.jpg" priority fill alt="Hero" />

// INP: Use dynamic imports
const HeavyComponent = dynamic(() => import('./Heavy'), { ssr: false });

// CLS: Image component handles dimensions automatically
```

### React
```jsx
// LCP: Preload in head
<link rel="preload" href="/hero.jpg" as="image" fetchpriority="high" />

// INP: Memoize and useTransition
const [isPending, startTransition] = useTransition();
startTransition(() => setExpensiveState(newValue));

// CLS: Always specify dimensions in img tags
```

### Vue/Nuxt
```vue
<!-- LCP: Use nuxt/image with preload -->
<NuxtImg src="/hero.jpg" preload loading="eager" />

<!-- INP: Use async components -->
<component :is="() => import('./Heavy.vue')" />

<!-- CLS: Use aspect-ratio CSS -->
<img :style="{ aspectRatio: '16/9' }" />
```

## References

- [Detailed LCP optimization](references/LCP.md) — read when an LCP trace points to discovery, loading, or render delay
- [Detailed INP optimization](references/INP.md) — read when a trace or field attribution identifies a slow interaction
- [Detailed CLS optimization](references/CLS.md) — read when a trace or field attribution identifies unexpected shifts
- [web.dev LCP](https://web.dev/articles/lcp)
- [web.dev INP](https://web.dev/articles/inp)
- [web.dev CLS](https://web.dev/articles/cls)
- [Performance skill](../performance/SKILL.md)
````

### `/tmp/or-atom-008-corpus/web-quality/core-web-vitals/references/LCP.md`

````{txt}
# LCP optimization reference

## What is LCP?

Largest Contentful Paint (LCP) measures when the largest content element in the viewport becomes visible. This is typically:

- An `<img>` element
- An `<image>` element inside `<svg>`
- A `<video>` element with poster image
- An element with a background image via `url()`
- A block-level element containing text nodes

## LCP timeline

```
[  Server Response  ][  Resource Load  ][  Render  ]
       TTFB              Download         Paint
       └─────────────────────────────────────┘
                         LCP Time
```

## Detailed optimizations

### 1. Server response time (TTFB)

Target: < 800ms

**Causes:**
- Slow server/database queries
- No CDN/edge caching
- Inefficient backend code
- Cold starts (serverless)

**Solutions:**
```javascript
// Use edge functions for dynamic content
// Vercel example
export const config = { runtime: 'edge' };

// Use stale-while-revalidate caching
// Cache-Control header
res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
```

### 2. Resource load time

**For images:**
```html
<!-- Preload only when a trace shows the LCP image is discovered late -->
<link rel="preload" as="image" href="/hero.webp"
      imagesrcset="/hero-400.webp 400w, /hero-800.webp 800w"
      imagesizes="100vw"
      fetchpriority="high">

<!-- Modern format with fallback -->
<picture>
  <source srcset="/hero.avif" type="image/avif">
  <source srcset="/hero.webp" type="image/webp">
  <img src="/hero.jpg" width="1200" height="600"
       fetchpriority="high" alt="Hero">
</picture>
```

**For text (web fonts):**
```css
@font-face {
  font-family: 'Heading';
  src: url('/fonts/heading.woff2') format('woff2');
  font-display: swap; /* Show fallback immediately */
}
```

### 3. Render blocking resources

**Critical CSS pattern:**
```html
<head>
  <!-- Inline critical CSS -->
  <style>
    /* Only above-fold styles, < 14KB */
    .hero { /* ... */ }
    .nav { /* ... */ }
  </style>

  <!-- Defer non-critical CSS -->
  <link rel="preload" href="/styles.css" as="style"
        onload="this.onload=null;this.rel='stylesheet'">
</head>
```

**Defer JavaScript:**
```html
<!-- ❌ Blocks parsing -->
<script src="/app.js"></script>

<!-- ✅ Deferred (runs after HTML parsed) -->
<script defer src="/app.js"></script>

<!-- ✅ Module (deferred by default) -->
<script type="module" src="/app.mjs"></script>
```

### 4. Client-side rendering

**Problem:** Content not in initial HTML.

**Solutions:**

**Server-side rendering (SSR):**
```javascript
// Next.js
export async function getServerSideProps() {
  const data = await fetchHeroContent();
  return { props: { hero: data } };
}
```

**Static site generation (SSG):**
```javascript
// Next.js
export async function getStaticProps() {
  const data = await fetchHeroContent();
  return { props: { hero: data }, revalidate: 3600 };
}
```

**Streaming SSR:**
```jsx
// React 18+
import { Suspense } from 'react';

function Page() {
  return (
    <Suspense fallback={<HeroSkeleton />}>
      <Hero />
    </Suspense>
  );
}
```

## Framework-specific tips

### Next.js
```jsx
import Image from 'next/image';

// LCP image with priority
<Image
  src="/hero.jpg"
  priority
  fill
  sizes="100vw"
  alt="Hero"
/>
```

### Nuxt
```vue
<NuxtImg
  src="/hero.jpg"
  preload
  loading="eager"
  sizes="100vw"
/>
```

### Astro
```astro
---
import { Image } from 'astro:assets';
import hero from '../assets/hero.jpg';
---
<Image
  src={hero}
  loading="eager"
  decoding="sync"
  alt="Hero"
/>
```

## Debugging LCP

```javascript
// Identify LCP element
new PerformanceObserver((entryList) => {
  const entries = entryList.getEntries();
  const lastEntry = entries[entries.length - 1];

  console.log('LCP:', {
    element: lastEntry.element,
    time: lastEntry.startTime,
    size: lastEntry.size,
    url: lastEntry.url,
    renderTime: lastEntry.renderTime,
    loadTime: lastEntry.loadTime
  });
}).observe({ type: 'largest-contentful-paint', buffered: true });
```

## Common issues

| Issue | Evidence to confirm | Typical fix |
|-------|---------------------|-------------|
| LCP resource discovered late | Large resource load delay in `LCPBreakdown` or `LCPDiscovery` | Put it in initial HTML, add priority, and preload only when still necessary |
| Large image transfer | Resource load duration and response bytes dominate | Resize/compress and choose an appropriate format |
| Render-blocking CSS | `RenderBlocking` insight and long render delay | Remove unused rules, split non-critical CSS, or inline only proven critical CSS |
| Slow TTFB | `DocumentLatency` insight or LCP TTFB subpart dominates | Cache, reduce redirects, or optimize server work |
| Client-rendered LCP | LCP element absent from initial HTML and render delay dominates | SSR, static rendering, or earlier rendering |

Do not attach generic millisecond savings to these fixes. Measure the relevant LCP subpart before and after under equivalent conditions.
````

### `/tmp/or-atom-008-corpus/web-quality/core-web-vitals/references/INP.md`

````{txt}
# Interaction to Next Paint (INP)

Read this reference when field INP is poor, a trace identifies a slow interaction, or source inspection finds interaction work that needs runtime verification.

## Diagnose the interaction phases

INP spans three phases. Do not optimize the event handler until the trace shows which phase dominates.

| Phase | Evidence to inspect | Typical fixes |
|-------|---------------------|---------------|
| Input delay | Long tasks already occupying the main thread before the event callback starts | Reduce startup work, split long tasks, delay third parties |
| Processing time | Event callbacks and synchronous work attached to the interaction | Remove unnecessary work, simplify handlers, use workers for CPU-heavy computation |
| Presentation delay | Style, layout, paint, or later main-thread work before the next frame | Reduce DOM scope, rendering cost, and layout invalidation |

## Yield long work

**Bad:**

```javascript
function processLargeArray(items) {
  items.forEach(item => expensiveOperation(item));
}
```

**Good:**

```javascript
async function processLargeArray(items) {
  const chunkSize = 100;

  for (let i = 0; i < items.length; i += chunkSize) {
    items.slice(i, i + chunkSize).forEach(expensiveOperation);

    if ('scheduler' in window && 'yield' in scheduler) {
      await scheduler.yield();
    } else {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}
```

Choose chunk boundaries from trace evidence. A fixed item count does not guarantee an acceptable task duration on representative devices.

## Prioritize visible feedback

**Bad:**

```javascript
button.addEventListener('click', () => {
  const result = calculateComplexThing();
  updateUI(result);
  trackEvent('click');
});
```

**Good:**

```javascript
button.addEventListener('click', async () => {
  button.classList.add('loading');

  if ('scheduler' in window && 'yield' in scheduler) {
    await scheduler.yield();
  }

  const result = calculateComplexThing();
  updateUI(result);

  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => trackEvent('click'));
  } else {
    setTimeout(() => trackEvent('click'), 0);
  }
});
```

Yielding helps only when the UI update can paint before the remaining work. Confirm the frame in the trace.

## Check common causes

* **Third-party code.** Attribute long tasks to their script URLs. Delay nonessential widgets until interaction or visibility, but avoid making the first user interaction pay the full initialization cost without feedback.
* **Framework rendering.** Profile the affected state transition. Memoization is useful only when it removes measured repeated work; do not apply it indiscriminately.
* **Large DOM updates.** Reduce the number of invalidated nodes and avoid forced synchronous layout caused by interleaved reads and writes.
* **CPU-heavy computation.** Move suitable work to a Web Worker and measure serialization overhead.

## Inspect one browser session

This observer reports interactions seen in the current page session. It is not field INP.

```javascript
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.duration > 200) {
      console.warn('Slow interaction', {
        type: entry.name,
        duration: entry.duration,
        processingStart: entry.processingStart,
        processingEnd: entry.processingEnd,
        target: entry.target
      });
    }
  }
}).observe({ type: 'event', buffered: true, durationThreshold: 40 });
```

For production attribution, prefer the `web-vitals/attribution` build. Its `onINP()` attribution can identify the interaction target, event type, and Long Animation Frame or script evidence available for real visits.

## Verification checklist

- [ ] Reproduce the important interaction on a representative device or CPU profile
- [ ] Identify the dominant input, processing, or presentation phase
- [ ] Confirm which first- or third-party task owns the delay
- [ ] Provide visible feedback before deferred work where appropriate
- [ ] Re-run the same interaction and conditions after the fix
- [ ] Wait for new first-party RUM or CrUX visits before claiming field improvement

## Sources

* [Optimize INP](https://web.dev/articles/optimize-inp)
* [`scheduler.yield()`](https://web.dev/articles/optimize-long-tasks#scheduler-yield)
* [web-vitals attribution](https://github.com/GoogleChrome/web-vitals#attribution-build)
````

### `/tmp/or-atom-008-corpus/web-quality/core-web-vitals/references/CLS.md`

````{txt}
# Cumulative Layout Shift (CLS)

Read this reference when field CLS is poor, a performance trace reports layout shifts, or source inspection finds content that changes geometry without reserved space.

CLS scores unexpected shift clusters across a page visit. A layout-shift score is the `impact fraction × distance fraction`. Use the shifted-node and initiator evidence: the element that moved may be the victim of content inserted above it.

## Reserve media space

**Bad:**

```html
<img src="photo.jpg" alt="Photo">
<iframe src="https://video.example/embed/123" title="Demo"></iframe>
```

**Good:**

```html
<img src="photo.jpg" alt="Photo" width="800" height="600">

<div class="video-frame">
  <iframe src="https://video.example/embed/123" title="Demo"></iframe>
</div>
```

```css
.video-frame {
  aspect-ratio: 16 / 9;
}

.video-frame iframe {
  height: 100%;
  width: 100%;
}
```

Reserve a realistic minimum for ads and embeds whose final size can vary. A placeholder that later collapses can also shift content.

## Handle dynamic content deliberately

Do not insert banners, validation summaries, consent UI, or notifications above visible content without reserving space. Prefer an overlay, insert outside the active viewport, or allocate a stable container before the content arrives.

**Bad:**

```javascript
main.prepend(notification);
```

**Good:**

```javascript
const slot = document.querySelector('[data-notification-slot]');
slot.replaceChildren(notification);
```

The corresponding slot must already have appropriate reserved dimensions. Verify that responsive content and localization do not overflow it.

## Stabilize fonts

Use a fallback with similar metrics and tune it with `size-adjust`, `ascent-override`, `descent-override`, and `line-gap-override` when trace evidence attributes shifts to font replacement.

```css
@font-face {
  font-family: "Brand Fallback";
  src: local("Arial");
  size-adjust: 102%;
  ascent-override: 92%;
  descent-override: 24%;
  line-gap-override: 0%;
}
```

Do not copy these values to another font pair; derive them from the actual font metrics and test representative text.

## Animate without layout

Prefer `transform` and `opacity` for visual motion. Animating `height`, `width`, `top`, or `left` can trigger layout, but replacing them mechanically is not enough: confirm the transformed element does not obscure content or change the intended hit area.

```css
.toast {
  inset-block-start: 1rem;
  inset-inline-end: 1rem;
  position: fixed;
  transform: translateY(-150%);
  transition: transform 200ms;
}

.toast.is-visible {
  transform: translateY(0);
}
```

## Inspect one browser session

This observer reports shifts seen during the current page session. It is not the distribution of real visits.

```javascript
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (!entry.hadRecentInput) {
      console.log('Layout shift', entry.value);
      entry.sources?.forEach(source => {
        console.log('Shifted node', source.node);
        console.log('Previous rect', source.previousRect);
        console.log('Current rect', source.currentRect);
      });
    }
  }
}).observe({ type: 'layout-shift', buffered: true });
```

## Verification checklist

- [ ] Images and responsive media reserve intrinsic space
- [ ] Ads, embeds, and async components have stable containers
- [ ] Banners and validation messages do not displace visible content unexpectedly
- [ ] Font swaps use measured fallback metrics when they cause shifts
- [ ] Animations avoid unnecessary layout work
- [ ] The relevant page state and viewport are exercised, not only the initial load
- [ ] Field improvement is claimed only after new RUM or CrUX visits

## Sources

* [Optimize CLS](https://web.dev/articles/optimize-cls)
* [Debug layout shifts](https://developer.chrome.com/docs/devtools/performance/insights#cls-culprits)
* [CSS font metric overrides](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/size-adjust)
````

## Skill: accessibility (web-quality.zip, web-quality/accessibility/)

### `/tmp/or-atom-008-corpus/web-quality/accessibility/SKILL.md`

````{txt}
---
name: accessibility
description: Audit and improve web accessibility following WCAG 2.2 guidelines. Use when asked to "improve accessibility", "a11y audit", "WCAG compliance", "screen reader support", "keyboard navigation", or "make accessible".
license: MIT
metadata:
  version: "2.0"
---

# Accessibility (a11y)

Comprehensive accessibility guidelines based on WCAG 2.2 and Lighthouse accessibility audits. Goal: make content usable by everyone, including people with disabilities.

## Evidence-led audit workflow

When a rendered page is available:

1. Run a live Lighthouse Accessibility audit when that capability is available; with Chrome DevTools MCP, use `lighthouse_audit`. Use mobile navigation mode for a general public page or snapshot mode when reloading would lose authenticated or user-created state.
2. Use failed audit nodes to localize the relevant component or template instead of searching the whole repository for generic patterns.
3. Inspect a rendered accessibility-tree snapshot for names, roles, states, landmarks, and heading structure; with Chrome DevTools MCP, use `take_snapshot`. Exercise the affected flow with the keyboard.
4. Fix the source, then re-run the same audit and manual interaction.

If the live tools are unavailable, use Lighthouse CLI or axe for automated coverage and complete the same manual checks. Automated tools detect only a subset of accessibility barriers: a score of 100 is not WCAG conformance, and a low score does not replace issue-level evidence.

## WCAG Principles: POUR

| Principle | Description |
|-----------|-------------|
| **P**erceivable | Content can be perceived through different senses |
| **O**perable | Interface can be operated by all users |
| **U**nderstandable | Content and interface are understandable |
| **R**obust | Content works with assistive technologies |

## Conformance levels

| Level | Requirement | Target |
|-------|-------------|--------|
| **A** | Minimum accessibility | Must pass |
| **AA** | Standard compliance | Should pass (legal requirement in many jurisdictions) |
| **AAA** | Enhanced accessibility | Nice to have |

---

## Perceivable

### Text alternatives (1.1)

**Images require alt text:**
```html
<!-- ❌ Missing alt -->
<img src="chart.png">

<!-- ✅ Descriptive alt -->
<img src="chart.png" alt="Bar chart showing 40% increase in Q3 sales">

<!-- ✅ Decorative image (empty alt) -->
<img src="decorative-border.png" alt="" role="presentation">

<!-- ✅ Complex image with longer description -->
<figure>
  <img src="infographic.png" alt="2024 market trends infographic"
       aria-describedby="infographic-desc">
  <figcaption id="infographic-desc">
    <!-- Detailed description -->
  </figcaption>
</figure>
```

**Icon buttons need accessible names:**
```html
<!-- ❌ No accessible name -->
<button><svg><!-- menu icon --></svg></button>

<!-- ✅ Using aria-label -->
<button aria-label="Open menu">
  <svg aria-hidden="true"><!-- menu icon --></svg>
</button>

<!-- ✅ Using visually hidden text -->
<button>
  <svg aria-hidden="true"><!-- menu icon --></svg>
  <span class="visually-hidden">Open menu</span>
</button>
```

**Visually hidden class:**
```css
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

### Color contrast (1.4.3, 1.4.6)

| Text Size | AA minimum | AAA enhanced |
|-----------|------------|--------------|
| Normal text (< 18px / < 14px bold) | 4.5:1 | 7:1 |
| Large text (≥ 18px / ≥ 14px bold) | 3:1 | 4.5:1 |
| UI components & graphics | 3:1 | 3:1 |

```css
/* ❌ Low contrast (2.5:1) */
.low-contrast {
  color: #999;
  background: #fff;
}

/* ✅ Sufficient contrast (7:1) */
.high-contrast {
  color: #333;
  background: #fff;
}

/* ✅ Focus states need contrast too (3:1 against background, WCAG 1.4.11) */
:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
```

**Don't rely on color alone:**
```html
<!-- ❌ Only color indicates error -->
<input class="error-border">
<style>.error-border { border-color: red; }</style>

<!-- ✅ Color + icon + text -->
<div class="field-error">
  <input aria-invalid="true" aria-describedby="email-error">
  <span id="email-error" class="error-message">
    <svg aria-hidden="true"><!-- error icon --></svg>
    Please enter a valid email address
  </span>
</div>
```

### Media alternatives (1.2)

```html
<!-- Video with captions -->
<video controls>
  <source src="video.mp4" type="video/mp4">
  <track kind="captions" src="captions.vtt" srclang="en" label="English" default>
  <track kind="descriptions" src="descriptions.vtt" srclang="en" label="Descriptions">
</video>

<!-- Audio with transcript -->
<audio controls>
  <source src="podcast.mp3" type="audio/mp3">
</audio>
<details>
  <summary>Transcript</summary>
  <p>Full transcript text...</p>
</details>
```

---

## Operable

### Keyboard accessible (2.1)

**All functionality must be keyboard accessible.** Prefer native interactive elements — `<button>`, `<a href>`, and form controls handle Enter/Space activation, focus, and assistive-tech semantics for free. Only add manual keyboard handling when you cannot use a native element.

```html
<!-- ❌ Non-interactive element with click only: not focusable, no keyboard activation -->
<div class="card" onclick="handleAction()">Open</div>

<!-- ✅ Best: use a native button -->
<button type="button" onclick="handleAction()">Open</button>
```

```javascript
// ✅ When you MUST use a non-interactive element (e.g. div with role="button"),
// make it focusable AND handle keyboard activation. Do NOT add this to a native
// <button> — Enter/Space already fire click, so you'd double-trigger.
element.setAttribute('role', 'button');
element.setAttribute('tabindex', '0');
element.addEventListener('click', handleAction);
element.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    handleAction();
  }
});
```

**No keyboard traps.** Users must be able to Tab into and out of every component. Use the [modal focus trap pattern](references/A11Y-PATTERNS.md#modal-focus-trap) for dialogs—the native `<dialog>` element handles this automatically.

### Focus visible (2.4.7)

```css
/* ❌ Never remove focus outlines */
*:focus { outline: none; }

/* ✅ Use :focus-visible for keyboard-only focus */
:focus {
  outline: none;
}

:focus-visible {
  outline: 2px solid currentColor; /* inherits text color → already contrast-checked */
  outline-offset: 2px;
}

/* ✅ Or pick a brand color and verify ≥3:1 contrast against every background it lands on */
button:focus-visible {
  box-shadow: 0 0 0 3px rgba(0, 95, 204, 0.5);
}
```

### Focus not obscured (2.4.11) — new in 2.2

When an element receives keyboard focus, it must not be entirely hidden by other author-created content such as sticky headers, footers, or overlapping panels. At Level AAA (2.4.12), no part of the focused element may be hidden.

```css
/* ✅ Account for sticky headers when scrolling to focused elements */
:target {
  scroll-margin-top: 80px;
}

/* ✅ Ensure focused items clear fixed/sticky bars */
:focus {
  scroll-margin-top: 80px;
  scroll-margin-bottom: 60px;
}
```

### Skip links (2.4.1)

Provide a skip link so keyboard users can bypass repetitive navigation. See the [skip link pattern](references/A11Y-PATTERNS.md#skip-link) for full markup and styles.

### Target size (2.5.8) — new in 2.2

Interactive targets must be at least **24 × 24 CSS pixels** (AA). Exceptions: inline text links, elements where the browser controls the size, and targets where a 24px circle centered on the bounding box does not overlap another target.

```css
/* ✅ Minimum target size */
button,
[role="button"],
input[type="checkbox"] + label,
input[type="radio"] + label {
  min-width: 24px;
  min-height: 24px;
}

/* ✅ Comfortable target size (recommended 44×44) */
.touch-target {
  min-width: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
```

### Dragging movements (2.5.7) — new in 2.2

Any action that requires dragging must have a single-pointer alternative (e.g., buttons, inputs). See the [dragging movements pattern](references/A11Y-PATTERNS.md#dragging-movements) for a sortable-list example.

### Timing (2.2)

```javascript
// Allow users to extend time limits
function showSessionWarning() {
  const modal = createModal({
    title: 'Session Expiring',
    content: 'Your session will expire in 2 minutes.',
    actions: [
      { label: 'Extend session', action: extendSession },
      { label: 'Log out', action: logout }
    ],
    timeout: 120000
  });
}
```

### Motion (2.3)

```css
/* Respect reduced motion preference */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## Understandable

### Page language (3.1.1)

```html
<!-- ❌ No language specified -->
<html>

<!-- ✅ Language specified -->
<html lang="en">

<!-- ✅ Language changes within page -->
<p>The French word for hello is <span lang="fr">bonjour</span>.</p>
```

### Consistent navigation (3.2.3)

```html
<!-- Navigation should be consistent across pages -->
<nav aria-label="Main">
  <ul>
    <li><a href="/" aria-current="page">Home</a></li>
    <li><a href="/products">Products</a></li>
    <li><a href="/about">About</a></li>
  </ul>
</nav>
```

### Consistent help (3.2.6) — new in 2.2

If a help mechanism (contact info, chat widget, FAQ link, self-help option) is repeated across multiple pages, it must appear in the **same relative order** each time. Users who rely on consistent placement shouldn't have to hunt for help on every page.

### Form labels (3.3.2)

Every input needs a programmatically associated label. See the [form labels pattern](references/A11Y-PATTERNS.md#form-labels) for explicit, implicit, and instructional examples.

### Error handling (3.3.1, 3.3.3)

Announce errors to screen readers with `role="alert"` or `aria-live`, set `aria-invalid="true"` on invalid fields, and focus the first error on submit. See the [error handling pattern](references/A11Y-PATTERNS.md#error-handling) for full markup and JS.

### Redundant entry (3.3.7) — new in 2.2

Don't force users to re-enter information they already provided in the same session. Auto-populate from earlier steps, or let users select from previously entered values. Exceptions: security re-confirmation and content that has expired.

```html
<!-- ✅ Auto-fill shipping address from billing -->
<fieldset>
  <legend>Shipping address</legend>
  <label>
    <input type="checkbox" id="same-as-billing" checked>
    Same as billing address
  </label>
  <!-- Fields auto-populated when checked -->
</fieldset>
```

### Accessible authentication (3.3.8) — new in 2.2

Login flows must not rely on cognitive function tests (e.g., remembering a password, solving a puzzle) unless at least one of:
- A copy-paste or autofill mechanism is available
- An alternative method exists (e.g., passkey, SSO, email link)
- The test uses object recognition or personal content (AA only; AAA removes this exception)

```html
<!-- ✅ Allow paste in password fields -->
<input type="password" id="password" autocomplete="current-password">

<!-- ✅ Offer passwordless alternatives -->
<button type="button">Sign in with passkey</button>
<button type="button">Email me a login link</button>
```

---

## Robust

### ARIA usage (4.1.2)

**Prefer native elements:**
```html
<!-- ❌ ARIA role on div -->
<div role="button" tabindex="0">Click me</div>

<!-- ✅ Native button -->
<button>Click me</button>

<!-- ❌ ARIA checkbox -->
<div role="checkbox" aria-checked="false">Option</div>

<!-- ✅ Native checkbox -->
<label><input type="checkbox"> Option</label>
```

**When ARIA is needed,** use the correct roles and states. See the [ARIA tabs pattern](references/A11Y-PATTERNS.md#aria-tabs) for a complete tablist example.

### Live regions (4.1.3)

Use `aria-live` regions to announce dynamic content changes without moving focus. See the [live regions pattern](references/A11Y-PATTERNS.md#live-regions-and-notifications) for markup and a `showNotification()` helper.

---

## Testing checklist

### Automated testing

Prefer a live Lighthouse audit that returns failing rendered nodes directly to the agent. With Chrome DevTools MCP, this is `lighthouse_audit`. Otherwise:

```bash
# Lighthouse accessibility audit
npx lighthouse https://example.com --only-categories=accessibility

# axe-core
npm install @axe-core/cli -g
axe https://example.com
```

### Manual testing

- [ ] **Keyboard navigation:** Tab through entire page, use Enter/Space to activate
- [ ] **Screen reader:** Test with VoiceOver (Mac), NVDA (Windows), or TalkBack (Android)
- [ ] **Zoom:** Content usable at 200% zoom
- [ ] **High contrast:** Test with Windows High Contrast Mode
- [ ] **Reduced motion:** Test with `prefers-reduced-motion: reduce`
- [ ] **Focus order:** Logical and follows visual order
- [ ] **Target size:** Interactive elements meet 24×24px minimum

See the [screen reader commands reference](references/A11Y-PATTERNS.md#screen-reader-commands) for VoiceOver and NVDA shortcuts.

---

## Common issues by impact

### Critical (fix immediately)
1. Missing form labels
2. Missing image alt text
3. Insufficient color contrast
4. Keyboard traps
5. No focus indicators

### Serious (fix before launch)
1. Missing page language
2. Missing heading structure
3. Non-descriptive link text
4. Auto-playing media
5. Missing skip links

### Moderate (fix soon)
1. Missing ARIA labels on icons
2. Inconsistent navigation
3. Missing error identification
4. Timing without controls
5. Missing landmark regions

## References

- [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/)
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [Deque axe Rules](https://dequeuniversity.com/rules/axe/)
- [Web Quality Audit](../web-quality-audit/SKILL.md)
- [WCAG criteria reference](references/WCAG.md)
- [Accessibility code patterns](references/A11Y-PATTERNS.md)
````

### `/tmp/or-atom-008-corpus/web-quality/accessibility/references/WCAG.md`

````{txt}
# WCAG 2.2 Quick Reference

## Success criteria by level

### Level A (minimum)

| Criterion | Description |
|-----------|-------------|
| **1.1.1** Non-text Content | All images, icons have text alternatives |
| **1.2.1** Audio-only/Video-only | Provide transcript or audio description |
| **1.2.2** Captions | Video with audio has captions |
| **1.2.3** Audio Description | Video has audio description |
| **1.3.1** Info and Relationships | Information conveyed through presentation is available programmatically |
| **1.3.2** Meaningful Sequence | Reading order is logical |
| **1.3.3** Sensory Characteristics | Instructions don't rely solely on shape, color, size, location, orientation, or sound |
| **1.4.1** Use of Color | Color is not the only visual means of conveying information |
| **1.4.2** Audio Control | Audio playing automatically can be paused/stopped |
| **2.1.1** Keyboard | All functionality available via keyboard |
| **2.1.2** No Keyboard Trap | Keyboard focus can be moved away from any component |
| **2.1.4** Character Key Shortcuts | Single-key shortcuts can be turned off or remapped |
| **2.2.1** Timing Adjustable | Time limits can be extended |
| **2.2.2** Pause, Stop, Hide | Moving/blinking content can be paused |
| **2.3.1** Three Flashes | Nothing flashes more than 3 times per second |
| **2.4.1** Bypass Blocks | Skip link or landmark navigation available |
| **2.4.2** Page Titled | Pages have descriptive titles |
| **2.4.3** Focus Order | Focus order preserves meaning |
| **2.4.4** Link Purpose | Link purpose clear from link text or context |
| **2.5.1** Pointer Gestures | Multi-point gestures have single-pointer alternatives |
| **2.5.2** Pointer Cancellation | Down-event doesn't trigger action (use up-event or click) |
| **2.5.3** Label in Name | Accessible name contains visible label text |
| **2.5.4** Motion Actuation | Motion-triggered functions have alternatives |
| **3.1.1** Language of Page | Default language specified in HTML |
| **3.2.1** On Focus | Focus doesn't trigger unexpected changes |
| **3.2.2** On Input | Input doesn't trigger unexpected changes |
| **3.2.6** Consistent Help | Help mechanisms appear in the same relative order across pages |
| **3.3.1** Error Identification | Input errors clearly described |
| **3.3.2** Labels or Instructions | Form inputs have labels or instructions |
| **3.3.7** Redundant Entry | Information previously entered is auto-populated or available to select |
| **4.1.2** Name, Role, Value | UI components have accessible names and correct roles |

### Level AA (standard)

| Criterion | Description |
|-----------|-------------|
| **1.2.4** Captions (Live) | Live audio has captions |
| **1.2.5** Audio Description | Pre-recorded video has audio description |
| **1.3.4** Orientation | Content doesn't restrict orientation |
| **1.3.5** Identify Input Purpose | Input purpose can be programmatically determined |
| **1.4.3** Contrast (Minimum) | 4.5:1 for normal text, 3:1 for large text |
| **1.4.4** Resize Text | Text can be resized to 200% without loss of functionality |
| **1.4.5** Images of Text | Text used instead of images of text |
| **1.4.10** Reflow | Content reflows at 320px width without horizontal scroll |
| **1.4.11** Non-text Contrast | UI components have 3:1 contrast |
| **1.4.12** Text Spacing | Content adapts to text spacing changes |
| **1.4.13** Content on Hover/Focus | Additional content is dismissible, hoverable, persistent |
| **2.4.5** Multiple Ways | Multiple ways to find pages |
| **2.4.6** Headings and Labels | Headings and labels are descriptive |
| **2.4.7** Focus Visible | Focus indicator is visible |
| **2.4.11** Focus Not Obscured (Minimum) | Focused element is not entirely hidden by author-created content |
| **2.5.7** Dragging Movements | Dragging actions have single-pointer alternatives |
| **2.5.8** Target Size (Minimum) | Interactive targets are at least 24×24 CSS pixels (with exceptions) |
| **3.1.2** Language of Parts | Language changes are marked |
| **3.2.3** Consistent Navigation | Navigation is consistent across pages |
| **3.2.4** Consistent Identification | Same functionality uses same labels |
| **3.3.3** Error Suggestion | Error corrections suggested when known |
| **3.3.4** Error Prevention (Legal) | Actions can be reversed or confirmed |
| **3.3.8** Accessible Authentication (Minimum) | No cognitive function test for login unless an alternative or assistance is provided |
| **4.1.3** Status Messages | Status messages announced to screen readers |

### Level AAA (enhanced)

| Criterion | Description |
|-----------|-------------|
| **1.4.6** Contrast (Enhanced) | 7:1 for normal text, 4.5:1 for large text |
| **1.4.8** Visual Presentation | Foreground/background colors can be selected |
| **1.4.9** Images of Text (No Exception) | No images of text |
| **2.1.3** Keyboard (No Exception) | All functionality keyboard accessible |
| **2.2.3** No Timing | No time limits |
| **2.2.4** Interruptions | Interruptions can be postponed |
| **2.2.5** Re-authenticating | Data preserved on re-authentication |
| **2.2.6** Timeouts | Users warned about data loss from inactivity |
| **2.3.2** Three Flashes | No content flashes more than 3 times |
| **2.3.3** Animation from Interactions | Motion animation can be disabled |
| **2.4.8** Location | User location within site is available |
| **2.4.9** Link Purpose (Link Only) | Link purpose clear from link text alone |
| **2.4.10** Section Headings | Sections have headings |
| **2.4.12** Focus Not Obscured (Enhanced) | No part of the focused element is hidden by author-created content |
| **2.4.13** Focus Appearance | Focus indicator has sufficient area, contrast, and is not obscured |
| **3.1.3** Unusual Words | Definitions available for unusual words |
| **3.1.4** Abbreviations | Abbreviations expanded |
| **3.1.5** Reading Level | Alternative content for complex text |
| **3.1.6** Pronunciation | Pronunciation available where needed |
| **3.2.5** Change on Request | Changes initiated only by user |
| **3.3.5** Help | Context-sensitive help available |
| **3.3.6** Error Prevention (All) | All form submissions can be reviewed |
| **3.3.9** Accessible Authentication (Enhanced) | No cognitive function test for login (no object or personal content recognition exceptions) |

## Common ARIA patterns

### Buttons
```html
<button>Label</button>
<!-- or -->
<button aria-label="Close dialog">×</button>
```

### Links
```html
<a href="/page">Descriptive link text</a>
<!-- External links -->
<a href="https://external.com" target="_blank" rel="noopener">
  External site
  <span class="visually-hidden">(opens in new tab)</span>
</a>
```

### Form fields
```html
<label for="email">Email address</label>
<input type="email" id="email" aria-describedby="email-hint">
<p id="email-hint">We'll never share your email.</p>
```

### Error states
```html
<label for="email">Email</label>
<input type="email" id="email" aria-invalid="true" aria-describedby="email-error">
<p id="email-error" role="alert">Please enter a valid email address.</p>
```

### Navigation
```html
<nav aria-label="Main">
  <ul>
    <li><a href="/" aria-current="page">Home</a></li>
    <li><a href="/about">About</a></li>
  </ul>
</nav>
```

### Modals
```html
<div role="dialog" aria-modal="true" aria-labelledby="dialog-title">
  <h2 id="dialog-title">Confirm Action</h2>
  <!-- content -->
</div>
```

### Live regions
```html
<!-- Polite (waits for pause in speech) -->
<div aria-live="polite">Status update here</div>

<!-- Assertive (interrupts immediately) -->
<div aria-live="assertive" role="alert">Error message here</div>

<!-- Status (polite, implicit) -->
<div role="status">Loading complete</div>
```

## What changed from 2.1 to 2.2

| Change | Criterion | Level |
|--------|-----------|-------|
| **Removed** | 4.1.1 Parsing | A |
| **Added** | 2.4.11 Focus Not Obscured (Minimum) | AA |
| **Added** | 2.4.12 Focus Not Obscured (Enhanced) | AAA |
| **Added** | 2.4.13 Focus Appearance | AAA |
| **Added** | 2.5.7 Dragging Movements | AA |
| **Added** | 2.5.8 Target Size (Minimum) | AA |
| **Added** | 3.2.6 Consistent Help | A |
| **Added** | 3.3.7 Redundant Entry | A |
| **Added** | 3.3.8 Accessible Authentication (Minimum) | AA |
| **Added** | 3.3.9 Accessible Authentication (Enhanced) | AAA |

## Testing tools

| Tool | Type | URL |
|------|------|-----|
| axe DevTools | Browser extension | [deque.com/axe](https://www.deque.com/axe/) |
| WAVE | Browser extension | [wave.webaim.org](https://wave.webaim.org/) |
| Lighthouse | Built into Chrome | DevTools → Lighthouse |
| NVDA | Screen reader (Windows) | [nvaccess.org](https://www.nvaccess.org/) |
| VoiceOver | Screen reader (Mac) | Built into macOS |
| Colour Contrast Analyser | Desktop app | [tpgi.com](https://www.tpgi.com/color-contrast-checker/) |

## Sources

- [WCAG 2.2 W3C Recommendation](https://www.w3.org/TR/WCAG22/)
- [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/)
- [What's New in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)
````

### `/tmp/or-atom-008-corpus/web-quality/accessibility/references/A11Y-PATTERNS.md`

````{txt}
# Accessibility Code Patterns

Practical, copy-paste-ready patterns for common accessibility requirements. Each pattern is self-contained and linked from the main [SKILL.md](../SKILL.md).

---

## Modal focus trap

Trap keyboard focus inside a modal dialog so Tab/Shift+Tab cycle through its focusable elements and Escape closes it.

```javascript
function openModal(modal) {
  const focusableElements = modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];

  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    }
    if (e.key === 'Escape') {
      closeModal();
    }
  });

  firstElement.focus();
}
```

The native `<dialog>` element handles focus trapping automatically—prefer it when browser support allows.

---

## Skip link

Allows keyboard users to bypass repetitive navigation and jump straight to main content.

```html
<body>
  <a href="#main-content" class="skip-link">Skip to main content</a>
  <header><!-- navigation --></header>
  <main id="main-content" tabindex="-1">
    <!-- main content -->
  </main>
</body>
```

```css
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  background: #000;
  color: #fff;
  padding: 8px 16px;
  z-index: 100;
}

.skip-link:focus {
  top: 0;
}
```

---

## Error handling

Announce errors to screen readers and focus the first invalid field on submit.

```html
<form novalidate>
  <div class="field" aria-live="polite">
    <label for="email">Email</label>
    <input type="email" id="email"
           aria-invalid="true"
           aria-describedby="email-error">
    <p id="email-error" class="error" role="alert">
      Please enter a valid email address (e.g., name@example.com)
    </p>
  </div>
</form>
```

```javascript
form.addEventListener('submit', (e) => {
  const firstError = form.querySelector('[aria-invalid="true"]');
  if (firstError) {
    e.preventDefault();
    firstError.focus();

    const errorSummary = document.getElementById('error-summary');
    errorSummary.textContent =
      `${errors.length} errors found. Please fix them and try again.`;
    errorSummary.focus();
  }
});
```

---

## Form labels

Every input needs an associated label—either explicit (`for`/`id`) or implicit (wrapping `<label>`).

```html
<!-- ❌ No label association -->
<input type="email" placeholder="Email">

<!-- ✅ Explicit label -->
<label for="email">Email address</label>
<input type="email" id="email" name="email"
       autocomplete="email" required>

<!-- ✅ Implicit label -->
<label>
  Email address
  <input type="email" name="email" autocomplete="email" required>
</label>

<!-- ✅ With instructions -->
<label for="password">Password</label>
<input type="password" id="password"
       aria-describedby="password-requirements">
<p id="password-requirements">
  Must be at least 8 characters with one number.
</p>
```

---

## Dragging movements

Any action triggered by dragging must offer a single-pointer alternative (WCAG 2.5.7).

```html
<!-- ❌ Drag-only reorder -->
<ul class="sortable-list" draggable="true">
  <li>Item 1</li>
  <li>Item 2</li>
</ul>

<!-- ✅ Drag + button alternatives -->
<ul class="sortable-list">
  <li>
    <span>Item 1</span>
    <button aria-label="Move Item 1 up">↑</button>
    <button aria-label="Move Item 1 down">↓</button>
  </li>
  <li>
    <span>Item 2</span>
    <button aria-label="Move Item 2 up">↑</button>
    <button aria-label="Move Item 2 down">↓</button>
  </li>
</ul>
```

Also applies to sliders, map panning, colour pickers, and similar drag-based widgets—always provide an equivalent click/tap or keyboard path.

---

## ARIA tabs

Tabs require `role="tablist"`, `role="tab"`, and `role="tabpanel"` with proper `aria-selected`, `aria-controls`, and keyboard support.

```html
<div role="tablist" aria-label="Product information">
  <button role="tab" id="tab-1" aria-selected="true"
          aria-controls="panel-1">Description</button>
  <button role="tab" id="tab-2" aria-selected="false"
          aria-controls="panel-2" tabindex="-1">Reviews</button>
</div>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">
  <!-- Panel content -->
</div>
<div role="tabpanel" id="panel-2" aria-labelledby="tab-2" hidden>
  <!-- Panel content -->
</div>
```

Arrow keys should move focus between tabs; the active tab receives `tabindex="0"` while inactive tabs use `tabindex="-1"`.

---

## Live regions and notifications

Use `aria-live` to announce dynamic content changes to screen readers without moving focus.

```html
<!-- Status updates (polite — waits for pause in speech) -->
<div aria-live="polite" aria-atomic="true" class="status">
  <!-- Content updates announced to screen readers -->
</div>

<!-- Urgent alerts (assertive — interrupts) -->
<div role="alert" aria-live="assertive">
  <!-- Interrupts current announcement -->
</div>
```

```javascript
function showNotification(message, type = 'polite') {
  const container = document.getElementById(`${type}-announcer`);
  container.textContent = '';
  requestAnimationFrame(() => {
    container.textContent = message;
  });
}
```

Clear the container before writing to ensure the same message triggers a new announcement.

---

## Screen reader commands

Quick reference for the most common screen reader shortcuts.

| Action | VoiceOver (Mac) | NVDA (Windows) |
|--------|-----------------|----------------|
| Start/Stop | ⌘ + F5 | Ctrl + Alt + N |
| Next item | VO + → | ↓ |
| Previous item | VO + ← | ↑ |
| Activate | VO + Space | Enter |
| Headings list | VO + U, then arrows | H / Shift + H |
| Links list | VO + U | K / Shift + K |
````

## Skill: accessibility-compliance (engineering.zip, engineering/accessibility-compliance/)

### `/tmp/or-atom-008-corpus/engineering/accessibility-compliance/SKILL.md`

```{txt}
---
name: accessibility-compliance
description: Implement WCAG 2.2 compliant interfaces with mobile accessibility, inclusive design patterns, and assistive technology support. Use when auditing accessibility, implementing ARIA patterns, building for screen readers, or ensuring inclusive user experiences.
---

# Accessibility Compliance

Master accessibility implementation to create inclusive experiences that work for everyone, including users with disabilities.

## When to Use This Skill

- Implementing WCAG 2.2 Level AA or AAA compliance
- Building screen reader accessible interfaces
- Adding keyboard navigation to interactive components
- Implementing focus management and focus trapping
- Creating accessible forms with proper labeling
- Supporting reduced motion and high contrast preferences
- Building mobile accessibility features (iOS VoiceOver, Android TalkBack)
- Conducting accessibility audits and fixing violations

## Detailed patterns and worked examples

Detailed pattern documentation lives in `references/details.md`. Read that file when the navigation tier above is insufficient.

## Best Practices

1. **Use Semantic HTML**: Prefer native elements over ARIA when possible
2. **Test with Real Users**: Include people with disabilities in user testing
3. **Keyboard First**: Design interactions to work without a mouse
4. **Don't Disable Focus Styles**: Style them, don't remove them
5. **Provide Text Alternatives**: All non-text content needs descriptions
6. **Support Zoom**: Content should work at 200% zoom
7. **Announce Changes**: Use live regions for dynamic content
8. **Respect Preferences**: Honor prefers-reduced-motion and prefers-contrast

## Common Issues

- **Missing alt text**: Images without descriptions
- **Poor color contrast**: Text hard to read against background
- **Keyboard traps**: Focus stuck in component
- **Missing labels**: Form inputs without associated labels
- **Auto-playing media**: Content that plays without user initiation
- **Inaccessible custom controls**: Recreating native functionality poorly
- **Missing skip links**: No way to bypass repetitive content
- **Focus order issues**: Tab order doesn't match visual order

## Testing Tools

- **Automated**: axe DevTools, WAVE, Lighthouse
- **Manual**: VoiceOver (macOS/iOS), NVDA/JAWS (Windows), TalkBack (Android)
- **Simulators**: NoCoffee (vision), Silktide (various disabilities)
```

### `/tmp/or-atom-008-corpus/engineering/accessibility-compliance/references/wcag-guidelines.md`

````{txt}
# WCAG 2.2 Guidelines Reference

## Overview

The Web Content Accessibility Guidelines (WCAG) 2.2 provide recommendations for making web content more accessible. They are organized into four principles (POUR): Perceivable, Operable, Understandable, and Robust.

## Conformance Levels

- **Level A**: Minimum accessibility (must satisfy)
- **Level AA**: Standard accessibility (should satisfy)
- **Level AAA**: Enhanced accessibility (may satisfy)

Most organizations target Level AA compliance.

## Principle 1: Perceivable

Content must be presentable in ways users can perceive.

### 1.1 Text Alternatives

#### 1.1.1 Non-text Content (Level A)

All non-text content needs text alternatives.

```tsx
// Images
<img src="chart.png" alt="Q3 sales increased 25% compared to Q2" />

// Decorative images
<img src="decorative-line.svg" alt="" role="presentation" />

// Complex images with long descriptions
<figure>
  <img src="org-chart.png" alt="Organization chart" aria-describedby="org-desc" />
  <figcaption id="org-desc">
    The CEO reports to the board. Three VPs report to the CEO:
    VP Engineering, VP Sales, and VP Marketing...
  </figcaption>
</figure>

// Icons with meaning
<button aria-label="Delete item">
  <TrashIcon aria-hidden="true" />
</button>

// Icon buttons with visible text
<button>
  <DownloadIcon aria-hidden="true" />
  <span>Download</span>
</button>
```

### 1.2 Time-based Media

#### 1.2.1 Audio-only and Video-only (Level A)

```tsx
// Audio with transcript
<audio src="podcast.mp3" controls />
<details>
  <summary>View transcript</summary>
  <p>Full transcript text here...</p>
</details>

// Video with captions
<video controls>
  <source src="tutorial.mp4" type="video/mp4" />
  <track kind="captions" src="captions-en.vtt" srclang="en" label="English" />
  <track kind="subtitles" src="subtitles-es.vtt" srclang="es" label="Spanish" />
</video>
```

### 1.3 Adaptable

#### 1.3.1 Info and Relationships (Level A)

Structure and relationships must be programmatically determinable.

```tsx
// Proper heading hierarchy
<main>
  <h1>Page Title</h1>
  <section>
    <h2>Section Title</h2>
    <h3>Subsection</h3>
  </section>
</main>

// Data tables with headers
<table>
  <caption>Quarterly Sales Report</caption>
  <thead>
    <tr>
      <th scope="col">Product</th>
      <th scope="col">Q1</th>
      <th scope="col">Q2</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">Widget A</th>
      <td>$10,000</td>
      <td>$12,000</td>
    </tr>
  </tbody>
</table>

// Lists for grouped content
<nav aria-label="Main navigation">
  <ul>
    <li><a href="/">Home</a></li>
    <li><a href="/about">About</a></li>
    <li><a href="/contact">Contact</a></li>
  </ul>
</nav>
```

#### 1.3.5 Identify Input Purpose (Level AA)

```tsx
// Input with autocomplete for autofill
<form>
  <label htmlFor="name">Full Name</label>
  <input id="name" name="name" autoComplete="name" />

  <label htmlFor="email">Email</label>
  <input id="email" name="email" type="email" autoComplete="email" />

  <label htmlFor="phone">Phone</label>
  <input id="phone" name="phone" type="tel" autoComplete="tel" />

  <label htmlFor="address">Street Address</label>
  <input id="address" name="address" autoComplete="street-address" />

  <label htmlFor="cc">Credit Card Number</label>
  <input id="cc" name="cc" autoComplete="cc-number" />
</form>
```

### 1.4 Distinguishable

#### 1.4.1 Use of Color (Level A)

```tsx
// Bad: Color only indicates error
<input className={hasError ? 'border-red-500' : ''} />

// Good: Color plus icon and text
<div>
  <input
    className={hasError ? 'border-red-500' : ''}
    aria-invalid={hasError}
    aria-describedby={hasError ? 'error-message' : undefined}
  />
  {hasError && (
    <p id="error-message" className="text-red-500 flex items-center gap-1">
      <AlertIcon aria-hidden="true" />
      This field is required
    </p>
  )}
</div>
```

#### 1.4.3 Contrast (Minimum) (Level AA)

```css
/* Minimum contrast ratios */
/* Normal text: 4.5:1 */
/* Large text (18pt+ or 14pt bold+): 3:1 */

/* Good contrast examples */
.text-on-white {
  color: #595959; /* 7:1 ratio on white */
}

.text-on-dark {
  color: #ffffff;
  background: #333333; /* 12.6:1 ratio */
}

/* Link must be distinguishable from surrounding text */
.link {
  color: #0066cc; /* 4.5:1 on white */
  text-decoration: underline; /* Additional visual cue */
}
```

#### 1.4.11 Non-text Contrast (Level AA)

```css
/* UI components need 3:1 contrast */
.button {
  border: 2px solid #767676; /* 3:1 against white */
  background: white;
}

.input {
  border: 1px solid #767676;
}

.input:focus {
  outline: 2px solid #0066cc; /* Focus indicator needs 3:1 */
  outline-offset: 2px;
}

/* Custom checkbox */
.checkbox {
  border: 2px solid #767676;
}

.checkbox:checked {
  background: #0066cc;
  border-color: #0066cc;
}
```

#### 1.4.12 Text Spacing (Level AA)

Content must not be lost when user adjusts text spacing.

```css
/* Allow text spacing adjustments without breaking layout */
.content {
  /* Use relative units */
  line-height: 1.5; /* At least 1.5x font size */
  letter-spacing: 0.12em; /* Support for 0.12em */
  word-spacing: 0.16em; /* Support for 0.16em */

  /* Don't use fixed heights on text containers */
  min-height: auto;

  /* Allow wrapping */
  overflow-wrap: break-word;
}

/* Test with these values: */
/* Line height: 1.5x font size */
/* Letter spacing: 0.12em */
/* Word spacing: 0.16em */
/* Paragraph spacing: 2x font size */
```

#### 1.4.13 Content on Hover or Focus (Level AA)

```tsx
// Tooltip pattern
function Tooltip({ content, children }) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
      onFocus={() => setIsVisible(true)}
      onBlur={() => setIsVisible(false)}
    >
      {children}
      {isVisible && (
        <div
          role="tooltip"
          // Dismissible: user can close without moving pointer
          onKeyDown={(e) => e.key === "Escape" && setIsVisible(false)}
          // Hoverable: content stays visible when pointer moves to it
          onMouseEnter={() => setIsVisible(true)}
          onMouseLeave={() => setIsVisible(false)}
          // Persistent: stays until trigger loses focus/hover
        >
          {content}
        </div>
      )}
    </div>
  );
}
```

## Principle 2: Operable

Interface components must be operable by all users.

### 2.1 Keyboard Accessible

#### 2.1.1 Keyboard (Level A)

All functionality must be operable via keyboard.

```tsx
// Custom interactive element
function CustomButton({ onClick, children }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </div>
  );
}

// Better: just use a button
function BetterButton({ onClick, children }) {
  return <button onClick={onClick}>{children}</button>;
}
```

#### 2.1.2 No Keyboard Trap (Level A)

```tsx
// Modal with proper focus management
function Modal({ isOpen, onClose, children }) {
  const closeButtonRef = useRef(null);

  // Return focus on close
  useEffect(() => {
    if (!isOpen) return;

    const previousFocus = document.activeElement;
    closeButtonRef.current?.focus();

    return () => {
      (previousFocus as HTMLElement)?.focus();
    };
  }, [isOpen]);

  // Allow Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <FocusTrap>
      <div role="dialog" aria-modal="true">
        <button ref={closeButtonRef} onClick={onClose}>
          Close
        </button>
        {children}
      </div>
    </FocusTrap>
  );
}
```

### 2.4 Navigable

#### 2.4.1 Bypass Blocks (Level A)

```tsx
// Skip links
<body>
  <a href="#main" className="skip-link">
    Skip to main content
  </a>
  <a href="#nav" className="skip-link">
    Skip to navigation
  </a>

  <header>...</header>

  <nav id="nav" aria-label="Main">
    ...
  </nav>

  <main id="main" tabIndex={-1}>
    {/* Main content */}
  </main>
</body>
```

#### 2.4.4 Link Purpose (In Context) (Level A)

```tsx
// Bad: Ambiguous link text
<a href="/report">Click here</a>
<a href="/report">Read more</a>

// Good: Descriptive link text
<a href="/report">View quarterly sales report</a>

// Good: Context provides meaning
<article>
  <h2>Quarterly Sales Report</h2>
  <p>Sales increased by 25% this quarter...</p>
  <a href="/report">Read full report</a>
</article>

// Good: Visually hidden text for context
<a href="/report">
  Read more
  <span className="sr-only"> about quarterly sales report</span>
</a>
```

#### 2.4.7 Focus Visible (Level AA)

```css
/* Always show focus indicator */
:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}

/* Custom focus styles */
.button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--color-focus);
}

/* High visibility focus for links */
.link:focus-visible {
  outline: 3px solid var(--color-focus);
  outline-offset: 2px;
  background: var(--color-focus-bg);
}
```

### 2.5 Input Modalities (New in 2.2)

#### 2.5.8 Target Size (Minimum) (Level AA) - NEW

Interactive targets must be at least 24x24 CSS pixels.

```css
/* Minimum target size */
.interactive {
  min-width: 24px;
  min-height: 24px;
}

/* Recommended size for touch (44x44) */
.touch-target {
  min-width: 44px;
  min-height: 44px;
}

/* Inline links are exempt if they have adequate spacing */
.link {
  /* Inline text links don't need minimum size */
  /* but should have adequate line-height */
  line-height: 1.5;
}
```

## Principle 3: Understandable

Content and interface must be understandable.

### 3.1 Readable

#### 3.1.1 Language of Page (Level A)

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    ...
  </head>
  <body>
    ...
  </body>
</html>
```

#### 3.1.2 Language of Parts (Level AA)

```tsx
<p>
  The French phrase <span lang="fr">c'est la vie</span> means "that's life."
</p>
```

### 3.2 Predictable

#### 3.2.2 On Input (Level A)

Don't automatically change context on input.

```tsx
// Bad: Auto-submit on selection
<select onChange={(e) => form.submit()}>
  <option>Select country</option>
</select>

// Good: Explicit submit action
<select onChange={(e) => setCountry(e.target.value)}>
  <option>Select country</option>
</select>
<button type="submit">Continue</button>
```

### 3.3 Input Assistance

#### 3.3.1 Error Identification (Level A)

```tsx
function FormField({ id, label, error, ...props }) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
```

#### 3.3.7 Redundant Entry (Level A) - NEW

Don't require users to re-enter previously provided information.

```tsx
// Auto-fill shipping address from billing
function CheckoutForm() {
  const [sameAsBilling, setSameAsBilling] = useState(false);
  const [billing, setBilling] = useState({});
  const [shipping, setShipping] = useState({});

  return (
    <form>
      <fieldset>
        <legend>Billing Address</legend>
        <AddressFields value={billing} onChange={setBilling} />
      </fieldset>

      <label>
        <input
          type="checkbox"
          checked={sameAsBilling}
          onChange={(e) => {
            setSameAsBilling(e.target.checked);
            if (e.target.checked) setShipping(billing);
          }}
        />
        Shipping same as billing
      </label>

      {!sameAsBilling && (
        <fieldset>
          <legend>Shipping Address</legend>
          <AddressFields value={shipping} onChange={setShipping} />
        </fieldset>
      )}
    </form>
  );
}
```

## Principle 4: Robust

Content must be robust enough for assistive technologies.

### 4.1 Compatible

#### 4.1.2 Name, Role, Value (Level A)

```tsx
// Custom components must expose name, role, and value
function CustomCheckbox({ checked, onChange, label }) {
  return (
    <button
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      {checked ? "✓" : "○"} {label}
    </button>
  );
}

// Custom slider
function CustomSlider({ value, min, max, label, onChange }) {
  return (
    <div
      role="slider"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onChange(Math.min(value + 1, max));
        if (e.key === "ArrowLeft") onChange(Math.max(value - 1, min));
      }}
    >
      <div style={{ width: `${((value - min) / (max - min)) * 100}%` }} />
    </div>
  );
}
```

## Testing Checklist

```markdown
## Keyboard Testing

- [ ] All interactive elements focusable with Tab
- [ ] Focus order matches visual order
- [ ] Focus indicator always visible
- [ ] No keyboard traps
- [ ] Escape closes modals/dropdowns
- [ ] Enter/Space activates buttons and links

## Screen Reader Testing

- [ ] All images have alt text
- [ ] Form inputs have labels
- [ ] Headings in logical order
- [ ] Landmarks present (main, nav, header, footer)
- [ ] Dynamic content announced
- [ ] Error messages announced

## Visual Testing

- [ ] Text contrast at least 4.5:1
- [ ] UI component contrast at least 3:1
- [ ] Works at 200% zoom
- [ ] Content readable with text spacing
- [ ] Focus indicators visible
- [ ] Color not sole indicator of meaning
```

## Resources

- [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/)
- [Understanding WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/)
- [Techniques for WCAG 2.2](https://www.w3.org/WAI/WCAG22/Techniques/)
````

### `/tmp/or-atom-008-corpus/engineering/accessibility-compliance/references/aria-patterns.md`

````{txt}
# ARIA Patterns and Best Practices

## Overview

ARIA (Accessible Rich Internet Applications) provides attributes to enhance accessibility when native HTML semantics are insufficient. The first rule of ARIA is: don't use ARIA if native HTML can do the job.

## ARIA Fundamentals

### Roles

Roles define what an element is or does.

```tsx
// Widget roles
<div role="button">Click me</div>
<div role="checkbox" aria-checked="true">Option</div>
<div role="slider" aria-valuenow="50">Volume</div>

// Landmark roles (prefer semantic HTML)
<div role="main">...</div>      // Better: <main>
<div role="navigation">...</div> // Better: <nav>
<div role="banner">...</div>     // Better: <header>

// Document structure roles
<div role="region" aria-label="Featured">...</div>
<div role="group" aria-label="Formatting options">...</div>
```

### States and Properties

States indicate current conditions; properties describe relationships.

```tsx
// States (can change)
aria-checked="true|false|mixed"
aria-disabled="true|false"
aria-expanded="true|false"
aria-hidden="true|false"
aria-pressed="true|false"
aria-selected="true|false"

// Properties (usually static)
aria-label="Accessible name"
aria-labelledby="id-of-label"
aria-describedby="id-of-description"
aria-controls="id-of-controlled-element"
aria-owns="id-of-owned-element"
aria-live="polite|assertive|off"
```

## Common ARIA Patterns

### Accordion

```tsx
function Accordion({ items }) {
  const [openIndex, setOpenIndex] = useState(-1);

  return (
    <div className="accordion">
      {items.map((item, index) => {
        const isOpen = openIndex === index;
        const headingId = `accordion-heading-${index}`;
        const panelId = `accordion-panel-${index}`;

        return (
          <div key={index}>
            <h3>
              <button
                id={headingId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenIndex(isOpen ? -1 : index)}
              >
                {item.title}
                <span aria-hidden="true">{isOpen ? "−" : "+"}</span>
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={headingId}
              hidden={!isOpen}
            >
              {item.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

### Tabs

```tsx
function Tabs({ tabs }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const tabListRef = useRef(null);

  const handleKeyDown = (e, index) => {
    let newIndex = index;

    switch (e.key) {
      case "ArrowRight":
        newIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        newIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        newIndex = 0;
        break;
      case "End":
        newIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    e.preventDefault();
    setActiveIndex(newIndex);
    tabListRef.current?.children[newIndex]?.focus();
  };

  return (
    <div>
      <div role="tablist" ref={tabListRef} aria-label="Content tabs">
        {tabs.map((tab, index) => (
          <button
            key={index}
            role="tab"
            id={`tab-${index}`}
            aria-selected={index === activeIndex}
            aria-controls={`panel-${index}`}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => setActiveIndex(index)}
            onKeyDown={(e) => handleKeyDown(e, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {tabs.map((tab, index) => (
        <div
          key={index}
          role="tabpanel"
          id={`panel-${index}`}
          aria-labelledby={`tab-${index}`}
          hidden={index !== activeIndex}
          tabIndex={0}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
```

### Menu Button

```tsx
function MenuButton({ label, items }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  const handleKeyDown = (e) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          setActiveIndex(0);
        } else {
          setActiveIndex((prev) => Math.min(prev + 1, items.length - 1));
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        break;
      case "Escape":
        setIsOpen(false);
        buttonRef.current?.focus();
        break;
      case "Enter":
      case " ":
        if (isOpen && activeIndex >= 0) {
          e.preventDefault();
          items[activeIndex].onClick();
          setIsOpen(false);
        }
        break;
    }
  };

  // Focus management
  useEffect(() => {
    if (isOpen && activeIndex >= 0) {
      menuRef.current?.children[activeIndex]?.focus();
    }
  }, [isOpen, activeIndex]);

  return (
    <div>
      <button
        ref={buttonRef}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
      >
        {label}
      </button>

      {isOpen && (
        <ul
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={handleKeyDown}
        >
          {items.map((item, index) => (
            <li
              key={index}
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                item.onClick();
                setIsOpen(false);
                buttonRef.current?.focus();
              }}
            >
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

### Combobox (Autocomplete)

```tsx
function Combobox({ options, onSelect, placeholder }) {
  const [inputValue, setInputValue] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef(null);
  const listboxId = useId();

  const filteredOptions = options.filter((opt) =>
    opt.toLowerCase().includes(inputValue.toLowerCase()),
  );

  const handleKeyDown = (e) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setIsOpen(true);
        setActiveIndex((prev) =>
          Math.min(prev + 1, filteredOptions.length - 1),
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        break;
      case "Enter":
        if (activeIndex >= 0) {
          e.preventDefault();
          selectOption(filteredOptions[activeIndex]);
        }
        break;
      case "Escape":
        setIsOpen(false);
        setActiveIndex(-1);
        break;
    }
  };

  const selectOption = (option) => {
    setInputValue(option);
    onSelect(option);
    setIsOpen(false);
    setActiveIndex(-1);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-activedescendant={
          activeIndex >= 0 ? `option-${activeIndex}` : undefined
        }
        aria-autocomplete="list"
        value={inputValue}
        placeholder={placeholder}
        onChange={(e) => {
          setInputValue(e.target.value);
          setIsOpen(true);
          setActiveIndex(-1);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setTimeout(() => setIsOpen(false), 200)}
      />

      {isOpen && filteredOptions.length > 0 && (
        <ul id={listboxId} role="listbox">
          {filteredOptions.map((option, index) => (
            <li
              key={option}
              id={`option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => selectOption(option)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

### Alert Dialog

```tsx
function AlertDialog({ isOpen, onConfirm, onCancel, title, message }) {
  const confirmRef = useRef(null);
  const dialogId = useId();
  const titleId = `${dialogId}-title`;
  const descId = `${dialogId}-desc`;

  useEffect(() => {
    if (isOpen) {
      confirmRef.current?.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <FocusTrap>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <div className="backdrop" onClick={onCancel} />

        <div className="dialog">
          <h2 id={titleId}>{title}</h2>
          <p id={descId}>{message}</p>

          <div className="actions">
            <button onClick={onCancel}>Cancel</button>
            <button ref={confirmRef} onClick={onConfirm}>
              Confirm
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>
  );
}
```

### Toolbar

```tsx
function Toolbar({ items }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const toolbarRef = useRef(null);

  const handleKeyDown = (e) => {
    let newIndex = activeIndex;

    switch (e.key) {
      case "ArrowRight":
        newIndex = (activeIndex + 1) % items.length;
        break;
      case "ArrowLeft":
        newIndex = (activeIndex - 1 + items.length) % items.length;
        break;
      case "Home":
        newIndex = 0;
        break;
      case "End":
        newIndex = items.length - 1;
        break;
      default:
        return;
    }

    e.preventDefault();
    setActiveIndex(newIndex);
    toolbarRef.current?.querySelectorAll("button")[newIndex]?.focus();
  };

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Text formatting"
      onKeyDown={handleKeyDown}
    >
      {items.map((item, index) => (
        <button
          key={index}
          tabIndex={index === activeIndex ? 0 : -1}
          aria-pressed={item.isActive}
          aria-label={item.label}
          onClick={item.onClick}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}
```

## Live Regions

### Polite Announcements

```tsx
// Status messages that don't interrupt
function SearchStatus({ count, query }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {count} results found for "{query}"
    </div>
  );
}

// Progress indicator
function LoadingStatus({ progress }) {
  return (
    <div role="status" aria-live="polite">
      Loading: {progress}% complete
    </div>
  );
}
```

### Assertive Announcements

```tsx
// Important errors that should interrupt
function ErrorAlert({ message }) {
  return (
    <div role="alert" aria-live="assertive">
      Error: {message}
    </div>
  );
}

// Form validation summary
function ValidationSummary({ errors }) {
  if (errors.length === 0) return null;

  return (
    <div role="alert" aria-live="assertive">
      <h2>Please fix the following errors:</h2>
      <ul>
        {errors.map((error, index) => (
          <li key={index}>{error}</li>
        ))}
      </ul>
    </div>
  );
}
```

### Log Region

```tsx
// Chat messages or activity log
function ChatLog({ messages }) {
  return (
    <div role="log" aria-live="polite" aria-relevant="additions">
      {messages.map((msg) => (
        <div key={msg.id}>
          <span className="author">{msg.author}:</span>
          <span className="text">{msg.text}</span>
        </div>
      ))}
    </div>
  );
}
```

## Common Mistakes to Avoid

### 1. Redundant ARIA

```tsx
// Bad: role="button" on a button
<button role="button">Click me</button>

// Good: just use button
<button>Click me</button>

// Bad: aria-label duplicating visible text
<button aria-label="Submit form">Submit form</button>

// Good: just use visible text
<button>Submit form</button>
```

### 2. Invalid ARIA

```tsx
// Bad: aria-selected on non-selectable element
<div aria-selected="true">Item</div>

// Good: use with proper role
<div role="option" aria-selected="true">Item</div>

// Bad: aria-expanded without control relationship
<button aria-expanded="true">Menu</button>
<div>Menu content</div>

// Good: with aria-controls
<button aria-expanded="true" aria-controls="menu">Menu</button>
<div id="menu">Menu content</div>
```

### 3. Hidden Content Still Announced

```tsx
// Bad: visually hidden but still in accessibility tree
<div style={{ display: 'none' }}>Hidden content</div>

// Good: properly hidden
<div style={{ display: 'none' }} aria-hidden="true">Hidden content</div>

// Or just use display: none (implicitly hidden)
<div hidden>Hidden content</div>
```

## Resources

- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [ARIA in HTML](https://www.w3.org/TR/html-aria/)
- [Using ARIA](https://www.w3.org/TR/using-aria/)
````

### `/tmp/or-atom-008-corpus/engineering/accessibility-compliance/references/mobile-accessibility.md`

````{txt}
# Mobile Accessibility

## Overview

Mobile accessibility ensures apps work for users with disabilities on iOS and Android devices. This includes support for screen readers (VoiceOver, TalkBack), motor impairments, and various visual disabilities.

## Touch Target Sizing

### Minimum Sizes

```css
/* WCAG 2.2 Level AA: 24x24px minimum */
.interactive-element {
  min-width: 24px;
  min-height: 24px;
}

/* WCAG 2.2 Level AAA / Apple HIG / Material Design: 44x44dp */
.touch-target {
  min-width: 44px;
  min-height: 44px;
}

/* Android Material Design: 48x48dp recommended */
.android-touch-target {
  min-width: 48px;
  min-height: 48px;
}
```

### Touch Target Spacing

```tsx
// Ensure adequate spacing between touch targets
function ButtonGroup({ buttons }) {
  return (
    <div className="flex gap-3">
      {" "}
      {/* 12px minimum gap */}
      {buttons.map((btn) => (
        <button key={btn.id} className="min-w-[44px] min-h-[44px] px-4 py-2">
          {btn.label}
        </button>
      ))}
    </div>
  );
}

// Expanding hit area without changing visual size
function IconButton({ icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="relative p-3" // Creates 44x44 touch area
    >
      <span className="block w-5 h-5">{icon}</span>
    </button>
  );
}
```

## iOS VoiceOver

### React Native Accessibility Props

```tsx
import { View, Text, TouchableOpacity, AccessibilityInfo } from "react-native";

// Basic accessible button
function AccessibleButton({ onPress, title, hint }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessible={true}
      accessibilityLabel={title}
      accessibilityHint={hint}
      accessibilityRole="button"
    >
      <Text>{title}</Text>
    </TouchableOpacity>
  );
}

// Complex component with grouped content
function ProductCard({ product }) {
  return (
    <View
      accessible={true}
      accessibilityLabel={`${product.name}, ${product.price}, ${product.rating} stars`}
      accessibilityRole="button"
      accessibilityActions={[
        { name: "activate", label: "View details" },
        { name: "addToCart", label: "Add to cart" },
      ]}
      onAccessibilityAction={(event) => {
        switch (event.nativeEvent.actionName) {
          case "addToCart":
            addToCart(product);
            break;
          case "activate":
            viewDetails(product);
            break;
        }
      }}
    >
      <Image source={product.image} accessibilityIgnoresInvertColors />
      <Text>{product.name}</Text>
      <Text>{product.price}</Text>
    </View>
  );
}

// Announcing dynamic changes
function Counter() {
  const [count, setCount] = useState(0);

  const increment = () => {
    setCount((prev) => prev + 1);
    AccessibilityInfo.announceForAccessibility(`Count is now ${count + 1}`);
  };

  return (
    <View>
      <Text accessibilityRole="text" accessibilityLiveRegion="polite">
        Count: {count}
      </Text>
      <TouchableOpacity
        onPress={increment}
        accessibilityLabel="Increment"
        accessibilityHint="Increases the counter by one"
      >
        <Text>+</Text>
      </TouchableOpacity>
    </View>
  );
}
```

### SwiftUI Accessibility

```swift
import SwiftUI

struct AccessibleButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
        }
        .accessibilityLabel(title)
        .accessibilityHint("Double tap to activate")
        .accessibilityAddTraits(.isButton)
    }
}

struct ProductCard: View {
    let product: Product

    var body: some View {
        VStack {
            AsyncImage(url: product.imageURL)
                .accessibilityHidden(true) // Image is decorative

            Text(product.name)
            Text(product.price.formatted(.currency(code: "USD")))
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(product.name), \(product.price.formatted(.currency(code: "USD")))")
        .accessibilityHint("Double tap to view details")
        .accessibilityAction(named: "Add to cart") {
            addToCart(product)
        }
    }
}

// Custom accessibility rotor
struct DocumentView: View {
    let sections: [Section]

    var body: some View {
        ScrollView {
            ForEach(sections) { section in
                Text(section.title)
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Text(section.content)
            }
        }
        .accessibilityRotor("Headings") {
            ForEach(sections) { section in
                AccessibilityRotorEntry(section.title, id: section.id)
            }
        }
    }
}
```

## Android TalkBack

### Jetpack Compose Accessibility

```kotlin
import androidx.compose.ui.semantics.*

@Composable
fun AccessibleButton(
    onClick: () -> Unit,
    text: String,
    enabled: Boolean = true
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.semantics {
            contentDescription = text
            role = Role.Button
            if (!enabled) {
                disabled()
            }
        }
    ) {
        Text(text)
    }
}

@Composable
fun ProductCard(product: Product) {
    Card(
        modifier = Modifier
            .semantics(mergeDescendants = true) {
                contentDescription = "${product.name}, ${product.formattedPrice}"
                customActions = listOf(
                    CustomAccessibilityAction("Add to cart") {
                        addToCart(product)
                        true
                    }
                )
            }
            .clickable { navigateToDetails(product) }
    ) {
        Image(
            painter = painterResource(product.imageRes),
            contentDescription = null, // Decorative
            modifier = Modifier.semantics { invisibleToUser() }
        )
        Text(product.name)
        Text(product.formattedPrice)
    }
}

// Live region for dynamic content
@Composable
fun Counter() {
    var count by remember { mutableStateOf(0) }

    Column {
        Text(
            text = "Count: $count",
            modifier = Modifier.semantics {
                liveRegion = LiveRegionMode.Polite
            }
        )
        Button(onClick = { count++ }) {
            Text("Increment")
        }
    }
}

// Heading levels
@Composable
fun SectionHeader(title: String, level: Int) {
    Text(
        text = title,
        style = MaterialTheme.typography.headlineMedium,
        modifier = Modifier.semantics {
            heading()
            // Custom heading level (not built-in)
            testTag = "heading-$level"
        }
    )
}
```

### Android XML Views

```xml
<!-- Accessible button -->
<Button
    android:id="@+id/submit_button"
    android:layout_width="wrap_content"
    android:layout_height="48dp"
    android:minWidth="48dp"
    android:text="@string/submit"
    android:contentDescription="@string/submit_form" />

<!-- Grouped content -->
<LinearLayout
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:importantForAccessibility="yes"
    android:focusable="true"
    android:contentDescription="@string/product_description">

    <ImageView
        android:importantForAccessibility="no"
        android:src="@drawable/product" />

    <TextView
        android:text="@string/product_name"
        android:importantForAccessibility="no" />
</LinearLayout>

<!-- Live region -->
<TextView
    android:id="@+id/status"
    android:accessibilityLiveRegion="polite" />
```

```kotlin
// Kotlin accessibility
binding.submitButton.apply {
    contentDescription = getString(R.string.submit_form)
    accessibilityDelegate = object : View.AccessibilityDelegate() {
        override fun onInitializeAccessibilityNodeInfo(
            host: View,
            info: AccessibilityNodeInfo
        ) {
            super.onInitializeAccessibilityNodeInfo(host, info)
            info.addAction(
                AccessibilityNodeInfo.AccessibilityAction(
                    AccessibilityNodeInfo.ACTION_CLICK,
                    getString(R.string.submit_action)
                )
            )
        }
    }
}

// Announce changes
binding.counter.announceForAccessibility("Count updated to $count")
```

## Gesture Accessibility

### Alternative Gestures

```tsx
// React Native: Provide alternatives to complex gestures
function SwipeableCard({ item, onDelete }) {
  const [showDelete, setShowDelete] = useState(false);

  return (
    <View
      accessible={true}
      accessibilityActions={[{ name: "delete", label: "Delete item" }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "delete") {
          onDelete(item);
        }
      }}
    >
      <Swipeable
        renderRightActions={() => (
          <TouchableOpacity
            onPress={() => onDelete(item)}
            accessibilityLabel="Delete"
          >
            <Text>Delete</Text>
          </TouchableOpacity>
        )}
      >
        <Text>{item.title}</Text>
      </Swipeable>

      {/* Alternative for screen reader users */}
      <TouchableOpacity
        accessibilityLabel={`Delete ${item.title}`}
        onPress={() => onDelete(item)}
        style={{ position: "absolute", right: 0 }}
      >
        <Text>Delete</Text>
      </TouchableOpacity>
    </View>
  );
}
```

### Motion and Animation

```tsx
// Respect reduced motion preference
import { AccessibilityInfo } from "react-native";

function AnimatedComponent() {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);

    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );

    return () => subscription.remove();
  }, []);

  return (
    <Animated.View
      style={{
        transform: reduceMotion ? [] : [{ translateX: animatedValue }],
        opacity: reduceMotion ? 1 : animatedOpacity,
      }}
    >
      <Content />
    </Animated.View>
  );
}
```

## Dynamic Type / Text Scaling

### iOS Dynamic Type

```swift
// SwiftUI
Text("Hello, World!")
    .font(.body) // Automatically scales with Dynamic Type

Text("Fixed Size")
    .font(.system(size: 16, design: .default))
    .dynamicTypeSize(.large) // Cap at large

// Allow unlimited scaling
Text("Scalable")
    .font(.body)
    .minimumScaleFactor(0.5)
    .lineLimit(nil)
```

### Android Text Scaling

```xml
<!-- Use sp for text sizes -->
<TextView
    android:textSize="16sp"
    android:layout_width="wrap_content"
    android:layout_height="wrap_content" />

<!-- In styles.xml -->
<style name="TextAppearance.Body">
    <item name="android:textSize">16sp</item>
    <item name="android:lineHeight">24sp</item>
</style>
```

```kotlin
// Compose: Text automatically scales
Text(
    text = "Hello, World!",
    style = MaterialTheme.typography.bodyLarge
)

// Limit scaling if needed
Text(
    text = "Limited scaling",
    fontSize = 16.sp,
    maxLines = 2,
    overflow = TextOverflow.Ellipsis
)
```

### React Native Text Scaling

```tsx
import { Text, PixelRatio } from 'react-native';

// Allow text scaling (default)
<Text allowFontScaling={true}>Scalable text</Text>

// Limit maximum scale
<Text maxFontSizeMultiplier={1.5}>Limited scaling</Text>

// Disable scaling (use sparingly)
<Text allowFontScaling={false}>Fixed size</Text>

// Responsive font size
const scaledFontSize = (size: number) => {
  const scale = PixelRatio.getFontScale();
  return size * Math.min(scale, 1.5); // Cap at 1.5x
};
```

## Testing Checklist

```markdown
## VoiceOver (iOS) Testing

- [ ] All interactive elements have labels
- [ ] Swipe navigation covers all content in logical order
- [ ] Custom actions available for complex interactions
- [ ] Announcements made for dynamic content
- [ ] Headings navigable via rotor
- [ ] Images have appropriate descriptions or are hidden

## TalkBack (Android) Testing

- [ ] Focus order is logical
- [ ] Touch exploration works correctly
- [ ] Custom actions available
- [ ] Live regions announce updates
- [ ] Headings properly marked
- [ ] Grouped content read together

## Motor Accessibility

- [ ] Touch targets at least 44x44 points
- [ ] Adequate spacing between targets (8dp minimum)
- [ ] Alternatives to complex gestures
- [ ] No time-limited interactions

## Visual Accessibility

- [ ] Text scales to 200% without loss
- [ ] Content visible in high contrast mode
- [ ] Color not sole indicator
- [ ] Animations respect reduced motion
```

## Resources

- [Apple Accessibility Programming Guide](https://developer.apple.com/accessibility/)
- [Android Accessibility Developer Guide](https://developer.android.com/guide/topics/ui/accessibility)
- [React Native Accessibility](https://reactnative.dev/docs/accessibility)
- [Mobile Accessibility WCAG](https://www.w3.org/TR/mobile-accessibility-mapping/)
````

### `/tmp/or-atom-008-corpus/engineering/accessibility-compliance/references/details.md`

````{txt}
# accessibility-compliance — detailed patterns and worked examples

## Core Capabilities

### 1. WCAG 2.2 Guidelines

- Perceivable: Content must be presentable in different ways
- Operable: Interface must be navigable with keyboard and assistive tech
- Understandable: Content and operation must be clear
- Robust: Content must work with current and future assistive technologies

### 2. ARIA Patterns

- Roles: Define element purpose (button, dialog, navigation)
- States: Indicate current condition (expanded, selected, disabled)
- Properties: Describe relationships and additional info (labelledby, describedby)
- Live regions: Announce dynamic content changes

### 3. Keyboard Navigation

- Focus order and tab sequence
- Focus indicators and visible focus states
- Keyboard shortcuts and hotkeys
- Focus trapping for modals and dialogs

### 4. Screen Reader Support

- Semantic HTML structure
- Alternative text for images
- Proper heading hierarchy
- Skip links and landmarks

### 5. Mobile Accessibility

- Touch target sizing (44x44dp minimum)
- VoiceOver and TalkBack compatibility
- Gesture alternatives
- Dynamic Type support

## Quick Reference

### WCAG 2.2 Success Criteria Checklist

| Level | Criterion | Description                                          |
| ----- | --------- | ---------------------------------------------------- |
| A     | 1.1.1     | Non-text content has text alternatives               |
| A     | 1.3.1     | Info and relationships programmatically determinable |
| A     | 2.1.1     | All functionality keyboard accessible                |
| A     | 2.4.1     | Skip to main content mechanism                       |
| AA    | 1.4.3     | Contrast ratio 4.5:1 (text), 3:1 (large text)        |
| AA    | 1.4.11    | Non-text contrast 3:1                                |
| AA    | 2.4.7     | Focus visible                                        |
| AA    | 2.5.8     | Target size minimum 24x24px (NEW in 2.2)             |
| AAA   | 1.4.6     | Enhanced contrast 7:1                                |
| AAA   | 2.5.5     | Target size minimum 44x44px                          |

## Key Patterns

### Pattern 1: Accessible Button

```tsx
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
  isLoading?: boolean;
}

function AccessibleButton({
  children,
  variant = "primary",
  isLoading = false,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      // Disable when loading
      disabled={disabled || isLoading}
      // Announce loading state to screen readers
      aria-busy={isLoading}
      // Describe the button's current state
      aria-disabled={disabled || isLoading}
      className={cn(
        // Visible focus ring
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        // Minimum touch target size (44x44px)
        "min-h-[44px] min-w-[44px]",
        variant === "primary" && "bg-primary text-primary-foreground",
        (disabled || isLoading) && "opacity-50 cursor-not-allowed",
      )}
      {...props}
    >
      {isLoading ? (
        <>
          <span className="sr-only">Loading</span>
          <Spinner aria-hidden="true" />
        </>
      ) : (
        children
      )}
    </button>
  );
}
```

### Pattern 2: Accessible Modal Dialog

```tsx
import * as React from "react";
import { FocusTrap } from "@headlessui/react";

interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

function AccessibleDialog({ isOpen, onClose, title, children }: DialogProps) {
  const titleId = React.useId();
  const descriptionId = React.useId();

  // Close on Escape key
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Prevent body scroll when open
  React.useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Focus trap container */}
      <FocusTrap>
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <div className="bg-background rounded-lg shadow-lg max-w-md w-full p-6">
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            <div id={descriptionId}>{children}</div>
            <button
              onClick={onClose}
              className="absolute top-4 right-4"
              aria-label="Close dialog"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </FocusTrap>
    </div>
  );
}
```

### Pattern 3: Accessible Form

```tsx
function AccessibleForm() {
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  return (
    <form aria-describedby="form-errors" noValidate>
      {/* Error summary for screen readers */}
      {Object.keys(errors).length > 0 && (
        <div
          id="form-errors"
          role="alert"
          aria-live="assertive"
          className="bg-destructive/10 border border-destructive p-4 rounded-md mb-4"
        >
          <h2 className="font-semibold text-destructive">
            Please fix the following errors:
          </h2>
          <ul className="list-disc list-inside mt-2">
            {Object.entries(errors).map(([field, message]) => (
              <li key={field}>
                <a href={`#${field}`} className="underline">
                  {message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Required field with error */}
      <div className="space-y-2">
        <label htmlFor="email" className="block font-medium">
          Email address
          <span aria-hidden="true" className="text-destructive ml-1">
            *
          </span>
          <span className="sr-only">(required)</span>
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          aria-required="true"
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? "email-error" : "email-hint"}
          className={cn(
            "w-full px-3 py-2 border rounded-md",
            errors.email && "border-destructive",
          )}
        />
        {errors.email ? (
          <p id="email-error" className="text-sm text-destructive" role="alert">
            {errors.email}
          </p>
        ) : (
          <p id="email-hint" className="text-sm text-muted-foreground">
            We'll never share your email.
          </p>
        )}
      </div>

      <button type="submit" className="mt-4">
        Submit
      </button>
    </form>
  );
}
```

### Pattern 4: Skip Navigation Link

```tsx
function SkipLink() {
  return (
    <a
      href="#main-content"
      className={cn(
        // Hidden by default, visible on focus
        "sr-only focus:not-sr-only",
        "focus:absolute focus:top-4 focus:left-4 focus:z-50",
        "focus:bg-background focus:px-4 focus:py-2 focus:rounded-md",
        "focus:ring-2 focus:ring-primary",
      )}
    >
      Skip to main content
    </a>
  );
}

// In layout
function Layout({ children }) {
  return (
    <>
      <SkipLink />
      <header>...</header>
      <nav aria-label="Main navigation">...</nav>
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
      <footer>...</footer>
    </>
  );
}
```

### Pattern 5: Live Region for Announcements

```tsx
function useAnnounce() {
  const [message, setMessage] = React.useState("");

  const announce = React.useCallback(
    (text: string, priority: "polite" | "assertive" = "polite") => {
      setMessage(""); // Clear first to ensure re-announcement
      setTimeout(() => setMessage(text), 100);
    },
    [],
  );

  const Announcer = () => (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {message}
    </div>
  );

  return { announce, Announcer };
}

// Usage
function SearchResults({ results, isLoading }) {
  const { announce, Announcer } = useAnnounce();

  React.useEffect(() => {
    if (!isLoading && results) {
      announce(`${results.length} results found`);
    }
  }, [results, isLoading, announce]);

  return (
    <>
      <Announcer />
      <ul>{/* results */}</ul>
    </>
  );
}
```

## Color Contrast Requirements

```typescript
// Contrast ratio utilities
function getContrastRatio(foreground: string, background: string): number {
  const fgLuminance = getLuminance(foreground);
  const bgLuminance = getLuminance(background);
  const lighter = Math.max(fgLuminance, bgLuminance);
  const darker = Math.min(fgLuminance, bgLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

// WCAG requirements
const CONTRAST_REQUIREMENTS = {
  // Normal text (<18pt or <14pt bold)
  normalText: {
    AA: 4.5,
    AAA: 7,
  },
  // Large text (>=18pt or >=14pt bold)
  largeText: {
    AA: 3,
    AAA: 4.5,
  },
  // UI components and graphics
  uiComponents: {
    AA: 3,
  },
};
```
````

## Skill: web-quality-audit (web-quality.zip, web-quality/web-quality-audit/)

### `/tmp/or-atom-008-corpus/web-quality/web-quality-audit/SKILL.md`

````{txt}
---
name: web-quality-audit
description: Run an evidence-led web quality audit covering performance, accessibility, SEO, best practices, and agentic browsing. Use when asked to "audit my site", "review web quality", "run lighthouse audit", "check page quality", or "optimize my website".
license: MIT
metadata:
  version: "2.0"
---

# Web quality audit

Comprehensive quality review that combines live browser evidence with source inspection. Covers Performance, Accessibility, SEO, Best Practices, and Agentic Browsing without treating an aggregate score as proof of quality.

> **Lighthouse 13+.** The Performance category now uses shared **Performance Insights** across Lighthouse and the DevTools Performance panel ([announcement](https://developer.chrome.com/blog/moving-lighthouse-to-insights)). Follow current insight names and evidence. Do not require removed audit IDs or automatically recreate their recommendations; some were retired because they were noisy, inactionable, or easy to over-recommend.

## How it works

1. Establish the audit target: representative URLs, important states and journeys, public versus authenticated access, and mobile/desktop scope.
2. If a page can run, read [the measurement workflow](../performance/references/MEASUREMENT.md) and collect a minimal live baseline before searching the codebase broadly.
3. Use runtime failures to localize source inspection. Keep measured findings separate from hypotheses found only in code.
4. Categorize by user impact and confidence, then make or recommend specific fixes.
5. Re-run equivalent automated checks and the affected manual flows. Report what is verified and what still needs field or human validation.

## Tool routing

Use the best capability already available; do not block the audit on optional setup.

| Need | Preferred route | Fallback |
|------|-----------------|----------|
| Performance and Core Web Vitals | Record a browser performance trace and analyze focused insights; with Chrome DevTools MCP, use `performance_start_trace` then `performance_analyze_insight` | Lighthouse CLI or PageSpeed Insights lab data |
| Real-user performance | CrUX values included in current DevTools trace summaries | PageSpeed Insights/CrUX Vis; direct CrUX API only when a key is already available or automation is requested |
| Accessibility, SEO, Best Practices, Agentic Browsing | Run a live Lighthouse audit; with Chrome DevTools MCP, use `lighthouse_audit` | Category-specific Lighthouse CLI audits plus manual checks |
| Rendered semantics and interaction | Inspect the accessibility tree and exercise the UI; with Chrome DevTools MCP, use `take_snapshot` and focused `evaluate_script` | Browser/manual testing |
| Source smoke test | `scripts/analyze.sh <path>` | Direct source inspection |

Chrome DevTools MCP's `lighthouse_audit` intentionally excludes performance. Its navigation mode reloads the page; use snapshot mode when preserving the current authenticated or user-created state matters. The static analyzer is a fast smoke test, not a substitute for a rendered-page audit.

## Audit categories

### Performance

**Core Web Vitals** — Must pass for good page experience:
* **LCP (Largest Contentful Paint) < 2.5s.** The largest visible element must render quickly. Optimize images, fonts, and server response time.
* **INP (Interaction to Next Paint) < 200ms.** User interactions must feel instant. Reduce JavaScript execution time and break up long tasks.
* **CLS (Cumulative Layout Shift) < 0.1.** Content must not jump around. Set explicit dimensions on images, embeds, and ads.

**Resource Optimization:**
* **Compress images.** Use WebP/AVIF with fallbacks. Serve correctly sized images via `srcset`.
* **Minimize JavaScript.** Remove unused code. Use code splitting. Defer non-critical scripts.
* **Optimize CSS.** Extract critical CSS. Remove unused styles. Avoid `@import`.
* **Efficient fonts.** Use `font-display: swap`. Preload critical fonts. Subset to needed characters.

**Loading Strategy:**
* **Preconnect to origins.** Add `<link rel="preconnect">` for third-party domains.
* **Preload critical assets.** LCP images, fonts, and above-fold CSS.
* **Lazy load below-fold content.** Images, iframes, and heavy components.
* **Cache effectively.** Long cache TTLs for static assets. Immutable caching for hashed files.

### Accessibility

**Perceivable:**
* **Text alternatives.** Every `<img>` has meaningful `alt` text. Decorative images use `alt=""`.
* **Color contrast.** Minimum 4.5:1 for normal text, 3:1 for large text (WCAG AA).
* **Don't rely on color alone.** Use icons, patterns, or text alongside color indicators.
* **Captions and transcripts.** Video has captions. Audio has transcripts.

**Operable:**
* **Keyboard accessible.** All functionality available via keyboard. No keyboard traps.
* **Focus visible.** Clear focus indicators on all interactive elements.
* **Skip links.** Provide "Skip to main content" for keyboard users.
* **Sufficient time.** Users can extend time limits. No auto-advancing content without controls.

**Understandable:**
* **Page language.** Set `lang` attribute on `<html>`.
* **Consistent navigation.** Same navigation structure across pages.
* **Error identification.** Form errors clearly described and associated with fields.
* **Labels and instructions.** All form inputs have associated labels.

**Robust:**
* **Valid HTML.** No duplicate IDs. Properly nested elements.
* **ARIA used correctly.** Prefer native elements. ARIA roles match behavior.
* **Name, role, value.** Interactive elements have accessible names and correct roles.

### SEO

**Crawlability:**
* **Valid robots.txt.** Doesn't block important resources.
* **XML sitemap.** Lists all important pages. Submitted to Search Console.
* **Canonical URLs.** Prevent duplicate content issues.
* **No noindex on important pages.** Check meta robots and headers.

**On-Page SEO:**
* **Unique title tags.** Make each title descriptive and concise; display truncation varies by device and result type.
* **Meta descriptions.** Write useful, page-specific summaries; search engines may choose a different snippet.
* **Heading hierarchy.** The primary heading is descriptive and the structure is logical; do not fail valid HTML solely for using more than one `<h1>`.
* **Descriptive link text.** Not "click here" or "read more".

**Technical SEO:**
* **Mobile-friendly.** Responsive design. Tap targets ≥ 48px.
* **HTTPS.** Secure connection required.
* **Page experience signals.** Use field Core Web Vitals as evidence, without promising a ranking change.
* **Structured data.** JSON-LD for rich snippets (Article, Product, FAQ, etc.).

### Best practices

**Security:**
* **HTTPS everywhere.** No mixed content. HSTS enabled.
* **No vulnerable libraries.** Keep dependencies updated.
* **CSP headers.** Content Security Policy to prevent XSS.
* **No exposed source maps.** In production builds.

**Modern Standards:**
* **No deprecated APIs.** Replace `document.write`, synchronous XHR, etc.
* **Valid doctype.** Use `<!DOCTYPE html>`.
* **Charset declared.** `<meta charset="UTF-8">` as first element in `<head>`.
* **No browser errors.** Clean console. No CORS issues.

**UX Patterns:**
* **No intrusive interstitials.** Especially on mobile.
* **Clear permission requests.** Only ask when needed, with context.
* **No misleading buttons.** Buttons do what they say.

### Agentic browsing

Use the Lighthouse Agentic Browsing results as technical signals for how well assistants can understand and interact with the rendered page.

* **Accessible interaction surface.** Semantic HTML, labels, names, roles, and states must expose meaningful controls in the accessibility tree.
* **WebMCP integrations are valid when present.** Review registered tools, schemas, and form coverage; do not add WebMCP solely to raise an audit score.
* **`llms.txt` is optional.** A valid file may help compatible tools discover curated content, but a Lighthouse pass does not prove that search or AI products will ingest, rank, or cite it.
* **Keep this category separate from SEO claims.** Agentic browsability is not evidence of search ranking or AI visibility.

## Severity levels

| Level | Description | Action |
|-------|-------------|--------|
| **Critical** | Security vulnerabilities, complete failures | Fix immediately |
| **High** | Core Web Vitals failures, major a11y barriers | Fix before launch |
| **Medium** | Performance opportunities, SEO improvements | Fix within sprint |
| **Low** | Minor optimizations, code quality | Fix when convenient |

## Audit output format

When performing an audit, structure findings as:

```markdown
## Audit results

### Evidence
| Signal | Scope/conditions | Result | Source |
|--------|------------------|--------|--------|
| LCP | URL, phone, p75/28 days | 3.1s (needs improvement) | CrUX |
| Accessibility | URL, mobile navigation | 92 | Lighthouse |

### Critical issues (X found)
- **[Category]** Issue description. File: `path/to/file.js:123`
  - **Impact:** Why this matters
  - **Evidence:** Measured failure, runtime observation, or source hypothesis
  - **Fix:** Specific code change or recommendation

### High priority (X found)
...

### Summary
- Performance: measured status and X findings
- Accessibility: automated status, X findings, manual checks pending/passed
- SEO: X findings
- Best Practices: X findings
- Agentic Browsing: X findings or not available

### Recommended priority
1. First fix this because...
2. Then address...
3. Finally optimize...

### Verification
- Re-run results under the same conditions
- Manual checks completed
- Field validation still pending
```

## Quick checklist

### Before every deploy
- [ ] Core Web Vitals passing
- [ ] No accessibility errors (axe/Lighthouse)
- [ ] No console errors
- [ ] HTTPS working
- [ ] Meta tags present

### Weekly review
- [ ] Check Search Console for issues
- [ ] Review Core Web Vitals trends
- [ ] Update dependencies
- [ ] Test with screen reader

### Monthly deep dive
- [ ] Full Lighthouse audit
- [ ] Performance profiling
- [ ] Accessibility audit with real users
- [ ] SEO keyword review

## References

For detailed guidelines on specific areas:
- [Performance Optimization](../performance/SKILL.md)
- [Core Web Vitals](../core-web-vitals/SKILL.md)
- [Accessibility](../accessibility/SKILL.md)
- [SEO](../seo/SKILL.md)
- [Best Practices](../best-practices/SKILL.md)
````

### `/tmp/or-atom-008-corpus/web-quality/web-quality-audit/scripts/analyze.sh`

```{txt}
#!/bin/bash
# Read-only HTML quality analyzer (v2). No filesystem mutations.
# stderr = human logs, stdout = structured JSON.
set -euo pipefail

MAX_FINDINGS=100
MAX_PER_CATEGORY_PER_FILE=20  # cap per high-volume check per file so one category can't fill MAX_FINDINGS

fail() {
  local type="$1" msg="$2" suggestion="$3"
  if command -v jq >/dev/null 2>&1; then
    jq -n \
      --arg type "$type" \
      --arg msg "$msg" \
      --arg suggestion "$suggestion" \
      '{success: false, error: {type: $type, message: $msg, retryable: false, suggestion: $suggestion}}'
  else
    printf '{"success":false,"error":{"type":"%s","message":"%s","suggestion":"%s","retryable":false}}\n' \
      "$type" "$msg" "$suggestion"
  fi
  exit 1
}

command -v jq >/dev/null 2>&1 || \
  fail "missing_dependency" "jq is required for safe JSON output" "Install: brew install jq"

[ $# -ge 1 ] || fail "invalid_input" "No target provided" "Usage: $0 <file_or_directory>"
TARGET="$1"
[ -e "$TARGET" ] || fail "invalid_input" "Target not found: $TARGET" "Pass an existing file or directory path"

ISSUES=()
WARNINGS=()

analyze_html() {
  local file="$1"
  echo "Analyzing: $file" >&2

  grep -qi "<!doctype html>"     "$file" || ISSUES+=("$file:0: Missing HTML5 doctype")
  grep -qi 'charset.*utf-8'      "$file" || WARNINGS+=("$file:0: Missing or non-UTF-8 charset")
  grep -qi 'name="viewport"'     "$file" || ISSUES+=("$file:0: Missing viewport meta tag")
  grep -qi '<html[^>]*lang='     "$file" || ISSUES+=("$file:0: Missing lang attribute on <html>")
  grep -qi '<title>'             "$file" || ISSUES+=("$file:0: Missing <title> tag")

  # <img> without alt — two-pass replaces broken PCRE lookahead
  local alt_count=0
  while IFS=: read -r ln tag; do
    if grep -qE 'alt=' <<<"$tag"; then continue; fi
    if [ "$alt_count" -ge "$MAX_PER_CATEGORY_PER_FILE" ]; then
      WARNINGS+=("$file:0: <img>-without-alt findings truncated (>${MAX_PER_CATEGORY_PER_FILE} in this file)")
      break
    fi
    WARNINGS+=("$file:$ln: <img> without alt attribute")
    alt_count=$((alt_count + 1))
  done < <(grep -noE '<img[^>]*>' "$file" || true)

  # Non-HTTPS URLs with line numbers
  local http_count=0
  while IFS=: read -r ln _; do
    if [ "$http_count" -ge "$MAX_PER_CATEGORY_PER_FILE" ]; then
      WARNINGS+=("$file:0: Non-HTTPS URL findings truncated (>${MAX_PER_CATEGORY_PER_FILE} in this file)")
      break
    fi
    WARNINGS+=("$file:$ln: Non-HTTPS URL")
    http_count=$((http_count + 1))
  done < <(grep -noE 'http://[^"'\''[:space:]>]*' "$file" || true)
}

# Process substitution keeps arrays in main shell (fixes v1 subshell bug)
if [ -d "$TARGET" ]; then
  while IFS= read -r -d '' file; do
    analyze_html "$file"
  done < <(find "$TARGET" \( -name "*.html" -o -name "*.htm" \) -print0)
elif [ -f "$TARGET" ]; then
  analyze_html "$TARGET"
else
  fail "invalid_input" "Target is not a regular file or directory: $TARGET" "Pass a path to an .html/.htm file or a directory"
fi

issue_total=${#ISSUES[@]}
warning_total=${#WARNINGS[@]}

to_json_array() {
  printf '%s\n' "$@" | jq -Rs 'split("\n") | map(select(length > 0))'
}

if [ "$issue_total" -gt 0 ]; then
  issues_json=$(to_json_array "${ISSUES[@]:0:$MAX_FINDINGS}")
else
  issues_json='[]'
fi

if [ "$warning_total" -gt 0 ]; then
  warnings_json=$(to_json_array "${WARNINGS[@]:0:$MAX_FINDINGS}")
else
  warnings_json='[]'
fi

echo "Scanned. $issue_total issues, $warning_total warnings." >&2

jq -n \
  --argjson issues "$issues_json" \
  --argjson warnings "$warnings_json" \
  --argjson issue_total "$issue_total" \
  --argjson warning_total "$warning_total" \
  --argjson max "$MAX_FINDINGS" \
  '{
    success: true,
    issues: $issues,
    warnings: $warnings,
    issueCount: $issue_total,
    warningCount: $warning_total,
    truncated: (($issue_total > $max) or ($warning_total > $max))
  }'
```

## Skill: visual-design-foundations (engineering.zip, engineering/visual-design-foundations/)

### `/tmp/or-atom-008-corpus/engineering/visual-design-foundations/SKILL.md`

````{txt}
---
name: visual-design-foundations
description: Apply typography, color theory, spacing systems, and iconography principles to create cohesive visual designs. Use when establishing design tokens, building style guides, or improving visual hierarchy and consistency.
---

# Visual Design Foundations

Build cohesive, accessible visual systems using typography, color, spacing, and iconography fundamentals.

## When to Use This Skill

- Establishing design tokens for a new project
- Creating or refining a spacing and sizing system
- Selecting and pairing typefaces
- Building accessible color palettes
- Designing icon systems and visual assets
- Improving visual hierarchy and readability
- Auditing designs for visual consistency
- Implementing dark mode or theming

## Core Systems

### 1. Typography Scale

**Modular Scale** (ratio-based sizing):

```css
:root {
  --font-size-xs: 0.75rem; /* 12px */
  --font-size-sm: 0.875rem; /* 14px */
  --font-size-base: 1rem; /* 16px */
  --font-size-lg: 1.125rem; /* 18px */
  --font-size-xl: 1.25rem; /* 20px */
  --font-size-2xl: 1.5rem; /* 24px */
  --font-size-3xl: 1.875rem; /* 30px */
  --font-size-4xl: 2.25rem; /* 36px */
  --font-size-5xl: 3rem; /* 48px */
}
```

**Line Height Guidelines**:
| Text Type | Line Height |
|-----------|-------------|
| Headings | 1.1 - 1.3 |
| Body text | 1.5 - 1.7 |
| UI labels | 1.2 - 1.4 |

### 2. Spacing System

**8-point grid** (industry standard):

```css
:root {
  --space-1: 0.25rem; /* 4px */
  --space-2: 0.5rem; /* 8px */
  --space-3: 0.75rem; /* 12px */
  --space-4: 1rem; /* 16px */
  --space-5: 1.25rem; /* 20px */
  --space-6: 1.5rem; /* 24px */
  --space-8: 2rem; /* 32px */
  --space-10: 2.5rem; /* 40px */
  --space-12: 3rem; /* 48px */
  --space-16: 4rem; /* 64px */
}
```

### 3. Color System

**Semantic color tokens**:

```css
:root {
  /* Brand */
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-active: #1e40af;

  /* Semantic */
  --color-success: #16a34a;
  --color-warning: #ca8a04;
  --color-error: #dc2626;
  --color-info: #0891b2;

  /* Neutral */
  --color-gray-50: #f9fafb;
  --color-gray-100: #f3f4f6;
  --color-gray-200: #e5e7eb;
  --color-gray-300: #d1d5db;
  --color-gray-400: #9ca3af;
  --color-gray-500: #6b7280;
  --color-gray-600: #4b5563;
  --color-gray-700: #374151;
  --color-gray-800: #1f2937;
  --color-gray-900: #111827;
}
```

## Quick Start: Design Tokens in Tailwind

```js
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      fontSize: {
        xs: ["0.75rem", { lineHeight: "1rem" }],
        sm: ["0.875rem", { lineHeight: "1.25rem" }],
        base: ["1rem", { lineHeight: "1.5rem" }],
        lg: ["1.125rem", { lineHeight: "1.75rem" }],
        xl: ["1.25rem", { lineHeight: "1.75rem" }],
        "2xl": ["1.5rem", { lineHeight: "2rem" }],
      },
      colors: {
        brand: {
          50: "#eff6ff",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
        },
      },
      spacing: {
        // Extends default with custom values
        18: "4.5rem",
        88: "22rem",
      },
    },
  },
};
```

## Typography Best Practices

### Font Pairing

**Safe combinations**:

- Heading: **Inter** / Body: **Inter** (single family)
- Heading: **Playfair Display** / Body: **Source Sans Pro** (contrast)
- Heading: **Space Grotesk** / Body: **IBM Plex Sans** (geometric)

### Responsive Typography

```css
/* Fluid typography using clamp() */
h1 {
  font-size: clamp(2rem, 5vw + 1rem, 3.5rem);
  line-height: 1.1;
}

p {
  font-size: clamp(1rem, 2vw + 0.5rem, 1.125rem);
  line-height: 1.6;
  max-width: 65ch; /* Optimal reading width */
}
```

### Font Loading

```css
/* Prevent layout shift */
@font-face {
  font-family: "Inter";
  src: url("/fonts/Inter.woff2") format("woff2");
  font-display: swap;
  font-weight: 400 700;
}
```

## Color Theory

### Contrast Requirements (WCAG)

| Element            | Minimum Ratio |
| ------------------ | ------------- |
| Body text          | 4.5:1 (AA)    |
| Large text (18px+) | 3:1 (AA)      |
| UI components      | 3:1 (AA)      |
| Enhanced           | 7:1 (AAA)     |

### Dark Mode Strategy

```css
:root {
  --bg-primary: #ffffff;
  --bg-secondary: #f9fafb;
  --text-primary: #111827;
  --text-secondary: #6b7280;
  --border: #e5e7eb;
}

[data-theme="dark"] {
  --bg-primary: #111827;
  --bg-secondary: #1f2937;
  --text-primary: #f9fafb;
  --text-secondary: #9ca3af;
  --border: #374151;
}
```

### Color Accessibility

```tsx
// Check contrast programmatically
function getContrastRatio(foreground: string, background: string): number {
  const getLuminance = (hex: string) => {
    const rgb = hexToRgb(hex);
    const [r, g, b] = rgb.map((c) => {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  const l1 = getLuminance(foreground);
  const l2 = getLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  return (lighter + 0.05) / (darker + 0.05);
}
```

## Spacing Guidelines

### Component Spacing

```
Card padding:      16-24px (--space-4 to --space-6)
Section gap:       32-64px (--space-8 to --space-16)
Form field gap:    16-24px (--space-4 to --space-6)
Button padding:    8-16px vertical, 16-24px horizontal
Icon-text gap:     8px (--space-2)
```

### Visual Rhythm

```css
/* Consistent vertical rhythm */
.prose > * + * {
  margin-top: var(--space-4);
}

.prose > h2 + * {
  margin-top: var(--space-2);
}

.prose > * + h2 {
  margin-top: var(--space-8);
}
```

## Iconography

### Icon Sizing System

```css
:root {
  --icon-xs: 12px;
  --icon-sm: 16px;
  --icon-md: 20px;
  --icon-lg: 24px;
  --icon-xl: 32px;
}
```

### Icon Component

```tsx
interface IconProps {
  name: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizeMap = {
  xs: 12,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
};

export function Icon({ name, size = "md", className }: IconProps) {
  return (
    <svg
      width={sizeMap[size]}
      height={sizeMap[size]}
      className={cn("inline-block flex-shrink-0", className)}
      aria-hidden="true"
    >
      <use href={`/icons.svg#${name}`} />
    </svg>
  );
}
```

## Best Practices

1. **Establish Constraints**: Limit choices to maintain consistency
2. **Document Decisions**: Create a living style guide
3. **Test Accessibility**: Verify contrast, sizing, touch targets
4. **Use Semantic Tokens**: Name by purpose, not appearance
5. **Design Mobile-First**: Start with constraints, add complexity
6. **Maintain Vertical Rhythm**: Consistent spacing creates harmony
7. **Limit Font Weights**: 2-3 weights per family is sufficient

## Common Issues

- **Inconsistent Spacing**: Not using a defined scale
- **Poor Contrast**: Failing WCAG requirements
- **Font Overload**: Too many families or weights
- **Magic Numbers**: Arbitrary values instead of tokens
- **Missing States**: Forgetting hover, focus, disabled
- **No Dark Mode Plan**: Retrofitting is harder than planning
````

### `/tmp/or-atom-008-corpus/engineering/visual-design-foundations/references/color-systems.md`

````{txt}
# Color Systems Reference

## Color Palette Generation

### Perceptually Uniform Scales

Using OKLCH for perceptually uniform color scales:

```css
/* OKLCH: Lightness, Chroma, Hue */
:root {
  /* Generate a blue scale with consistent perceived lightness steps */
  --blue-50: oklch(97% 0.02 250);
  --blue-100: oklch(93% 0.04 250);
  --blue-200: oklch(86% 0.08 250);
  --blue-300: oklch(75% 0.12 250);
  --blue-400: oklch(65% 0.16 250);
  --blue-500: oklch(55% 0.2 250); /* Primary */
  --blue-600: oklch(48% 0.18 250);
  --blue-700: oklch(40% 0.16 250);
  --blue-800: oklch(32% 0.12 250);
  --blue-900: oklch(25% 0.08 250);
  --blue-950: oklch(18% 0.05 250);
}
```

### Programmatic Scale Generation

```tsx
function generateColorScale(
  hue: number,
  saturation: number = 100,
): Record<string, string> {
  const lightnessStops = [
    { name: "50", l: 97 },
    { name: "100", l: 93 },
    { name: "200", l: 85 },
    { name: "300", l: 75 },
    { name: "400", l: 65 },
    { name: "500", l: 55 },
    { name: "600", l: 45 },
    { name: "700", l: 35 },
    { name: "800", l: 25 },
    { name: "900", l: 18 },
    { name: "950", l: 12 },
  ];

  return Object.fromEntries(
    lightnessStops.map(({ name, l }) => [
      name,
      `hsl(${hue}, ${saturation}%, ${l}%)`,
    ]),
  );
}

// Generate semantic colors
const brand = generateColorScale(220); // Blue
const success = generateColorScale(142); // Green
const warning = generateColorScale(38); // Amber
const error = generateColorScale(0); // Red
```

## Semantic Color Tokens

### Two-Tier Token System

```css
/* Tier 1: Primitive colors (raw values) */
:root {
  --primitive-blue-500: #3b82f6;
  --primitive-blue-600: #2563eb;
  --primitive-green-500: #22c55e;
  --primitive-red-500: #ef4444;
  --primitive-gray-50: #f9fafb;
  --primitive-gray-900: #111827;
}

/* Tier 2: Semantic tokens (purpose-based) */
:root {
  /* Background */
  --color-bg-primary: var(--primitive-gray-50);
  --color-bg-secondary: white;
  --color-bg-tertiary: var(--primitive-gray-100);
  --color-bg-inverse: var(--primitive-gray-900);

  /* Text */
  --color-text-primary: var(--primitive-gray-900);
  --color-text-secondary: var(--primitive-gray-600);
  --color-text-tertiary: var(--primitive-gray-400);
  --color-text-inverse: white;
  --color-text-link: var(--primitive-blue-600);

  /* Border */
  --color-border-default: var(--primitive-gray-200);
  --color-border-strong: var(--primitive-gray-300);
  --color-border-focus: var(--primitive-blue-500);

  /* Interactive */
  --color-interactive-primary: var(--primitive-blue-600);
  --color-interactive-primary-hover: var(--primitive-blue-700);
  --color-interactive-primary-active: var(--primitive-blue-800);

  /* Status */
  --color-status-success: var(--primitive-green-500);
  --color-status-warning: var(--primitive-amber-500);
  --color-status-error: var(--primitive-red-500);
  --color-status-info: var(--primitive-blue-500);
}
```

### Component Tokens

```css
/* Tier 3: Component-specific tokens */
:root {
  /* Button */
  --button-bg: var(--color-interactive-primary);
  --button-bg-hover: var(--color-interactive-primary-hover);
  --button-text: white;
  --button-border-radius: 0.375rem;

  /* Input */
  --input-bg: var(--color-bg-secondary);
  --input-border: var(--color-border-default);
  --input-border-focus: var(--color-border-focus);
  --input-text: var(--color-text-primary);
  --input-placeholder: var(--color-text-tertiary);

  /* Card */
  --card-bg: var(--color-bg-secondary);
  --card-border: var(--color-border-default);
  --card-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
```

## Dark Mode Implementation

### CSS Custom Properties Approach

```css
/* Light theme (default) */
:root {
  --color-bg-primary: #ffffff;
  --color-bg-secondary: #f9fafb;
  --color-bg-tertiary: #f3f4f6;
  --color-text-primary: #111827;
  --color-text-secondary: #4b5563;
  --color-border-default: #e5e7eb;
}

/* Dark theme */
[data-theme="dark"] {
  --color-bg-primary: #111827;
  --color-bg-secondary: #1f2937;
  --color-bg-tertiary: #374151;
  --color-text-primary: #f9fafb;
  --color-text-secondary: #9ca3af;
  --color-border-default: #374151;
}

/* System preference */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-bg-primary: #111827;
    /* ... dark theme values */
  }
}
```

### React Theme Context

```tsx
import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const root = document.documentElement;

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      setResolvedTheme(systemTheme);
      root.setAttribute("data-theme", systemTheme);
    } else {
      setResolvedTheme(theme);
      root.setAttribute("data-theme", theme);
    }
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      const newTheme = e.matches ? "dark" : "light";
      setResolvedTheme(newTheme);
      document.documentElement.setAttribute("data-theme", newTheme);
    };

    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be within ThemeProvider");
  return context;
}
```

## Contrast and Accessibility

### WCAG Contrast Checker

```tsx
function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) throw new Error("Invalid hex color");
  return [
    parseInt(result[1], 16),
    parseInt(result[2], 16),
    parseInt(result[3], 16),
  ];
}

function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function getContrastRatio(hex1: string, hex2: string): number {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);

  const l1 = getLuminance(r1, g1, b1);
  const l2 = getLuminance(r2, g2, b2);

  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  return (lighter + 0.05) / (darker + 0.05);
}

function meetsWCAG(
  foreground: string,
  background: string,
  size: "normal" | "large" = "normal",
  level: "AA" | "AAA" = "AA",
): boolean {
  const ratio = getContrastRatio(foreground, background);

  const requirements = {
    normal: { AA: 4.5, AAA: 7 },
    large: { AA: 3, AAA: 4.5 },
  };

  return ratio >= requirements[size][level];
}

// Usage
meetsWCAG("#ffffff", "#3b82f6"); // true (4.5:1 for AA normal)
meetsWCAG("#ffffff", "#60a5fa"); // false (below 4.5:1)
```

### Accessible Color Pairs

```tsx
// Generate accessible text color for any background
function getAccessibleTextColor(backgroundColor: string): string {
  const [r, g, b] = hexToRgb(backgroundColor);
  const luminance = getLuminance(r, g, b);

  // Use white text on dark backgrounds, black on light
  return luminance > 0.179 ? "#111827" : "#ffffff";
}

// Find the nearest accessible shade
function findAccessibleShade(
  textColor: string,
  backgroundScale: string[],
  minContrast: number = 4.5,
): string | null {
  for (const shade of backgroundScale) {
    if (getContrastRatio(textColor, shade) >= minContrast) {
      return shade;
    }
  }
  return null;
}
```

## Color Harmony

### Harmony Functions

```tsx
type HarmonyType =
  | "complementary"
  | "triadic"
  | "analogous"
  | "split-complementary";

function generateHarmony(baseHue: number, type: HarmonyType): number[] {
  switch (type) {
    case "complementary":
      return [baseHue, (baseHue + 180) % 360];
    case "triadic":
      return [baseHue, (baseHue + 120) % 360, (baseHue + 240) % 360];
    case "analogous":
      return [(baseHue - 30 + 360) % 360, baseHue, (baseHue + 30) % 360];
    case "split-complementary":
      return [baseHue, (baseHue + 150) % 360, (baseHue + 210) % 360];
    default:
      return [baseHue];
  }
}

// Generate palette from harmony
function generateHarmoniousPalette(
  baseHue: number,
  type: HarmonyType,
): Record<string, string> {
  const hues = generateHarmony(baseHue, type);
  const names = ["primary", "secondary", "tertiary"];

  return Object.fromEntries(
    hues.map((hue, i) => [names[i] || `color-${i}`, `hsl(${hue}, 70%, 50%)`]),
  );
}
```

## Color Blindness Considerations

```tsx
// Simulate color blindness
type ColorBlindnessType = "protanopia" | "deuteranopia" | "tritanopia";

// Matrix transforms for common types
const colorBlindnessMatrices: Record<ColorBlindnessType, number[][]> = {
  protanopia: [
    [0.567, 0.433, 0],
    [0.558, 0.442, 0],
    [0, 0.242, 0.758],
  ],
  deuteranopia: [
    [0.625, 0.375, 0],
    [0.7, 0.3, 0],
    [0, 0.3, 0.7],
  ],
  tritanopia: [
    [0.95, 0.05, 0],
    [0, 0.433, 0.567],
    [0, 0.475, 0.525],
  ],
};

// Best practices for color-blind accessibility:
// 1. Do not rely solely on color to convey information
// 2. Use patterns or icons alongside color
// 3. Ensure sufficient contrast between colors
// 4. Test with color blindness simulators
// 5. Use blue-orange instead of red-green for contrast
```

## CSS Color Functions

```css
/* Modern CSS color functions */
.modern-colors {
  /* Relative color syntax */
  --lighter: hsl(from var(--base-color) h s calc(l + 20%));
  --darker: hsl(from var(--base-color) h s calc(l - 20%));

  /* Color mixing */
  --mixed: color-mix(in srgb, var(--color-1), var(--color-2) 30%);

  /* Transparency */
  --semi-transparent: rgb(from var(--base-color) r g b / 50%);

  /* OKLCH for perceptual uniformity */
  --vibrant-blue: oklch(60% 0.2 250);
}

/* Alpha variations */
.alpha-scale {
  --color-10: rgb(59 130 246 / 0.1);
  --color-20: rgb(59 130 246 / 0.2);
  --color-30: rgb(59 130 246 / 0.3);
  --color-40: rgb(59 130 246 / 0.4);
  --color-50: rgb(59 130 246 / 0.5);
}
```
````

### `/tmp/or-atom-008-corpus/engineering/visual-design-foundations/references/typography-systems.md`

````{txt}
# Typography Systems Reference

## Type Scale Construction

### Modular Scale

A modular scale creates harmonious relationships between font sizes using a mathematical ratio.

```tsx
// Common ratios
const RATIOS = {
  minorSecond: 1.067, // 16:15
  majorSecond: 1.125, // 9:8
  minorThird: 1.2, // 6:5
  majorThird: 1.25, // 5:4
  perfectFourth: 1.333, // 4:3
  augmentedFourth: 1.414, // √2
  perfectFifth: 1.5, // 3:2
  goldenRatio: 1.618, // φ
};

function generateScale(
  baseSize: number,
  ratio: number,
  steps: number,
): number[] {
  const scale: number[] = [];
  for (let i = -2; i <= steps; i++) {
    scale.push(Math.round(baseSize * Math.pow(ratio, i) * 100) / 100);
  }
  return scale;
}

// Generate a scale with 16px base and perfect fourth ratio
const typeScale = generateScale(16, RATIOS.perfectFourth, 6);
// Result: [9, 12, 16, 21.33, 28.43, 37.9, 50.52, 67.34, 89.76]
```

### CSS Custom Properties

```css
:root {
  /* Base scale using perfect fourth (1.333) */
  --font-size-2xs: 0.563rem; /* ~9px */
  --font-size-xs: 0.75rem; /* 12px */
  --font-size-sm: 0.875rem; /* 14px */
  --font-size-base: 1rem; /* 16px */
  --font-size-md: 1.125rem; /* 18px */
  --font-size-lg: 1.333rem; /* ~21px */
  --font-size-xl: 1.5rem; /* 24px */
  --font-size-2xl: 1.777rem; /* ~28px */
  --font-size-3xl: 2.369rem; /* ~38px */
  --font-size-4xl: 3.157rem; /* ~50px */
  --font-size-5xl: 4.209rem; /* ~67px */

  /* Font weights */
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;

  /* Line heights */
  --line-height-tight: 1.1;
  --line-height-snug: 1.25;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.625;
  --line-height-loose: 2;

  /* Letter spacing */
  --letter-spacing-tighter: -0.05em;
  --letter-spacing-tight: -0.025em;
  --letter-spacing-normal: 0;
  --letter-spacing-wide: 0.025em;
  --letter-spacing-wider: 0.05em;
  --letter-spacing-widest: 0.1em;
}
```

## Font Loading Strategies

### FOUT Prevention

```css
/* Use font-display to control loading behavior */
@font-face {
  font-family: "Inter";
  src: url("/fonts/Inter-Variable.woff2") format("woff2-variations");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap; /* Show fallback immediately, swap when loaded */
}

/* Optional: size-adjust for better fallback matching */
@font-face {
  font-family: "Inter Fallback";
  src: local("Arial");
  size-adjust: 107%; /* Adjust to match Inter metrics */
  ascent-override: 90%;
  descent-override: 22%;
  line-gap-override: 0%;
}

body {
  font-family: "Inter", "Inter Fallback", system-ui, sans-serif;
}
```

### Preloading Critical Fonts

```html
<head>
  <!-- Preload critical fonts -->
  <link
    rel="preload"
    href="/fonts/Inter-Variable.woff2"
    as="font"
    type="font/woff2"
    crossorigin
  />
</head>
```

### Variable Fonts

```css
/* Variable font with weight and width axes */
@font-face {
  font-family: "Inter";
  src: url("/fonts/Inter-Variable.woff2") format("woff2");
  font-weight: 100 900;
  font-stretch: 75% 125%;
}

/* Use font-variation-settings for fine control */
.custom-weight {
  font-variation-settings:
    "wght" 450,
    "wdth" 95;
}

/* Or use standard properties */
.semi-expanded {
  font-weight: 550;
  font-stretch: 110%;
}
```

## Responsive Typography

### Fluid Type Scale

```css
/* Using clamp() for responsive sizing */
h1 {
  /* min: 32px, preferred: 5vw + 16px, max: 64px */
  font-size: clamp(2rem, 5vw + 1rem, 4rem);
  line-height: 1.1;
}

h2 {
  font-size: clamp(1.5rem, 3vw + 0.5rem, 2.5rem);
  line-height: 1.2;
}

p {
  font-size: clamp(1rem, 1vw + 0.75rem, 1.25rem);
  line-height: 1.6;
}

/* Fluid line height */
.fluid-text {
  --min-line-height: 1.3;
  --max-line-height: 1.6;
  --min-vw: 320;
  --max-vw: 1200;

  line-height: calc(
    var(--min-line-height) + (var(--max-line-height) - var(--min-line-height)) *
      ((100vw - var(--min-vw) * 1px) / (var(--max-vw) - var(--min-vw)))
  );
}
```

### Viewport-Based Scaling

```tsx
// Tailwind config for responsive type
module.exports = {
  theme: {
    fontSize: {
      xs: ["0.75rem", { lineHeight: "1rem" }],
      sm: ["0.875rem", { lineHeight: "1.25rem" }],
      base: ["1rem", { lineHeight: "1.5rem" }],
      lg: ["1.125rem", { lineHeight: "1.75rem" }],
      xl: ["1.25rem", { lineHeight: "1.75rem" }],
      "2xl": ["1.5rem", { lineHeight: "2rem" }],
      "3xl": ["1.875rem", { lineHeight: "2.25rem" }],
      "4xl": ["2.25rem", { lineHeight: "2.5rem" }],
      "5xl": ["3rem", { lineHeight: "1" }],
    },
  },
};

// Component with responsive classes
function Heading({ children }) {
  return (
    <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold leading-tight">
      {children}
    </h1>
  );
}
```

## Readability Guidelines

### Optimal Line Length

```css
/* Optimal reading width: 45-75 characters */
.prose {
  max-width: 65ch; /* ~65 characters */
}

/* Narrower for callouts */
.callout {
  max-width: 50ch;
}

/* Wider for code blocks */
pre {
  max-width: 80ch;
}
```

### Vertical Rhythm

```css
/* Establish baseline grid */
:root {
  --baseline: 1.5rem; /* 24px at 16px base */
}

/* All margins should be multiples of baseline */
h1 {
  font-size: 2.5rem;
  line-height: calc(var(--baseline) * 2);
  margin-top: calc(var(--baseline) * 2);
  margin-bottom: var(--baseline);
}

h2 {
  font-size: 2rem;
  line-height: calc(var(--baseline) * 1.5);
  margin-top: calc(var(--baseline) * 1.5);
  margin-bottom: calc(var(--baseline) * 0.5);
}

p {
  font-size: 1rem;
  line-height: var(--baseline);
  margin-bottom: var(--baseline);
}
```

### Text Wrapping

```css
/* Prevent orphans and widows */
p {
  text-wrap: pretty; /* Experimental: improves line breaks */
  widows: 3;
  orphans: 3;
}

/* Balance headings */
h1,
h2,
h3 {
  text-wrap: balance;
}

/* Prevent breaking in specific elements */
.no-wrap {
  white-space: nowrap;
}

/* Hyphenation for justified text */
.justified {
  text-align: justify;
  hyphens: auto;
  -webkit-hyphens: auto;
}
```

## Font Pairing Guidelines

### Contrast Pairings

```css
/* Serif heading + Sans body */
:root {
  --font-heading: "Playfair Display", Georgia, serif;
  --font-body: "Source Sans Pro", -apple-system, sans-serif;
}

/* Geometric heading + Humanist body */
:root {
  --font-heading: "Space Grotesk", sans-serif;
  --font-body: "IBM Plex Sans", sans-serif;
}

/* Modern sans heading + Classic serif body */
:root {
  --font-heading: "Inter", system-ui, sans-serif;
  --font-body: "Georgia", Times, serif;
}
```

### Superfamily Approach

```css
/* Single variable font family for all uses */
:root {
  --font-family: "Inter", system-ui, sans-serif;
}

h1 {
  font-family: var(--font-family);
  font-weight: 800;
  letter-spacing: -0.02em;
}

p {
  font-family: var(--font-family);
  font-weight: 400;
  letter-spacing: 0;
}

.caption {
  font-family: var(--font-family);
  font-weight: 500;
  font-size: 0.875rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
```

## Semantic Typography Classes

```css
/* Text styles by purpose, not appearance */
.text-display {
  font-size: var(--font-size-5xl);
  font-weight: var(--font-weight-bold);
  line-height: var(--line-height-tight);
  letter-spacing: var(--letter-spacing-tight);
}

.text-headline {
  font-size: var(--font-size-3xl);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-snug);
}

.text-title {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-snug);
}

.text-body {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-normal);
  line-height: var(--line-height-normal);
}

.text-body-sm {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-normal);
  line-height: var(--line-height-normal);
}

.text-caption {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  line-height: var(--line-height-normal);
  text-transform: uppercase;
  letter-spacing: var(--letter-spacing-wide);
}

.text-overline {
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-normal);
  text-transform: uppercase;
  letter-spacing: var(--letter-spacing-widest);
}
```

## OpenType Features

```css
/* Enable advanced typography features */
.fancy-text {
  /* Small caps */
  font-variant-caps: small-caps;

  /* Ligatures */
  font-variant-ligatures: common-ligatures;

  /* Numeric features */
  font-variant-numeric: tabular-nums lining-nums;

  /* Fractions */
  font-feature-settings: "frac" 1;
}

/* Tabular numbers for aligned columns */
.data-table td {
  font-variant-numeric: tabular-nums;
}

/* Old-style figures for body text */
.prose {
  font-variant-numeric: oldstyle-nums;
}

/* Discretionary ligatures for headings */
.fancy-heading {
  font-variant-ligatures: discretionary-ligatures;
}
```
````

### `/tmp/or-atom-008-corpus/engineering/visual-design-foundations/references/spacing-iconography.md`

````{txt}
# Spacing and Iconography Reference

## Spacing Systems

### 8-Point Grid System

The 8-point grid is the industry standard for consistent spacing.

```css
:root {
  /* Base spacing unit */
  --space-unit: 0.25rem; /* 4px */

  /* Spacing scale */
  --space-0: 0;
  --space-px: 1px;
  --space-0-5: calc(var(--space-unit) * 0.5); /* 2px */
  --space-1: var(--space-unit); /* 4px */
  --space-1-5: calc(var(--space-unit) * 1.5); /* 6px */
  --space-2: calc(var(--space-unit) * 2); /* 8px */
  --space-2-5: calc(var(--space-unit) * 2.5); /* 10px */
  --space-3: calc(var(--space-unit) * 3); /* 12px */
  --space-3-5: calc(var(--space-unit) * 3.5); /* 14px */
  --space-4: calc(var(--space-unit) * 4); /* 16px */
  --space-5: calc(var(--space-unit) * 5); /* 20px */
  --space-6: calc(var(--space-unit) * 6); /* 24px */
  --space-7: calc(var(--space-unit) * 7); /* 28px */
  --space-8: calc(var(--space-unit) * 8); /* 32px */
  --space-9: calc(var(--space-unit) * 9); /* 36px */
  --space-10: calc(var(--space-unit) * 10); /* 40px */
  --space-11: calc(var(--space-unit) * 11); /* 44px */
  --space-12: calc(var(--space-unit) * 12); /* 48px */
  --space-14: calc(var(--space-unit) * 14); /* 56px */
  --space-16: calc(var(--space-unit) * 16); /* 64px */
  --space-20: calc(var(--space-unit) * 20); /* 80px */
  --space-24: calc(var(--space-unit) * 24); /* 96px */
  --space-28: calc(var(--space-unit) * 28); /* 112px */
  --space-32: calc(var(--space-unit) * 32); /* 128px */
}
```

### Semantic Spacing Tokens

```css
:root {
  /* Component-level spacing */
  --spacing-xs: var(--space-1); /* 4px - tight spacing */
  --spacing-sm: var(--space-2); /* 8px - compact spacing */
  --spacing-md: var(--space-4); /* 16px - default spacing */
  --spacing-lg: var(--space-6); /* 24px - comfortable spacing */
  --spacing-xl: var(--space-8); /* 32px - loose spacing */
  --spacing-2xl: var(--space-12); /* 48px - generous spacing */
  --spacing-3xl: var(--space-16); /* 64px - section spacing */

  /* Specific use cases */
  --spacing-inline: var(--space-2); /* Between inline elements */
  --spacing-stack: var(--space-4); /* Between stacked elements */
  --spacing-inset: var(--space-4); /* Padding inside containers */
  --spacing-section: var(--space-16); /* Between major sections */
  --spacing-page: var(--space-24); /* Page margins */
}
```

### Spacing Utility Functions

```tsx
// Tailwind-like spacing scale generator
function createSpacingScale(baseUnit: number = 4): Record<string, string> {
  const scale: Record<string, string> = {
    "0": "0",
    px: "1px",
  };

  const multipliers = [
    0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24,
    28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96,
  ];

  for (const m of multipliers) {
    const key = m % 1 === 0 ? String(m) : String(m).replace(".", "-");
    scale[key] = `${baseUnit * m}px`;
  }

  return scale;
}
```

## Layout Spacing Patterns

### Container Queries for Spacing

```css
/* Responsive spacing based on container size */
.card {
  container-type: inline-size;
  padding: var(--space-4);
}

@container (min-width: 400px) {
  .card {
    padding: var(--space-6);
  }
}

@container (min-width: 600px) {
  .card {
    padding: var(--space-8);
  }
}
```

### Negative Space Patterns

```css
/* Asymmetric spacing for visual hierarchy */
.hero-section {
  padding-top: var(--space-24);
  padding-bottom: var(--space-16);
}

/* Content breathing room */
.prose > * + * {
  margin-top: var(--space-4);
}

.prose > h2 + * {
  margin-top: var(--space-2);
}

.prose > * + h2 {
  margin-top: var(--space-8);
}
```

## Icon Systems

### Icon Size Scale

```css
:root {
  /* Icon sizes aligned to spacing grid */
  --icon-xs: 12px; /* Inline decorators */
  --icon-sm: 16px; /* Small UI elements */
  --icon-md: 20px; /* Default size */
  --icon-lg: 24px; /* Emphasis */
  --icon-xl: 32px; /* Large displays */
  --icon-2xl: 48px; /* Hero icons */

  /* Touch target sizes */
  --touch-target-min: 44px; /* WCAG minimum */
  --touch-target-comfortable: 48px;
}
```

### SVG Icon Component

```tsx
import { forwardRef, type SVGProps } from "react";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
  label?: string;
}

const sizeMap = {
  xs: 12,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
  "2xl": 48,
};

export const Icon = forwardRef<SVGSVGElement, IconProps>(
  ({ name, size = "md", label, className, ...props }, ref) => {
    const pixelSize = sizeMap[size];

    return (
      <svg
        ref={ref}
        width={pixelSize}
        height={pixelSize}
        className={`inline-block flex-shrink-0 ${className}`}
        aria-hidden={!label}
        aria-label={label}
        role={label ? "img" : undefined}
        {...props}
      >
        <use href={`/icons.svg#${name}`} />
      </svg>
    );
  },
);

Icon.displayName = "Icon";
```

### Icon Button Patterns

```tsx
interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  label: string;
  size?: "sm" | "md" | "lg";
  variant?: "solid" | "ghost" | "outline";
}

const sizeClasses = {
  sm: "p-1.5" /* 32px total with 16px icon */,
  md: "p-2" /* 40px total with 20px icon */,
  lg: "p-2.5" /* 48px total with 24px icon */,
};

const iconSizes = {
  sm: "sm" as const,
  md: "md" as const,
  lg: "lg" as const,
};

export function IconButton({
  icon,
  label,
  size = "md",
  variant = "ghost",
  className,
  ...props
}: IconButtonProps) {
  return (
    <button
      className={`
        inline-flex items-center justify-center rounded-lg
        transition-colors focus-visible:outline-none focus-visible:ring-2
        ${sizeClasses[size]}
        ${variant === "solid" && "bg-blue-600 text-white hover:bg-blue-700"}
        ${variant === "ghost" && "hover:bg-gray-100"}
        ${variant === "outline" && "border border-gray-300 hover:bg-gray-50"}
        ${className}
      `}
      aria-label={label}
      {...props}
    >
      <Icon name={icon} size={iconSizes[size]} />
    </button>
  );
}
```

### Icon Sprite Generation

```tsx
// Build script for SVG sprite
import { readdir, readFile, writeFile } from "fs/promises";
import { optimize } from "svgo";

async function buildIconSprite(iconDir: string, outputPath: string) {
  const files = await readdir(iconDir);
  const svgFiles = files.filter((f) => f.endsWith(".svg"));

  const symbols = await Promise.all(
    svgFiles.map(async (file) => {
      const content = await readFile(`${iconDir}/${file}`, "utf-8");
      const name = file.replace(".svg", "");

      // Optimize SVG
      const result = optimize(content, {
        plugins: [
          "removeDoctype",
          "removeXMLProcInst",
          "removeComments",
          "removeMetadata",
          "removeTitle",
          "removeDesc",
          "removeUselessDefs",
          "removeEditorsNSData",
          "removeEmptyAttrs",
          "removeHiddenElems",
          "removeEmptyText",
          "removeEmptyContainers",
          "convertStyleToAttrs",
          "convertColors",
          "convertPathData",
          "convertTransform",
          "removeUnknownsAndDefaults",
          "removeNonInheritableGroupAttrs",
          "removeUselessStrokeAndFill",
          "removeUnusedNS",
          "cleanupNumericValues",
          "cleanupListOfValues",
          "moveElemsAttrsToGroup",
          "moveGroupAttrsToElems",
          "collapseGroups",
          "mergePaths",
        ],
      });

      // Extract viewBox and content
      const viewBoxMatch = result.data.match(/viewBox="([^"]+)"/);
      const viewBox = viewBoxMatch ? viewBoxMatch[1] : "0 0 24 24";
      const innerContent = result.data
        .replace(/<svg[^>]*>/, "")
        .replace(/<\/svg>/, "");

      return `<symbol id="${name}" viewBox="${viewBox}">${innerContent}</symbol>`;
    }),
  );

  const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${symbols.join("")}</svg>`;

  await writeFile(outputPath, sprite);
  console.log(`Generated sprite with ${symbols.length} icons`);
}
```

### Icon Libraries Integration

```tsx
// Lucide React
import { Home, Settings, User, Search } from "lucide-react";

function Navigation() {
  return (
    <nav className="flex gap-4">
      <NavItem icon={Home} label="Home" />
      <NavItem icon={Search} label="Search" />
      <NavItem icon={Settings} label="Settings" />
      <NavItem icon={User} label="Profile" />
    </nav>
  );
}

// Heroicons
import { HomeIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import { HomeIcon as HomeIconSolid } from "@heroicons/react/24/solid";

function ToggleIcon({ active }: { active: boolean }) {
  const Icon = active ? HomeIconSolid : HomeIcon;
  return <Icon className="w-6 h-6" />;
}

// Radix Icons
import { HomeIcon, GearIcon } from "@radix-ui/react-icons";
```

## Sizing Systems

### Element Sizing Scale

```css
:root {
  /* Fixed sizes */
  --size-4: 1rem; /* 16px */
  --size-5: 1.25rem; /* 20px */
  --size-6: 1.5rem; /* 24px */
  --size-8: 2rem; /* 32px */
  --size-10: 2.5rem; /* 40px */
  --size-12: 3rem; /* 48px */
  --size-14: 3.5rem; /* 56px */
  --size-16: 4rem; /* 64px */
  --size-20: 5rem; /* 80px */
  --size-24: 6rem; /* 96px */
  --size-32: 8rem; /* 128px */

  /* Component heights */
  --height-input-sm: var(--size-8); /* 32px */
  --height-input-md: var(--size-10); /* 40px */
  --height-input-lg: var(--size-12); /* 48px */

  /* Avatar sizes */
  --avatar-xs: var(--size-6); /* 24px */
  --avatar-sm: var(--size-8); /* 32px */
  --avatar-md: var(--size-10); /* 40px */
  --avatar-lg: var(--size-12); /* 48px */
  --avatar-xl: var(--size-16); /* 64px */
  --avatar-2xl: var(--size-24); /* 96px */
}
```

### Aspect Ratios

```css
.aspect-ratios {
  /* Standard ratios */
  --aspect-square: 1 / 1;
  --aspect-video: 16 / 9;
  --aspect-photo: 4 / 3;
  --aspect-portrait: 3 / 4;
  --aspect-cinema: 21 / 9;
  --aspect-golden: 1.618 / 1;
}

/* Usage */
.thumbnail {
  aspect-ratio: var(--aspect-video);
  object-fit: cover;
}

.avatar {
  aspect-ratio: var(--aspect-square);
  border-radius: 50%;
}
```

### Border Radius Scale

```css
:root {
  --radius-none: 0;
  --radius-sm: 0.125rem; /* 2px */
  --radius-default: 0.25rem; /* 4px */
  --radius-md: 0.375rem; /* 6px */
  --radius-lg: 0.5rem; /* 8px */
  --radius-xl: 0.75rem; /* 12px */
  --radius-2xl: 1rem; /* 16px */
  --radius-3xl: 1.5rem; /* 24px */
  --radius-full: 9999px;

  /* Component-specific */
  --radius-button: var(--radius-md);
  --radius-input: var(--radius-md);
  --radius-card: var(--radius-lg);
  --radius-modal: var(--radius-xl);
  --radius-badge: var(--radius-full);
}
```
````

## Skill: interaction-design (engineering.zip, engineering/interaction-design/)

### `/tmp/or-atom-008-corpus/engineering/interaction-design/SKILL.md`

````{txt}
---
name: interaction-design
description: Design and implement microinteractions, motion design, transitions, and user feedback patterns. Use when adding polish to UI interactions, implementing loading states, or creating delightful user experiences.
---

# Interaction Design

Create engaging, intuitive interactions through motion, feedback, and thoughtful state transitions that enhance usability and delight users.

## When to Use This Skill

- Adding microinteractions to enhance user feedback
- Implementing smooth page and component transitions
- Designing loading states and skeleton screens
- Creating gesture-based interactions
- Building notification and toast systems
- Implementing drag-and-drop interfaces
- Adding scroll-triggered animations
- Designing hover and focus states

## Core Principles

### 1. Purposeful Motion

Motion should communicate, not decorate:

- **Feedback**: Confirm user actions occurred
- **Orientation**: Show where elements come from/go to
- **Focus**: Direct attention to important changes
- **Continuity**: Maintain context during transitions

### 2. Timing Guidelines

| Duration  | Use Case                                  |
| --------- | ----------------------------------------- |
| 100-150ms | Micro-feedback (hovers, clicks)           |
| 200-300ms | Small transitions (toggles, dropdowns)    |
| 300-500ms | Medium transitions (modals, page changes) |
| 500ms+    | Complex choreographed animations          |

### 3. Easing Functions

```css
/* Common easings */
--ease-out: cubic-bezier(0.16, 1, 0.3, 1); /* Decelerate - entering */
--ease-in: cubic-bezier(0.55, 0, 1, 0.45); /* Accelerate - exiting */
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1); /* Both - moving between */
--spring: cubic-bezier(0.34, 1.56, 0.64, 1); /* Overshoot - playful */
```

## Quick Start: Button Microinteraction

```tsx
import { motion } from "framer-motion";

export function InteractiveButton({ children, onClick }) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 17 }}
      className="px-4 py-2 bg-blue-600 text-white rounded-lg"
    >
      {children}
    </motion.button>
  );
}
```

## Interaction Patterns

### 1. Loading States

**Skeleton Screens**: Preserve layout while loading

```tsx
function CardSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-48 bg-gray-200 rounded-lg" />
      <div className="mt-4 h-4 bg-gray-200 rounded w-3/4" />
      <div className="mt-2 h-4 bg-gray-200 rounded w-1/2" />
    </div>
  );
}
```

**Progress Indicators**: Show determinate progress

```tsx
function ProgressBar({ progress }: { progress: number }) {
  return (
    <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
      <motion.div
        className="h-full bg-blue-600"
        initial={{ width: 0 }}
        animate={{ width: `${progress}%` }}
        transition={{ ease: "easeOut" }}
      />
    </div>
  );
}
```

### 2. State Transitions

**Toggle with smooth transition**:

```tsx
function Toggle({ checked, onChange }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`
        relative w-12 h-6 rounded-full transition-colors duration-200
        ${checked ? "bg-blue-600" : "bg-gray-300"}
      `}
    >
      <motion.span
        className="absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow"
        animate={{ x: checked ? 24 : 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      />
    </button>
  );
}
```

### 3. Page Transitions

**Framer Motion layout animations**:

```tsx
import { AnimatePresence, motion } from "framer-motion";

function PageTransition({ children, key }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={key}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.3 }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
```

### 4. Feedback Patterns

**Ripple effect on click**:

```tsx
function RippleButton({ children, onClick }) {
  const [ripples, setRipples] = useState([]);

  const handleClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ripple = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      id: Date.now(),
    };
    setRipples((prev) => [...prev, ripple]);
    setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== ripple.id));
    }, 600);
    onClick?.(e);
  };

  return (
    <button onClick={handleClick} className="relative overflow-hidden">
      {children}
      {ripples.map((ripple) => (
        <span
          key={ripple.id}
          className="absolute bg-white/30 rounded-full animate-ripple"
          style={{ left: ripple.x, top: ripple.y }}
        />
      ))}
    </button>
  );
}
```

### 5. Gesture Interactions

**Swipe to dismiss**:

```tsx
function SwipeCard({ children, onDismiss }) {
  return (
    <motion.div
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > 100) {
          onDismiss();
        }
      }}
      className="cursor-grab active:cursor-grabbing"
    >
      {children}
    </motion.div>
  );
}
```

## CSS Animation Patterns

### Keyframe Animations

```css
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.animate-fadeIn {
  animation: fadeIn 0.3s ease-out;
}
.animate-pulse {
  animation: pulse 2s ease-in-out infinite;
}
.animate-spin {
  animation: spin 1s linear infinite;
}
```

### CSS Transitions

```css
.card {
  transition:
    transform 0.2s ease-out,
    box-shadow 0.2s ease-out;
}

.card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.1);
}
```

## Accessibility Considerations

```css
/* Respect user motion preferences */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

```tsx
function AnimatedComponent() {
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  return (
    <motion.div
      animate={{ opacity: 1 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.3 }}
    />
  );
}
```

## Best Practices

1. **Performance First**: Use `transform` and `opacity` for smooth 60fps
2. **Reduce Motion Support**: Always respect `prefers-reduced-motion`
3. **Consistent Timing**: Use a timing scale across the app
4. **Natural Physics**: Prefer spring animations over linear
5. **Interruptible**: Allow users to cancel long animations
6. **Progressive Enhancement**: Work without JS animations
7. **Test on Devices**: Performance varies significantly

## Common Issues

- **Janky Animations**: Avoid animating `width`, `height`, `top`, `left`
- **Over-animation**: Too much motion causes fatigue
- **Blocking Interactions**: Never prevent user input during animations
- **Memory Leaks**: Clean up animation listeners on unmount
- **Flash of Content**: Use `will-change` sparingly for optimization
````

### `/tmp/or-atom-008-corpus/engineering/interaction-design/references/animation-libraries.md`

````{txt}
# Animation Libraries Reference

## Framer Motion

The most popular React animation library with declarative API.

### Basic Animations

```tsx
import { motion, AnimatePresence } from "framer-motion";

// Simple animation
function FadeIn({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      {children}
    </motion.div>
  );
}

// Gesture animations
function InteractiveCard() {
  return (
    <motion.div
      whileHover={{ scale: 1.02, y: -4 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 17 }}
      className="p-6 bg-white rounded-lg shadow"
    >
      Hover or tap me
    </motion.div>
  );
}

// Keyframes animation
function PulseButton() {
  return (
    <motion.button
      animate={{
        scale: [1, 1.05, 1],
        boxShadow: [
          "0 0 0 0 rgba(59, 130, 246, 0.5)",
          "0 0 0 10px rgba(59, 130, 246, 0)",
          "0 0 0 0 rgba(59, 130, 246, 0)",
        ],
      }}
      transition={{ duration: 2, repeat: Infinity }}
      className="px-4 py-2 bg-blue-600 text-white rounded"
    >
      Click me
    </motion.button>
  );
}
```

### Layout Animations

```tsx
import { motion, LayoutGroup } from "framer-motion";

// Shared layout animation
function TabIndicator({ activeTab, tabs }) {
  return (
    <div className="flex border-b">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className="relative px-4 py-2"
        >
          {tab.label}
          {activeTab === tab.id && (
            <motion.div
              layoutId="activeTab"
              className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600"
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            />
          )}
        </button>
      ))}
    </div>
  );
}

// Auto-layout reordering
function ReorderableList({ items, setItems }) {
  return (
    <Reorder.Group axis="y" values={items} onReorder={setItems}>
      {items.map((item) => (
        <Reorder.Item
          key={item.id}
          value={item}
          className="bg-white p-4 rounded-lg shadow mb-2 cursor-grab active:cursor-grabbing"
        >
          {item.title}
        </Reorder.Item>
      ))}
    </Reorder.Group>
  );
}
```

### Orchestration

```tsx
// Staggered children
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3 },
  },
};

function StaggeredList({ items }) {
  return (
    <motion.ul variants={containerVariants} initial="hidden" animate="visible">
      {items.map((item) => (
        <motion.li key={item.id} variants={itemVariants}>
          {item.content}
        </motion.li>
      ))}
    </motion.ul>
  );
}
```

### Page Transitions

```tsx
import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/router";

const pageVariants = {
  initial: { opacity: 0, x: -20 },
  enter: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 20 },
};

function PageTransition({ children }) {
  const router = useRouter();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={router.pathname}
        variants={pageVariants}
        initial="initial"
        animate="enter"
        exit="exit"
        transition={{ duration: 0.3 }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
```

## GSAP (GreenSock)

Industry-standard animation library for complex, performant animations.

### Basic Timeline

```tsx
import { useRef, useLayoutEffect } from "react";
import gsap from "gsap";

function AnimatedHero() {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subtitleRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

      tl.from(titleRef.current, {
        y: 50,
        opacity: 0,
        duration: 0.8,
      })
        .from(
          subtitleRef.current,
          {
            y: 30,
            opacity: 0,
            duration: 0.6,
          },
          "-=0.4", // Start 0.4s before previous ends
        )
        .from(".cta-button", {
          scale: 0.8,
          opacity: 0,
          duration: 0.4,
        });
    }, containerRef);

    return () => ctx.revert(); // Cleanup
  }, []);

  return (
    <div ref={containerRef}>
      <h1 ref={titleRef}>Welcome</h1>
      <p ref={subtitleRef}>Discover amazing things</p>
      <button className="cta-button">Get Started</button>
    </div>
  );
}
```

### ScrollTrigger

```tsx
import { useLayoutEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

function ParallaxSection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      // Parallax image
      gsap.to(imageRef.current, {
        yPercent: -20,
        ease: "none",
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top bottom",
          end: "bottom top",
          scrub: true,
        },
      });

      // Fade in content
      gsap.from(".content-block", {
        opacity: 0,
        y: 50,
        stagger: 0.2,
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top 80%",
          end: "top 20%",
          scrub: 1,
        },
      });
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} className="relative overflow-hidden">
      <img ref={imageRef} src="/hero.jpg" alt="" className="absolute inset-0" />
      <div className="relative z-10">
        <div className="content-block">Block 1</div>
        <div className="content-block">Block 2</div>
      </div>
    </section>
  );
}
```

### Text Animation

```tsx
import { useLayoutEffect, useRef } from "react";
import gsap from "gsap";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(SplitText);

function AnimatedHeadline({ text }) {
  const textRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const split = new SplitText(textRef.current, {
      type: "chars,words",
      charsClass: "char",
    });

    gsap.from(split.chars, {
      opacity: 0,
      y: 50,
      rotateX: -90,
      stagger: 0.02,
      duration: 0.8,
      ease: "back.out(1.7)",
    });

    return () => split.revert();
  }, [text]);

  return <h1 ref={textRef}>{text}</h1>;
}
```

## CSS Spring Physics

```tsx
// spring.ts - Custom spring physics
interface SpringConfig {
  stiffness: number; // Higher = snappier
  damping: number; // Higher = less bouncy
  mass: number;
}

const presets: Record<string, SpringConfig> = {
  default: { stiffness: 170, damping: 26, mass: 1 },
  gentle: { stiffness: 120, damping: 14, mass: 1 },
  wobbly: { stiffness: 180, damping: 12, mass: 1 },
  stiff: { stiffness: 210, damping: 20, mass: 1 },
  slow: { stiffness: 280, damping: 60, mass: 1 },
  molasses: { stiffness: 280, damping: 120, mass: 1 },
};

function springToCss(config: SpringConfig): string {
  // Convert spring parameters to CSS timing function approximation
  const { stiffness, damping } = config;
  const duration = Math.sqrt(stiffness) / damping;
  const bounce = 1 - damping / (2 * Math.sqrt(stiffness));

  // Map to cubic-bezier (approximation)
  if (bounce <= 0) {
    return `cubic-bezier(0.25, 0.1, 0.25, 1)`;
  }
  return `cubic-bezier(0.34, 1.56, 0.64, 1)`;
}
```

## Web Animations API

Native browser animation API for simple animations.

```tsx
function useWebAnimation(
  ref: RefObject<HTMLElement>,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
) {
  useEffect(() => {
    if (!ref.current) return;

    const animation = ref.current.animate(keyframes, options);

    return () => animation.cancel();
  }, [ref, keyframes, options]);
}

// Usage
function SlideIn({ children }) {
  const elementRef = useRef<HTMLDivElement>(null);

  useWebAnimation(
    elementRef,
    [
      { transform: "translateX(-100%)", opacity: 0 },
      { transform: "translateX(0)", opacity: 1 },
    ],
    {
      duration: 300,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      fill: "forwards",
    },
  );

  return <div ref={elementRef}>{children}</div>;
}
```

## View Transitions API

Native browser API for page transitions.

```tsx
// Check support
const supportsViewTransitions = "startViewTransition" in document;

// Simple page transition
async function navigateTo(url: string) {
  if (!document.startViewTransition) {
    window.location.href = url;
    return;
  }

  document.startViewTransition(async () => {
    await fetch(url);
    // Update DOM
  });
}

// Named elements for morphing
function ProductCard({ product }) {
  return (
    <Link href={`/product/${product.id}`}>
      <img
        src={product.image}
        style={{ viewTransitionName: `product-${product.id}` }}
      />
    </Link>
  );
}

// CSS for view transitions
/*
::view-transition-old(root) {
  animation: fade-out 0.25s ease-out;
}

::view-transition-new(root) {
  animation: fade-in 0.25s ease-in;
}

::view-transition-group(product-*) {
  animation-duration: 0.3s;
}
*/
```

## Performance Tips

### GPU Acceleration

```css
/* Properties that trigger GPU acceleration */
.animated-element {
  transform: translateZ(0); /* Force GPU layer */
  will-change: transform, opacity; /* Hint to browser */
}

/* Only animate transform and opacity for 60fps */
.smooth {
  transition:
    transform 0.3s ease,
    opacity 0.3s ease;
}

/* Avoid animating these (cause reflow) */
.avoid {
  /* Don't animate: width, height, top, left, margin, padding */
}
```

### Reduced Motion

```tsx
function useReducedMotion() {
  const [prefersReduced, setPrefersReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReduced(mq.matches);

    const handler = (e: MediaQueryListEvent) => setPrefersReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return prefersReduced;
}

// Usage
function AnimatedComponent() {
  const prefersReduced = useReducedMotion();

  return (
    <motion.div
      initial={{ opacity: 0, y: prefersReduced ? 0 : 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: prefersReduced ? 0 : 0.3 }}
    >
      Content
    </motion.div>
  );
}
```
````

### `/tmp/or-atom-008-corpus/engineering/interaction-design/references/microinteraction-patterns.md`

````{txt}
# Microinteraction Patterns Reference

## Button States

### Loading Button

```tsx
import { motion, AnimatePresence } from "framer-motion";

interface LoadingButtonProps {
  isLoading: boolean;
  children: React.ReactNode;
  onClick: () => void;
}

function LoadingButton({ isLoading, children, onClick }: LoadingButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={isLoading}
      className="relative px-4 py-2 bg-blue-600 text-white rounded-lg overflow-hidden"
    >
      <AnimatePresence mode="wait">
        {isLoading ? (
          <motion.span
            key="loading"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="flex items-center gap-2"
          >
            <Spinner className="w-4 h-4" />
            Processing...
          </motion.span>
        ) : (
          <motion.span
            key="idle"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            {children}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

// Spinner component
function Spinner({ className }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
        fill="none"
        strokeDasharray="62.83"
        strokeDashoffset="15"
        strokeLinecap="round"
      />
    </svg>
  );
}
```

### Success/Error State

```tsx
function SubmitButton({ onSubmit }: { onSubmit: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">(
    "idle",
  );

  const handleClick = async () => {
    setState("loading");
    try {
      await onSubmit();
      setState("success");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2000);
    }
  };

  const icons = {
    idle: null,
    loading: <Spinner className="w-5 h-5" />,
    success: <CheckIcon className="w-5 h-5" />,
    error: <XIcon className="w-5 h-5" />,
  };

  const colors = {
    idle: "bg-blue-600 hover:bg-blue-700",
    loading: "bg-blue-600",
    success: "bg-green-600",
    error: "bg-red-600",
  };

  return (
    <motion.button
      onClick={handleClick}
      disabled={state === "loading"}
      className={`flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors ${colors[state]}`}
      animate={{
        scale: state === "success" || state === "error" ? [1, 1.05, 1] : 1,
      }}
    >
      <AnimatePresence mode="wait">
        {icons[state] && (
          <motion.span
            key={state}
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            exit={{ scale: 0, rotate: 180 }}
          >
            {icons[state]}
          </motion.span>
        )}
      </AnimatePresence>
      {state === "idle" && "Submit"}
      {state === "loading" && "Submitting..."}
      {state === "success" && "Done!"}
      {state === "error" && "Failed"}
    </motion.button>
  );
}
```

## Form Interactions

### Floating Label Input

```tsx
import { useState, useId } from "react";

function FloatingInput({
  label,
  type = "text",
}: {
  label: string;
  type?: string;
}) {
  const [value, setValue] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const id = useId();

  const isFloating = isFocused || value.length > 0;

  return (
    <div className="relative">
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        className="peer w-full px-4 py-3 border rounded-lg outline-none transition-colors
          focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
      />
      <label
        htmlFor={id}
        className={`absolute left-4 transition-all duration-200 pointer-events-none
          ${
            isFloating
              ? "top-0 -translate-y-1/2 text-xs bg-white px-1 text-blue-600"
              : "top-1/2 -translate-y-1/2 text-gray-500"
          }`}
      >
        {label}
      </label>
    </div>
  );
}
```

### Shake on Error

```tsx
import { motion, useAnimation } from "framer-motion";

function ShakeInput({ error, ...props }: InputProps & { error?: string }) {
  const controls = useAnimation();

  useEffect(() => {
    if (error) {
      controls.start({
        x: [0, -10, 10, -10, 10, 0],
        transition: { duration: 0.4 },
      });
    }
  }, [error, controls]);

  return (
    <motion.div animate={controls}>
      <input
        {...props}
        className={`w-full px-4 py-2 border rounded-lg ${
          error ? "border-red-500" : "border-gray-300"
        }`}
      />
      {error && (
        <motion.p
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-1 text-sm text-red-500"
        >
          {error}
        </motion.p>
      )}
    </motion.div>
  );
}
```

### Character Count

```tsx
function TextareaWithCount({ maxLength = 280 }: { maxLength?: number }) {
  const [value, setValue] = useState("");
  const remaining = maxLength - value.length;
  const isNearLimit = remaining <= 20;
  const isOverLimit = remaining < 0;

  return (
    <div className="relative">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full px-4 py-3 border rounded-lg resize-none"
        rows={4}
      />
      <motion.span
        className={`absolute bottom-2 right-2 text-sm ${
          isOverLimit
            ? "text-red-500"
            : isNearLimit
              ? "text-yellow-500"
              : "text-gray-400"
        }`}
        animate={{ scale: isNearLimit ? [1, 1.1, 1] : 1 }}
        transition={{ duration: 0.2 }}
      >
        {remaining}
      </motion.span>
    </div>
  );
}
```

## Feedback Patterns

### Toast Notifications

```tsx
import { motion, AnimatePresence } from "framer-motion";
import { createContext, useContext, useState, useCallback } from "react";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
}

const ToastContext = createContext<{
  addToast: (message: string, type: Toast["type"]) => void;
} | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: Toast["type"]) => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed bottom-4 right-4 space-y-2 z-50">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 100, scale: 0.95 }}
              className={`px-4 py-3 rounded-lg shadow-lg ${
                toast.type === "success"
                  ? "bg-green-600"
                  : toast.type === "error"
                    ? "bg-red-600"
                    : "bg-blue-600"
              } text-white`}
            >
              {toast.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be within ToastProvider");
  return context;
}
```

### Confirmation Dialog

```tsx
function ConfirmButton({
  onConfirm,
  confirmText = "Click again to confirm",
  children,
}: {
  onConfirm: () => void;
  confirmText?: string;
  children: React.ReactNode;
}) {
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    if (isPending) {
      const timer = setTimeout(() => setIsPending(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [isPending]);

  const handleClick = () => {
    if (isPending) {
      onConfirm();
      setIsPending(false);
    } else {
      setIsPending(true);
    }
  };

  return (
    <motion.button
      onClick={handleClick}
      className={`px-4 py-2 rounded-lg transition-colors ${
        isPending ? "bg-red-600 text-white" : "bg-gray-200 text-gray-800"
      }`}
      animate={{ scale: isPending ? [1, 1.02, 1] : 1 }}
    >
      <AnimatePresence mode="wait">
        <motion.span
          key={isPending ? "confirm" : "idle"}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
        >
          {isPending ? confirmText : children}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
```

## Navigation Patterns

### Active Link Indicator

```tsx
import { motion } from "framer-motion";
import { usePathname } from "next/navigation";

function Navigation({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 p-1 bg-gray-100 rounded-lg">
      {items.map((item) => {
        const isActive = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`relative px-4 py-2 text-sm font-medium ${
              isActive ? "text-white" : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {isActive && (
              <motion.div
                layoutId="activeNav"
                className="absolute inset-0 bg-blue-600 rounded-md"
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              />
            )}
            <span className="relative z-10">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
```

### Hamburger Menu Icon

```tsx
function MenuIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <button className="relative w-6 h-6" aria-label="Toggle menu">
      <motion.span
        className="absolute left-0 h-0.5 w-6 bg-current"
        animate={{
          top: isOpen ? "50%" : "25%",
          rotate: isOpen ? 45 : 0,
          translateY: isOpen ? "-50%" : 0,
        }}
        transition={{ duration: 0.2 }}
      />
      <motion.span
        className="absolute left-0 top-1/2 h-0.5 w-6 bg-current -translate-y-1/2"
        animate={{ opacity: isOpen ? 0 : 1, scaleX: isOpen ? 0 : 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.span
        className="absolute left-0 h-0.5 w-6 bg-current"
        animate={{
          bottom: isOpen ? "50%" : "25%",
          rotate: isOpen ? -45 : 0,
          translateY: isOpen ? "50%" : 0,
        }}
        transition={{ duration: 0.2 }}
      />
    </button>
  );
}
```

## Data Interactions

### Optimistic Updates

```tsx
function LikeButton({ postId, initialLiked, initialCount }) {
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);

  const handleLike = async () => {
    // Optimistic update
    const newLiked = !liked;
    setLiked(newLiked);
    setCount((c) => c + (newLiked ? 1 : -1));

    try {
      await api.toggleLike(postId);
    } catch {
      // Rollback on error
      setLiked(!newLiked);
      setCount((c) => c + (newLiked ? -1 : 1));
    }
  };

  return (
    <motion.button
      onClick={handleLike}
      whileTap={{ scale: 0.9 }}
      className={`flex items-center gap-2 ${liked ? "text-red-500" : "text-gray-500"}`}
    >
      <motion.span
        animate={{ scale: liked ? [1, 1.3, 1] : 1 }}
        transition={{ duration: 0.3 }}
      >
        {liked ? <HeartFilledIcon /> : <HeartIcon />}
      </motion.span>
      <AnimatePresence mode="wait">
        <motion.span
          key={count}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
        >
          {count}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
```

### Pull to Refresh

```tsx
import { motion, useMotionValue, useTransform } from "framer-motion";

function PullToRefresh({ onRefresh, children }) {
  const y = useMotionValue(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const opacity = useTransform(y, [0, 60], [0, 1]);
  const rotate = useTransform(y, [0, 60], [0, 180]);

  const handleDragEnd = async (_, info) => {
    if (info.offset.y > 60 && !isRefreshing) {
      setIsRefreshing(true);
      await onRefresh();
      setIsRefreshing(false);
    }
  };

  return (
    <div className="overflow-hidden">
      <motion.div style={{ opacity }} className="flex justify-center py-4">
        <motion.div style={{ rotate }}>
          {isRefreshing ? <Spinner /> : <ArrowDownIcon />}
        </motion.div>
      </motion.div>
      <motion.div
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.5, bottom: 0 }}
        style={{ y }}
        onDragEnd={handleDragEnd}
      >
        {children}
      </motion.div>
    </div>
  );
}
```
````

### `/tmp/or-atom-008-corpus/engineering/interaction-design/references/scroll-animations.md`

````{txt}
# Scroll Animations Reference

## Intersection Observer Hook

```tsx
import { useEffect, useRef, useState, type RefObject } from "react";

interface UseInViewOptions {
  threshold?: number | number[];
  rootMargin?: string;
  triggerOnce?: boolean;
}

function useInView<T extends HTMLElement>({
  threshold = 0,
  rootMargin = "0px",
  triggerOnce = false,
}: UseInViewOptions = {}): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const inView = entry.isIntersecting;
        setIsInView(inView);
        if (inView && triggerOnce) {
          observer.unobserve(element);
        }
      },
      { threshold, rootMargin },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold, rootMargin, triggerOnce]);

  return [ref, isInView];
}

// Usage
function FadeInSection({ children }) {
  const [ref, isInView] = useInView({ threshold: 0.2, triggerOnce: true });

  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ${
        isInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
      }`}
    >
      {children}
    </div>
  );
}
```

## Scroll Progress Indicator

```tsx
import { motion, useScroll, useSpring } from "framer-motion";

function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 100,
    damping: 30,
    restDelta: 0.001,
  });

  return (
    <motion.div
      className="fixed top-0 left-0 right-0 h-1 bg-blue-600 origin-left z-50"
      style={{ scaleX }}
    />
  );
}
```

## Parallax Scrolling

### Simple CSS Parallax

```css
.parallax-container {
  height: 100vh;
  overflow-x: hidden;
  overflow-y: auto;
  perspective: 10px;
}

.parallax-layer-back {
  transform: translateZ(-10px) scale(2);
}

.parallax-layer-base {
  transform: translateZ(0);
}
```

### Framer Motion Parallax

```tsx
import { motion, useScroll, useTransform } from "framer-motion";

function ParallaxHero() {
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  });

  const y = useTransform(scrollYProgress, [0, 1], ["0%", "50%"]);
  const opacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [1, 1.2]);

  return (
    <section ref={ref} className="relative h-screen overflow-hidden">
      {/* Background image with parallax */}
      <motion.div style={{ y, scale }} className="absolute inset-0">
        <img src="/hero-bg.jpg" alt="" className="w-full h-full object-cover" />
      </motion.div>

      {/* Content fades out on scroll */}
      <motion.div
        style={{ opacity }}
        className="relative z-10 flex items-center justify-center h-full"
      >
        <h1 className="text-6xl font-bold text-white">Welcome</h1>
      </motion.div>
    </section>
  );
}
```

## Scroll-Linked Animations

### Progress-Based Animation

```tsx
function ScrollAnimation() {
  const containerRef = useRef(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start end", "end start"],
  });

  // Different transformations based on scroll progress
  const x = useTransform(scrollYProgress, [0, 1], [-200, 200]);
  const rotate = useTransform(scrollYProgress, [0, 1], [0, 360]);
  const backgroundColor = useTransform(
    scrollYProgress,
    [0, 0.5, 1],
    ["#3b82f6", "#8b5cf6", "#ec4899"],
  );

  return (
    <div ref={containerRef} className="h-[200vh] py-20">
      <div className="sticky top-1/2 -translate-y-1/2 flex justify-center">
        <motion.div
          style={{ x, rotate, backgroundColor }}
          className="w-32 h-32 rounded-2xl"
        />
      </div>
    </div>
  );
}
```

### Horizontal Scroll Section

```tsx
function HorizontalScroll({ items }) {
  const containerRef = useRef(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end end"],
  });

  const x = useTransform(
    scrollYProgress,
    [0, 1],
    ["0%", `-${(items.length - 1) * 100}%`],
  );

  return (
    <section ref={containerRef} className="relative h-[300vh]">
      <div className="sticky top-0 h-screen overflow-hidden">
        <motion.div style={{ x }} className="flex h-full">
          {items.map((item, i) => (
            <div
              key={i}
              className="flex-shrink-0 w-screen h-full flex items-center justify-center"
            >
              {item}
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
```

## Reveal Animations

### Staggered List Reveal

```tsx
function StaggeredList({ items }) {
  const [ref, isInView] = useInView({ threshold: 0.1, triggerOnce: true });

  return (
    <ul ref={ref} className="space-y-4">
      {items.map((item, i) => (
        <motion.li
          key={item.id}
          initial={{ opacity: 0, x: -20 }}
          animate={isInView ? { opacity: 1, x: 0 } : {}}
          transition={{ delay: i * 0.1, duration: 0.5 }}
          className="p-4 bg-white rounded-lg shadow"
        >
          {item.content}
        </motion.li>
      ))}
    </ul>
  );
}
```

### Text Reveal

```tsx
function TextReveal({ text }) {
  const [ref, isInView] = useInView({ threshold: 0.5, triggerOnce: true });
  const words = text.split(" ");

  return (
    <p ref={ref} className="text-4xl font-bold">
      {words.map((word, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: i * 0.05, duration: 0.3 }}
          className="inline-block mr-2"
        >
          {word}
        </motion.span>
      ))}
    </p>
  );
}
```

### Clip Path Reveal

```tsx
function ClipReveal({ children }) {
  const [ref, isInView] = useInView({ threshold: 0.3, triggerOnce: true });

  return (
    <motion.div
      ref={ref}
      initial={{ clipPath: "inset(0 100% 0 0)" }}
      animate={isInView ? { clipPath: "inset(0 0% 0 0)" } : {}}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
```

## Sticky Scroll Sections

```tsx
function StickySection({ title, content, image }) {
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  });

  const opacity = useTransform(scrollYProgress, [0, 0.5, 1], [1, 1, 0]);
  const scale = useTransform(scrollYProgress, [0, 0.5, 1], [1, 1, 0.8]);

  return (
    <section ref={ref} className="relative h-[200vh]">
      <motion.div
        style={{ opacity, scale }}
        className="sticky top-0 h-screen flex items-center"
      >
        <div className="grid grid-cols-2 gap-16 container mx-auto">
          <div>
            <h2 className="text-4xl font-bold">{title}</h2>
            <p className="mt-4 text-lg text-gray-600">{content}</p>
          </div>
          <div>
            <img src={image} alt="" className="rounded-2xl shadow-xl" />
          </div>
        </div>
      </motion.div>
    </section>
  );
}
```

## Smooth Scroll

```tsx
// Using CSS
html {
  scroll-behavior: smooth;
}

// Using Lenis for butter-smooth scrolling
import Lenis from '@studio-freight/lenis';

function SmoothScrollProvider({ children }) {
  useEffect(() => {
    const lenis = new Lenis({
      duration: 1.2,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      direction: 'vertical',
      smooth: true,
    });

    function raf(time) {
      lenis.raf(time);
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);

    return () => lenis.destroy();
  }, []);

  return children;
}
```

## Scroll Snap

```css
/* Scroll snap container */
.snap-container {
  scroll-snap-type: y mandatory;
  overflow-y: scroll;
  height: 100vh;
}

.snap-section {
  scroll-snap-align: start;
  height: 100vh;
}

/* Smooth scrolling with snap */
@supports (scroll-snap-type: y mandatory) {
  .snap-container {
    scroll-behavior: smooth;
  }
}
```

```tsx
function FullPageScroll({ sections }) {
  return (
    <div className="snap-container">
      {sections.map((section, i) => (
        <section
          key={i}
          className="snap-section flex items-center justify-center"
        >
          {section}
        </section>
      ))}
    </div>
  );
}
```

## Performance Optimization

```tsx
// Use will-change sparingly
const AnimatedElement = styled(motion.div)`
  will-change: transform;
`;

// Debounce scroll handlers
function useThrottledScroll(callback, delay = 16) {
  const lastRun = useRef(0);

  useEffect(() => {
    const handler = () => {
      const now = Date.now();
      if (now - lastRun.current >= delay) {
        lastRun.current = now;
        callback();
      }
    };

    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, [callback, delay]);
}

// Use transform instead of top/left
// Good
const goodAnimation = { transform: "translateY(100px)" };
// Bad (causes reflow)
const badAnimation = { top: "100px" };
```
````

## Skill: game-developer (fullstack-development.zip, fullstack-development/game-developer/)

### `/tmp/or-atom-008-corpus/fullstack-development/game-developer/SKILL.md`

````{txt}
---
name: game-developer
description: "Use when building game systems, implementing Unity/Unreal Engine features, or optimizing game performance. Invoke to implement ECS architecture, configure physics systems and colliders, set up multiplayer networking with lag compensation, optimize frame rates to 60+ FPS targets, develop shaders, or apply game design patterns such as object pooling and state machines. Trigger keywords: Unity, Unreal Engine, game development, ECS architecture, game physics, multiplayer networking, game optimization, shader programming, game AI."
license: MIT
metadata:
  version: "1.1.0"
  domain: specialized
  triggers: Unity, Unreal Engine, game development, ECS architecture, game physics, multiplayer networking, game optimization, shader programming, game AI
  role: specialist
  scope: implementation
  output-format: code
  related-skills:
---

# Game Developer

## Core Workflow

1. **Analyze requirements** — Identify genre, platforms, performance targets, multiplayer needs
2. **Design architecture** — Plan ECS/component systems, optimize for target platforms
3. **Implement** — Build core mechanics, graphics, physics, AI, networking
4. **Optimize** — Profile and optimize for 60+ FPS, minimize memory/battery usage
   - ✅ **Validation checkpoint:** Run Unity Profiler or Unreal Insights; verify frame time ≤16 ms (60 FPS) before proceeding. Identify and resolve CPU/GPU bottlenecks iteratively.
5. **Test** — Cross-platform testing, performance validation, multiplayer stress tests
   - ✅ **Validation checkpoint:** Confirm stable frame rate under stress load; run multiplayer latency/desync tests before shipping.

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Unity Development | `references/unity-patterns.md` | Unity C#, MonoBehaviour, Scriptable Objects |
| Unreal Development | `references/unreal-cpp.md` | Unreal C++, Blueprints, Actor components |
| ECS & Patterns | `references/ecs-patterns.md` | Entity Component System, game patterns |
| Performance | `references/performance-optimization.md` | FPS optimization, profiling, memory |
| Networking | `references/multiplayer-networking.md` | Multiplayer, client-server, lag compensation |

## Constraints

### MUST DO
- Target 60+ FPS on all platforms
- Use object pooling for frequent instantiation
- Implement LOD systems for optimization
- Profile performance regularly (CPU, GPU, memory)
- Use async loading for resources
- Implement proper state machines for game logic
- Cache component references (avoid GetComponent in Update)
- Use delta time for frame-independent movement

### MUST NOT DO
- Instantiate/Destroy in tight loops or Update()
- Skip profiling and performance testing
- Use string comparisons for tags (use CompareTag)
- Allocate memory in Update/FixedUpdate loops
- Ignore platform-specific constraints (mobile, console)
- Use Find methods in Update loops
- Hardcode game values (use ScriptableObjects/data files)

## Output Templates

When implementing game features, provide:
1. Core system implementation (ECS component, MonoBehaviour, or Actor)
2. Associated data structures (ScriptableObjects, structs, configs)
3. Performance considerations and optimizations
4. Brief explanation of architecture decisions

## Key Code Patterns

### Object Pooling (Unity C#)
```csharp
public class ObjectPool<T> where T : Component
{
    private readonly Queue<T> _pool = new();
    private readonly T _prefab;
    private readonly Transform _parent;

    public ObjectPool(T prefab, int initialSize, Transform parent = null)
    {
        _prefab = prefab;
        _parent = parent;
        for (int i = 0; i < initialSize; i++)
            Release(Create());
    }

    public T Get()
    {
        T obj = _pool.Count > 0 ? _pool.Dequeue() : Create();
        obj.gameObject.SetActive(true);
        return obj;
    }

    public void Release(T obj)
    {
        obj.gameObject.SetActive(false);
        _pool.Enqueue(obj);
    }

    private T Create() => Object.Instantiate(_prefab, _parent);
}
```

### Component Caching (Unity C#)
```csharp
public class PlayerController : MonoBehaviour
{
    // Cache all component references in Awake — never call GetComponent in Update
    private Rigidbody _rb;
    private Animator _animator;
    private PlayerInput _input;

    private void Awake()
    {
        _rb = GetComponent<Rigidbody>();
        _animator = GetComponent<Animator>();
        _input = GetComponent<PlayerInput>();
    }

    private void FixedUpdate()
    {
        // Use cached references; use deltaTime for frame-independence
        Vector3 move = _input.MoveDirection * (speed * Time.fixedDeltaTime);
        _rb.MovePosition(_rb.position + move);
    }
}
```

### State Machine (Unity C#)
```csharp
public abstract class State
{
    public abstract void Enter();
    public abstract void Tick(float deltaTime);
    public abstract void Exit();
}

public class StateMachine
{
    private State _current;

    public void TransitionTo(State next)
    {
        _current?.Exit();
        _current = next;
        _current.Enter();
    }

    public void Tick(float deltaTime) => _current?.Tick(deltaTime);
}

// Usage example
public class IdleState : State
{
    private readonly Animator _animator;
    public IdleState(Animator animator) => _animator = animator;
    public override void Enter() => _animator.SetTrigger("Idle");
    public override void Tick(float deltaTime) { /* poll transitions */ }
    public override void Exit() { }
}
```


````
