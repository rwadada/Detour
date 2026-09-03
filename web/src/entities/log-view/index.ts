import { createLogViewStore } from './model/createLogViewStore';

export {
  createLogViewStore,
  DEFAULT_COLUMN_WIDTHS,
  MIN_COLUMN_WIDTH,
  type LogViewState,
  type ResizableColumn,
  type SortColumn,
  type SortDirection,
  type SortState,
} from './model/createLogViewStore';
export { computeTimelineBar, computeTimelineSpan, type TimelineBar, type TimelineSpan } from './lib/timeline';
export { groupExchangesByHost, sortExchanges, type HostGroup } from './lib/sortExchanges';

/** The app's real log-view store — a single instance shared by `widgets/toolbar` and `widgets/log-table` (unlike `entities/exchange`, this holds no traffic data and needs no `DashboardConnection`, so it's a plain singleton rather than a `create*Store(connection)` factory wired here). */
export const useLogViewStore = createLogViewStore();
