import { create } from 'zustand';
import { readPersistedState, writePersistedState } from '@/shared/lib/persistedState';

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

const COLUMN_WIDTHS_STORAGE_KEY = 'detour-log-view-column-widths';

/** A finite number clamped to `MIN_COLUMN_WIDTH`, or `undefined` for anything else — guards `loadColumnWidths` against a hand-edited or stale-schema localStorage value (a string, `NaN`, a negative number, …) reaching a React `style={{ width }}` as-is. */
function sanitizeColumnWidth(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(MIN_COLUMN_WIDTH, Math.round(value))
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Merges persisted widths over the defaults — a column added by a later release (not present in an older saved value), or one whose persisted value fails `sanitizeColumnWidth`, still gets its default rather than `undefined`/garbage. */
function loadColumnWidths(): Record<ResizableColumn, number> {
  // `isRecord` rejects a hand-edited or stale-schema persisted value that
  // parses as valid JSON but isn't an object — the literal `null` in
  // particular parses fine and, without this check, would throw indexing
  // into it below (`null[column]`).
  const stored = readPersistedState<Record<ResizableColumn, unknown>>(
    COLUMN_WIDTHS_STORAGE_KEY,
    {} as Record<ResizableColumn, unknown>,
    isRecord,
  );
  const widths = { ...DEFAULT_COLUMN_WIDTHS };
  for (const column of Object.keys(widths) as ResizableColumn[]) {
    const sanitized = sanitizeColumnWidth(stored[column]);
    if (sanitized !== undefined) widths[column] = sanitized;
  }
  return widths;
}

export interface LogViewState {
  /** Groups the log table's rows under collapsible per-host headers instead of one flat list (issue #24's toolbar "Group by host"). */
  groupByHost: boolean;
  /**
   * Hosts currently collapsed under "Group by host" — a group header click
   * toggles its host's membership here. A host absent from this set is
   * expanded (the default for one never clicked); not persisted across
   * reloads, same as `groupByHost` itself. Meaningless (and untouched)
   * while `groupByHost` is off.
   */
  collapsedHosts: Set<string>;
  /** `time`/`asc` reproduces the table's pre-sort behavior (exchanges arrive in roughly chronological order already), so leaving this untouched changes nothing. */
  sort: SortState;
  columnWidths: Record<ResizableColumn, number>;
  toggleGroupByHost: () => void;
  /** Expands/collapses one host's rows under "Group by host" — see `collapsedHosts`. */
  toggleHostCollapsed: (host: string) => void;
  /** Clicking the currently-sorted column flips direction; clicking a different one switches to it ascending. */
  setSort: (column: SortColumn) => void;
  /** Updates in-memory width only — called on every `pointermove` while dragging a resize handle, so it deliberately does *not* touch localStorage (a synchronous write per move event is a real jank risk on that hot path). See `persistColumnWidths`. */
  setColumnWidth: (column: ResizableColumn, width: number) => void;
  /** Writes the current `columnWidths` to localStorage — called once on `pointerup`, after a resize drag finishes. */
  persistColumnWidths: () => void;
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
  return create<LogViewState>((set, get) => ({
    groupByHost: false,
    collapsedHosts: new Set<string>(),
    sort: { column: 'time', direction: 'asc' },
    columnWidths: loadColumnWidths(),
    toggleGroupByHost: () => set((state) => ({ groupByHost: !state.groupByHost })),
    toggleHostCollapsed: (host) =>
      set((state) => {
        const next = new Set(state.collapsedHosts);
        if (next.has(host)) next.delete(host);
        else next.add(host);
        return { collapsedHosts: next };
      }),
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
    persistColumnWidths: () => writePersistedState(COLUMN_WIDTHS_STORAGE_KEY, get().columnWidths),
  }));
}
