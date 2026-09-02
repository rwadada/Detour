import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'detour-theme';
const listeners = new Set<() => void>();

function readTheme(): Theme {
  return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('light', theme === 'light');
}

/** Persists and applies a theme choice, and notifies subscribers (`useTheme`) so the toggle button re-renders. */
export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
  listeners.forEach((l) => l());
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Current theme, kept in sync with the `.light` class index.html's inline script applies pre-paint (see that file's comment). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme, () => 'dark');
}
