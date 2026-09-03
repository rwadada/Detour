/**
 * Reads a JSON value previously written by `writePersistedState` under
 * `key`, falling back to `fallback` when it's absent, corrupt, or
 * `localStorage` itself is unavailable (SSR, a locked-down browser, a test
 * environment with no DOM). Never throws — a persistence failure should
 * degrade to "start fresh this session", not break the app.
 */
export function readPersistedState<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Writes `value` under `key` for `readPersistedState` to pick up later. Silently no-ops if `localStorage` is unavailable or full — same reasoning as `readPersistedState`. */
export function writePersistedState<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best-effort — a failed write just means this one change isn't remembered.
  }
}
