import test from "node:test";
import assert from "node:assert/strict";
import { createAtomBatch } from "../../../src/plugins/atomic-topology/scene/rt/atomBatch";
import {
  createRtRegistry,
  type Disposable,
} from "../../../src/plugins/atomic-topology/scene/rt/rtRegistry";

test("batched atom layers register every GPU resource and dispose releases all of them", () => {
  const registry = createRtRegistry();
  const disposed: Disposable[] = [];
  const spy: typeof registry = {
    ...registry,
    add: (r) => {
      const wrapped = r.dispose.bind(r);
      r.dispose = () => {
        disposed.push(r);
        wrapped();
      };
      return registry.add(r);
    },
  };
  const batch = createAtomBatch(4, spy);
  const registered = registry.size();
  assert.ok(registered >= 8, `layers register their geometries/materials (got ${registered})`);
  batch.dispose();
  assert.equal(registry.size(), 0, "registry is empty after dispose");
  // Shared module-level textures/geometries are released too (re-created on demand).
  assert.ok(disposed.length >= registered - 4, "dispose() reached the registered resources");
  assert.doesNotThrow(() => batch.dispose(), "dispose is idempotent");
  assert.equal(registry.size(), 0);
});
