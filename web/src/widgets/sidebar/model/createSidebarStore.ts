import { create } from 'zustand';

/** Expanded/collapsed widths (issue #24's design guide, Section 5.1). */
export const EXPANDED_WIDTH = 360;
export const COLLAPSED_WIDTH = 52;

export interface SidebarState {
  /** True collapses the sidebar to a narrow icon rail (issue #24: 360px ⇔ 52px). Not persisted yet — see issue #24's Phase 5 for localStorage persistence of this and other layout preferences. */
  collapsed: boolean;
  toggleCollapsed: () => void;
}

/** Widget-local UI state — only `Sidebar` and `App` (composing the overall layout) need this, so it lives here rather than in an entity. */
export function createSidebarStore() {
  return create<SidebarState>((set) => ({
    collapsed: false,
    toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
  }));
}

// Module-level singleton — `App` and `Sidebar` both read/write collapse
// state, and there's exactly one sidebar on screen. Defined here (rather
// than in `ui/Sidebar.tsx`) purely so that file exports only the
// component — `react-refresh/only-export-components` flags a component
// file that also exports non-component values.
export const useSidebarStore = createSidebarStore();
