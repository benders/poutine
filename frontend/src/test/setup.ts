import "@testing-library/jest-dom/vitest";

// Some Node/jsdom combos expose `localStorage` as a non-function stub.
// Install a minimal in-memory implementation so module-load code like
// `localStorage.getItem("accessToken")` works under test.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
}

const memStorage = createMemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: memStorage,
  writable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: createMemoryStorage(),
  writable: true,
});
