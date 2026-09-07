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

  it('toggleHostCollapsed adds a host not yet collapsed, and removes one already collapsed', () => {
    const store = createLogViewStore();
    expect(store.getState().collapsedHosts.has('example.com')).toBe(false);

    store.getState().toggleHostCollapsed('example.com');
    expect(store.getState().collapsedHosts.has('example.com')).toBe(true);

    store.getState().toggleHostCollapsed('example.com');
    expect(store.getState().collapsedHosts.has('example.com')).toBe(false);
  });

  it('toggleHostCollapsed tracks multiple hosts independently', () => {
    const store = createLogViewStore();
    store.getState().toggleHostCollapsed('a.example.com');
    store.getState().toggleHostCollapsed('b.example.com');

    expect(store.getState().collapsedHosts.has('a.example.com')).toBe(true);
    expect(store.getState().collapsedHosts.has('b.example.com')).toBe(true);

    store.getState().toggleHostCollapsed('a.example.com');
    expect(store.getState().collapsedHosts.has('a.example.com')).toBe(false);
    expect(store.getState().collapsedHosts.has('b.example.com')).toBe(true);
  });

  it('expandAllHosts clears collapsedHosts entirely, regardless of how many hosts were collapsed', () => {
    const store = createLogViewStore();
    store.getState().toggleHostCollapsed('a.example.com');
    store.getState().toggleHostCollapsed('b.example.com');
    expect(store.getState().collapsedHosts.size).toBe(2);

    store.getState().expandAllHosts();
    expect(store.getState().collapsedHosts.size).toBe(0);
  });

  it('collapseAllHosts collapses exactly the given hosts, replacing whatever was collapsed before', () => {
    const store = createLogViewStore();
    store.getState().toggleHostCollapsed('stale.example.com');

    store.getState().collapseAllHosts(['a.example.com', 'b.example.com']);

    const { collapsedHosts } = store.getState();
    expect(collapsedHosts.has('a.example.com')).toBe(true);
    expect(collapsedHosts.has('b.example.com')).toBe(true);
    expect(collapsedHosts.has('stale.example.com')).toBe(false);
  });

  it('collapseAllHosts with an empty list expands everything, same as expandAllHosts', () => {
    const store = createLogViewStore();
    store.getState().toggleHostCollapsed('a.example.com');

    store.getState().collapseAllHosts([]);
    expect(store.getState().collapsedHosts.size).toBe(0);
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

    // `setColumnWidth` alone must NOT touch localStorage — it's called on
    // every `pointermove` while dragging a resize handle, and a synchronous
    // write per move event is a real jank risk on that hot path (a review
    // finding on the PR that introduced this). Only `persistColumnWidths`
    // (called once on `pointerup`) writes.
    it('setColumnWidth alone does not persist', () => {
      const first = createLogViewStore();
      first.getState().setColumnWidth('method', 120);

      const second = createLogViewStore();
      expect(second.getState().columnWidths.method).toBe(DEFAULT_COLUMN_WIDTHS.method);
    });

    it('persistColumnWidths writes the current widths for the next store instance (e.g. a page reload)', () => {
      const first = createLogViewStore();
      first.getState().setColumnWidth('method', 120);
      first.getState().persistColumnWidths();

      const second = createLogViewStore();
      expect(second.getState().columnWidths.method).toBe(120);
    });

    it('fills in a column missing from an older persisted value with its default', () => {
      localStorage.setItem('detour-log-view-column-widths', JSON.stringify({ method: 120 }));
      const store = createLogViewStore();
      expect(store.getState().columnWidths).toEqual({ ...DEFAULT_COLUMN_WIDTHS, method: 120 });
    });

    // A review finding: the JSON literal `null` parses without error, so a
    // bare try/catch around JSON.parse can't reject it — without an
    // explicit object-shape check, indexing into it (`null['method']`)
    // would throw and break dashboard startup.
    it('falls back to all defaults, without throwing, when the persisted value is the literal null', () => {
      vi.stubGlobal('localStorage', { getItem: () => 'null', setItem: () => {} });
      expect(() => createLogViewStore()).not.toThrow();
      expect(createLogViewStore().getState().columnWidths).toEqual(DEFAULT_COLUMN_WIDTHS);
    });

    // A review finding: a hand-edited or stale-schema localStorage value
    // (a wrong type, `null`, …) must not flow straight into a React
    // `style={{ width }}` — anything that isn't a finite number falls back
    // to that column's default instead.
    it.each([
      ['a string', 'not-a-number'],
      ['null', null],
      ['an array', [1, 2]],
    ])('falls back to the default when the persisted value is %s', (_label, badValue) => {
      localStorage.setItem('detour-log-view-column-widths', JSON.stringify({ method: badValue }));
      const store = createLogViewStore();
      expect(store.getState().columnWidths.method).toBe(DEFAULT_COLUMN_WIDTHS.method);
    });

    it.each([
      ['a negative number', -50],
      ['zero', 0],
      ['a too-small positive number', 5],
    ])(
      'clamps a valid-but-too-small persisted value (%s) up to MIN_COLUMN_WIDTH rather than discarding it',
      (_label, smallValue) => {
        localStorage.setItem('detour-log-view-column-widths', JSON.stringify({ method: smallValue }));
        const store = createLogViewStore();
        expect(store.getState().columnWidths.method).toBe(MIN_COLUMN_WIDTH);
      },
    );
  });
});
