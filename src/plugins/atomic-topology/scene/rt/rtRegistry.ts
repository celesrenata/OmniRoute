/**
 * Disposal registry for ray-traced scene resources (three-free, testable).
 * Every GPU-owning object registers here; `disposeAll()` is idempotent and
 * reports how many live entries were released, so remount leaks are countable
 * without a GPU.
 */
export interface Disposable {
  dispose: () => void;
}

export interface RtRegistry {
  add: <T extends Disposable>(resource: T) => T;
  disposeAll: () => number;
  size: () => number;
}

export function createRtRegistry(): RtRegistry {
  const live = new Set<Disposable>();
  return {
    add(resource) {
      live.add(resource);
      return resource;
    },
    disposeAll() {
      const items = [...live];
      live.clear();
      for (const r of items) {
        try {
          r.dispose();
        } catch {
          // A resource that is already lost must not block releasing the rest.
        }
      }
      return items.length;
    },
    size: () => live.size,
  };
}
