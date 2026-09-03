/**
 * Reads a JSON value previously written by `writePersistedState` under
 * `key`, falling back to `fallback` when it's absent, corrupt, or
 * `localStorage` itself is unavailable (SSR, a locked-down browser, a test
 * environment with no DOM). Never throws — a persistence failure should
 * degrade to "start fresh this session", not break the app.
 *
 * `isValid`, if given, is checked against the *parsed* value — catching a
 * value that's valid JSON but the wrong shape (e.g. the literal `null`, or
 * a string, where a caller expects an object or a `boolean`) the same way
 * a parse error is caught, rather than handing the caller something that'll
 * throw or misbehave once used. Without it, any successfully-parsed value
 * is returned as-is (the caller's `T` is trusted, same as before).
 */
export function readPersistedState<T>(key: string, fallback: T, isValid?: (value: unknown) => value is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (isValid && !isValid(parsed)) return fallback;
    return parsed as T;
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
