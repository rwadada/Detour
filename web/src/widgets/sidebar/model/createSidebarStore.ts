import { create } from 'zustand';
import { readPersistedState, writePersistedState } from '@/shared/lib/persistedState';

/** Expanded/collapsed widths (issue #24's design guide, Section 5.1). */
export const EXPANDED_WIDTH = 360;
export const COLLAPSED_WIDTH = 52;

const COLLAPSED_STORAGE_KEY = 'detour-sidebar-collapsed';

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export interface SidebarState {
  /** True collapses the sidebar to a narrow icon rail (issue #24: 360px ⇔ 52px). Persisted to localStorage — see `COLLAPSED_STORAGE_KEY`. */
  collapsed: boolean;
  toggleCollapsed: () => void;
}

/** Widget-local UI state — only `Sidebar` and `App` (composing the overall layout) need this, so it lives here rather than in an entity. */
export function createSidebarStore() {
  return create<SidebarState>((set) => ({
    // `isBoolean` rejects a hand-edited or stale-schema persisted value
    // (`null`, a string, …) that would otherwise flow straight into
    // `!state.collapsed` and the sidebar's width/layout conditionals.
    collapsed: readPersistedState(COLLAPSED_STORAGE_KEY, false, isBoolean),
    toggleCollapsed: () =>
      set((state) => {
        const collapsed = !state.collapsed;
        writePersistedState(COLLAPSED_STORAGE_KEY, collapsed);
        return { collapsed };
      }),
  }));
}

// Module-level singleton — `App` and `Sidebar` both read/write collapse
// state, and there's exactly one sidebar on screen. Defined here (rather
// than in `ui/Sidebar.tsx`) purely so that file exports only the
// component — `react-refresh/only-export-components` flags a component
// file that also exports non-component values.
export const useSidebarStore = createSidebarStore();
