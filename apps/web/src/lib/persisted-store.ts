// SPDX-License-Identifier: MIT

/**
 * A minimal `localStorage`-backed external store, for `useSyncExternalStore`.
 *
 * Deliberately not a dependency (zustand, jotai, ...): the app has exactly
 * two pieces of cross-cutting client state (theme, privacy) and both need
 * the same three behaviours — read once at import time (so the pre-render
 * module in `main.tsx` can apply them before React mounts), persist on
 * write, and stay in sync across tabs via the `storage` event. That is a
 * dozen lines, not a package.
 */
export interface PersistedStore<T> {
  get(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

export function createPersistedStore<T>(
  key: string,
  initial: T,
  serialize: (value: T) => string = (value) => JSON.stringify(value),
  deserialize: (raw: string) => T = (raw) => JSON.parse(raw) as T,
): PersistedStore<T> {
  function readInitial(): T {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : deserialize(raw);
    } catch {
      // Storage disabled (private browsing lockdown, quota) — fall back silently.
      return initial;
    }
  }

  let value: T = readInitial();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== key) return;
    value = event.newValue === null ? initial : deserialize(event.newValue);
    notify();
  });

  return {
    get: () => value,
    set(next) {
      value = next;
      try {
        window.localStorage.setItem(key, serialize(next));
      } catch {
        // Best-effort persistence; the in-memory value still updates this tab.
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
