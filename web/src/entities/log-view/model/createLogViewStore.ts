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

/**
 * Matches the fixed pixel widths the log table used before column resize
 * existed (issue #24), so resizing is purely additive — nothing shifts on
 * first load. `method` is sized for `OPTIONS` (the longest method in the
 * Method filter's own option list — see `Toolbar.tsx`'s `METHODS`) and
 * `CONNECT` (not filterable there, but a real captured exchange can still
 * carry it — see `MethodBadge`'s own doc comment), not just the common
 * short ones: at the old 64px, `MethodBadge`'s content overflowed its
 * column for either, visually running into the Time column with no gap.
 */
export const DEFAULT_COLUMN_WIDTHS: Record<ResizableColumn, number> = {
  time: 80,
  method: 84,
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
   *
   * Typed `ReadonlySet` (rather than plain `Set`) even though the value
   * really is a mutable `Set` underneath (see `toggleHostCollapsed`) — this
   * is state read out of a Zustand store, and calling `.add`/`.delete`
   * directly on it would mutate that state in place without ever going
   * through `set()`, silently skipping the re-render every other update to
   * this store triggers.
   */
  collapsedHosts: ReadonlySet<string>;
  /**
   * True from a `collapseAllHosts` call until the next `expandAllHosts` —
   * while true, `noteHostsSeen` auto-collapses a host the *first* time it
   * shows up, not just the ones that already existed at the moment
   * "Collapse all" was clicked (issue #117). Without this, a host whose
   * first exchange arrived *after* that click rendered expanded by
   * default — indistinguishable, from the user's seat, from "collapse all
   * didn't stick" — since `collapsedHosts` on its own only ever remembers
   * hosts it was explicitly told about.
   */
  collapseNewHostsByDefault: boolean;
  /**
   * Every host `noteHostsSeen` has already accounted for, whatever its
   * current collapsed/expanded state — including one the user explicitly
   * re-expanded after "Collapse all" (`toggleHostCollapsed` never touches
   * this set, so re-expanding a host doesn't make it look "new" again and
   * get auto-collapsed right back). Lets `noteHostsSeen` tell a genuinely
   * new host apart from one it's simply being handed again on a later,
   * unrelated re-render.
   */
  knownHosts: ReadonlySet<string>;
  /** `time`/`asc` reproduces the table's pre-sort behavior (exchanges arrive in roughly chronological order already), so leaving this untouched changes nothing. */
  sort: SortState;
  columnWidths: Record<ResizableColumn, number>;
  toggleGroupByHost: () => void;
  /** Expands/collapses one host's rows under "Group by host" — see `collapsedHosts`. */
  toggleHostCollapsed: (host: string) => void;
  /** Expands every host at once — clears `collapsedHosts` entirely, same as no host ever having been collapsed. Also turns off `collapseNewHostsByDefault` and clears `knownHosts` — "expand all" is as much a statement about hosts that haven't shown up yet as "collapse all" is, and `knownHosts`'s bookkeeping has nothing left to do once that policy is off (see `noteHostsSeen`). */
  expandAllHosts: () => void;
  /** Collapses every host currently in view at once, and arms `collapseNewHostsByDefault` (see its own doc comment) so a host that shows up afterward starts collapsed too. Takes the caller's own host list (the currently grouped/filtered set — see `GroupByHostToggle`) rather than tracking every host ever seen, so a host that later disappears (filtered out, traffic cleared) doesn't linger in `collapsedHosts`/`knownHosts` past the next "Collapse all"/"Expand all". */
  collapseAllHosts: (hosts: string[]) => void;
  /**
   * Tells the store about every host currently in view, so a genuinely new
   * one (issue #117 — see `collapseNewHostsByDefault`) gets collapsed
   * up front instead of rendering expanded until someone notices and fixes
   * it by hand. Called by `GroupByHostToggle` whenever its own filtered
   * host list changes. A no-op whenever `collapseNewHostsByDefault` is
   * `false` — there's nothing for `knownHosts` to do until the next
   * "Collapse all" reseeds it anyway, and tracking every host seen in the
   * meantime would just grow `knownHosts` without bound over a long
   * session for the common case where "Collapse all" is never used at all
   * — or once every host given is already in `knownHosts`.
   */
  noteHostsSeen: (hosts: string[]) => void;
  /** Clicking the currently-sorted column flips direction; clicking a different one switches to it ascending. */
  setSort: (column: SortColumn) => void;
  /** Updates in-memory width only — called on every `pointermove` while dragging a resize handle, so it deliberately does *not* touch localStorage (a synchronous write per move event is a real jank risk on that hot path). See `persistColumnWidths`. */
  setColumnWidth: (column: ResizableColumn, width: number) => void;
  /** Writes the current `columnWidths` to localStorage — called once on `pointerup`, after a resize drag finishes. */
  persistColumnWidths: () => void;
}

/**
 * `noteHostsSeen`'s update logic, pulled out to a plain function (rather
 * than nesting the `.filter`/`for` loops below directly inside its
 * `set((state) => ...)` callback) to keep the store definition under
 * `sonarjs/no-nested-functions`'s max nesting depth.
 */
function applyNoteHostsSeen(
  state: Pick<LogViewState, 'knownHosts' | 'collapsedHosts' | 'collapseNewHostsByDefault'>,
  hosts: string[],
): Partial<LogViewState> {
  // Bookkeeping only matters while the policy it serves is armed — with it
  // off, a host noted here has nothing to do until the next
  // `collapseAllHosts` wholesale-reseeds `knownHosts` anyway, so skip
  // growing it in the meantime (see `noteHostsSeen`'s own doc comment).
  if (!state.collapseNewHostsByDefault) return {};
  const newHosts = hosts.filter((host) => !state.knownHosts.has(host));
  if (newHosts.length === 0) return {};
  const knownHosts = new Set(state.knownHosts);
  const collapsedHosts = new Set(state.collapsedHosts);
  for (const host of newHosts) {
    knownHosts.add(host);
    collapsedHosts.add(host);
  }
  return { knownHosts, collapsedHosts };
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
    collapseNewHostsByDefault: false,
    knownHosts: new Set<string>(),
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
    expandAllHosts: () =>
      set({ collapsedHosts: new Set<string>(), collapseNewHostsByDefault: false, knownHosts: new Set<string>() }),
    collapseAllHosts: (hosts) =>
      set({ collapsedHosts: new Set(hosts), collapseNewHostsByDefault: true, knownHosts: new Set(hosts) }),
    noteHostsSeen: (hosts) => set((state) => applyNoteHostsSeen(state, hosts)),
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
