# Visual and technical references

## Included concept image priorities

1. `references/omniroute_neon_gpu_topology_dashboard.png`: Primary OmniRoute network visual target: luminous provider atoms and thin electrically active connections.
2. `references/neon_gpu_topology_dashboard.png`: Atom shell, neon line, job state and per-node GPU visual target.
3. `references/gpu_galaxy_neon_topology_dashboard.png`: Atmospheric scale and layered multi-atom network target.
4. `references/neon_gpu_atom_dashboard.png`: Tight nucleus/orbital closeup material target ONLY; do not clone its full dashboard layout.

These are concept visuals, not telemetry truth, not UI component templates, and not a request to rearrange the existing scene.

## Technical references verified October 2026

- React postprocessing Bloom: https://react-postprocessing.docs.pmnd.rs/effects/bloom — elevated emissive values, selective luminance thresholds, `toneMapped=false` on luminous materials.
- EffectComposer: https://react-postprocessing.docs.pmnd.rs/effect-composer
- R3F performance: https://github.com/pmndrs/react-three-fiber/blob/master/docs/advanced/scaling-performance.mdx — instancing and reused objects.
- R3F frame performance: https://github.com/pmndrs/react-three-fiber/blob/master/docs/advanced/pitfalls.mdx — avoid per-frame React state; reuse meshes/materials.
- three.js Material: https://threejs.org/docs/pages/Material.html — depthWrite/transparent sorting considerations.

Pin actual compatible library versions before adding dependencies. WebGL2 is the baseline. WebGPU or WASM is not required for this milestone unless profiled gains justify it.
