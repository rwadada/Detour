import { create } from 'zustand';

/** Columns a user can sort the log table by (issue #24). `url` sorts lexicographically; the rest numerically. */
export type SortColumn = 'time' | 'method' | 'status' | 'url' | 'duration' | 'size';
export type SortDirection = 'asc' | 'desc';

/** Columns a user can drag-resize (issue #24) — `url` always fills the remaining space instead, so it isn't included. */
export type ResizableColumn = Exclude<SortColumn, 'url'>;

export interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

/** Matches the fixed pixel widths the log table used before column resize existed (issue #24), so resizing is purely additive — nothing shifts on first load. */
export const DEFAULT_COLUMN_WIDTHS: Record<ResizableColumn, number> = {
  time: 80,
  method: 64,
  status: 56,
  duration: 64,
  size: 64,
};

/** Below this, a column's own label/value starts truncating illegibly. */
export const MIN_COLUMN_WIDTH = 40;

export interface LogViewState {
  /** Groups the log table's rows under collapsible per-host headers instead of one flat list (issue #24's toolbar "Group by host"). */
  groupByHost: boolean;
  /** `time`/`asc` reproduces the table's pre-sort behavior (exchanges arrive in roughly chronological order already), so leaving this untouched changes nothing. */
  sort: SortState;
  columnWidths: Record<ResizableColumn, number>;
  toggleGroupByHost: () => void;
  /** Clicking the currently-sorted column flips direction; clicking a different one switches to it ascending. */
  setSort: (column: SortColumn) => void;
  setColumnWidth: (column: ResizableColumn, width: number) => void;
}

/**
 * Builds the log-view entity's store: the log table's view preferences
 * (issue #24) — column sort, column widths, and host grouping. Separate from
 * `entities/exchange` (the traffic data itself) since both `widgets/toolbar`
 * and `widgets/log-table` need to read/write this without either widget
 * importing the other (FSD disallows widget→widget imports; both may import
 * an entity below them).
 */
export function createLogViewStore() {
  return create<LogViewState>((set) => ({
    groupByHost: false,
    sort: { column: 'time', direction: 'asc' },
    columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
    toggleGroupByHost: () => set((state) => ({ groupByHost: !state.groupByHost })),
    setSort: (column) =>
      set((state) => ({
        sort:
          state.sort.column === column
            ? { column, direction: state.sort.direction === 'asc' ? 'desc' : 'asc' }
            : { column, direction: 'asc' },
      })),
    setColumnWidth: (column, width) =>
      set((state) => ({
        columnWidths: { ...state.columnWidths, [column]: Math.max(MIN_COLUMN_WIDTH, Math.round(width)) },
      })),
  }));
}
