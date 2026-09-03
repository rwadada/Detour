import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogViewStore, DEFAULT_COLUMN_WIDTHS, MIN_COLUMN_WIDTH } from './createLogViewStore';

function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe('createLogViewStore', () => {
  it('starts ungrouped, sorted by time ascending, with the default column widths', () => {
    const store = createLogViewStore();
    const state = store.getState();
    expect(state.groupByHost).toBe(false);
    expect(state.sort).toEqual({ column: 'time', direction: 'asc' });
    expect(state.columnWidths).toEqual(DEFAULT_COLUMN_WIDTHS);
  });

  it('toggleGroupByHost flips the flag', () => {
    const store = createLogViewStore();
    store.getState().toggleGroupByHost();
    expect(store.getState().groupByHost).toBe(true);
    store.getState().toggleGroupByHost();
    expect(store.getState().groupByHost).toBe(false);
  });

  it('setSort on a new column switches to it ascending', () => {
    const store = createLogViewStore();
    store.getState().setSort('duration');
    expect(store.getState().sort).toEqual({ column: 'duration', direction: 'asc' });
  });

  it('setSort on the already-active column flips direction', () => {
    const store = createLogViewStore();
    store.getState().setSort('duration');
    store.getState().setSort('duration');
    expect(store.getState().sort).toEqual({ column: 'duration', direction: 'desc' });
  });

  it('setColumnWidth updates just the given column', () => {
    const store = createLogViewStore();
    store.getState().setColumnWidth('method', 120);
    expect(store.getState().columnWidths.method).toBe(120);
    expect(store.getState().columnWidths.time).toBe(DEFAULT_COLUMN_WIDTHS.time);
  });

  it('setColumnWidth clamps below MIN_COLUMN_WIDTH', () => {
    const store = createLogViewStore();
    store.getState().setColumnWidth('method', 1);
    expect(store.getState().columnWidths.method).toBe(MIN_COLUMN_WIDTH);
  });

  describe('column width persistence (issue #24 Phase 5)', () => {
    beforeEach(() => {
      vi.stubGlobal('localStorage', fakeLocalStorage());
    });

    it('persists a resized column for the next store instance (e.g. a page reload)', () => {
      const first = createLogViewStore();
      first.getState().setColumnWidth('method', 120);

      const second = createLogViewStore();
      expect(second.getState().columnWidths.method).toBe(120);
    });

    it('fills in a column missing from an older persisted value with its default', () => {
      localStorage.setItem('detour-log-view-column-widths', JSON.stringify({ method: 120 }));
      const store = createLogViewStore();
      expect(store.getState().columnWidths).toEqual({ ...DEFAULT_COLUMN_WIDTHS, method: 120 });
    });
  });
});
