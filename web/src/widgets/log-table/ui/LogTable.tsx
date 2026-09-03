import { useMemo, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  BreakpointBadge,
  matchesFilters,
  MethodBadge,
  ProtocolBadge,
  StatusBadge,
  useExchangeStore,
} from '@/entities/exchange';
import {
  computeTimelineBar,
  computeTimelineSpan,
  groupExchangesByHost,
  sortExchanges,
  useLogViewStore,
  type ResizableColumn,
  type SortColumn,
  type TimelineSpan,
} from '@/entities/log-view';
import type { CapturedExchange } from '@/shared/api';
import { cn, formatBytes, formatDuration, formatTime } from '@/shared/lib/utils';

const ROW_HEIGHT = 30;
const GROUP_HEADER_HEIGHT = 26;
const TIMELINE_WIDTH = 140;
// If the user has scrolled further than this from the bottom, new rows stop
// auto-scrolling into view — lets them read older entries without the list
// yanking them back down mid-scroll under live traffic.
const STICK_TO_BOTTOM_THRESHOLD_PX = 48;

const COLUMN_LABELS: Record<SortColumn, string> = {
  time: 'Time',
  method: 'Method',
  status: 'Status',
  url: 'URL',
  duration: 'Duration',
  size: 'Size',
};

/** One flattened row the virtualizer renders — either a host group header (only when "Group by host" is on) or an exchange row. Flattening both into one list is what lets `@tanstack/react-virtual` — which only knows about a single linear item count — render collapsible group headers at all. */
type Row = { kind: 'group'; host: string; count: number } | { kind: 'exchange'; exchange: CapturedExchange };

export function LogTable() {
  const exchanges = useExchangeStore((s) => s.exchanges);
  const filters = useExchangeStore((s) => s.filters);
  const selectedId = useExchangeStore((s) => s.selectedId);
  const select = useExchangeStore((s) => s.select);
  const compareIds = useExchangeStore((s) => s.compareIds);
  const toggleCompare = useExchangeStore((s) => s.toggleCompare);
  const sort = useLogViewStore((s) => s.sort);
  const groupByHost = useLogViewStore((s) => s.groupByHost);

  const sorted = useMemo(() => {
    const filtered = exchanges.filter((e) => matchesFilters(e, filters));
    return sortExchanges(filtered, sort);
  }, [exchanges, filters, sort]);

  const timelineSpan = useMemo(() => computeTimelineSpan(sorted), [sorted]);

  const rows = useMemo<Row[]>(() => {
    if (!groupByHost) return sorted.map((exchange) => ({ kind: 'exchange', exchange }));
    return groupExchangesByHost(sorted).flatMap((group) => [
      { kind: 'group' as const, host: group.host, count: group.exchanges.length },
      ...group.exchanges.map((exchange) => ({ kind: 'exchange' as const, exchange })),
    ]);
  }, [sorted, groupByHost]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? GROUP_HEADER_HEIGHT : ROW_HEIGHT),
    overscan: 12,
  });

  // Keep the view pinned to the newest row as traffic streams in, unless the
  // user has deliberately scrolled up to inspect earlier entries. Skipped
  // while grouped by host — group order is alphabetical, not chronological,
  // so "the newest row" isn't at the bottom in any meaningful sense there.
  const prevCount = useRef(rows.length);
  if (rows.length !== prevCount.current) {
    prevCount.current = rows.length;
    if (!groupByHost && stickToBottom.current && rows.length > 0) {
      queueMicrotask(() => virtualizer.scrollToIndex(rows.length - 1, { align: 'end' }));
    }
  }

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD_PX;
  };

  if (exchanges.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted)]">
        Waiting for traffic through the proxy…
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <LogTableHeader />
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = rows[row.index];
            if (!item) return null;
            const style: CSSProperties = {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: row.size,
              transform: `translateY(${row.start}px)`,
            };
            if (item.kind === 'group') {
              return <GroupHeaderRow key={`group:${item.host}`} host={item.host} count={item.count} style={style} />;
            }
            return (
              <LogRow
                key={item.exchange.id}
                exchange={item.exchange}
                selected={item.exchange.id === selectedId}
                compareOrder={compareIds.indexOf(item.exchange.id)}
                timelineSpan={timelineSpan}
                onSelect={(event) =>
                  event.metaKey || event.ctrlKey ? toggleCompare(item.exchange.id) : select(item.exchange.id)
                }
                style={style}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LogTableHeader() {
  return (
    <div className="flex border-b border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] font-mono-ui">
      <SortableHeaderCell column="time" />
      <SortableHeaderCell column="method" />
      <SortableHeaderCell column="status" />
      <SortableHeaderCell column="url" className="min-w-0 flex-1 pr-2" />
      <SortableHeaderCell column="duration" align="right" />
      <SortableHeaderCell column="size" align="right" />
      <span className="shrink-0 text-right" style={{ width: TIMELINE_WIDTH }}>
        Timeline
      </span>
    </div>
  );
}

function SortableHeaderCell({
  column,
  align = 'left',
  className,
}: {
  column: SortColumn;
  align?: 'left' | 'right';
  className?: string;
}) {
  const sort = useLogViewStore((s) => s.sort);
  const setSort = useLogViewStore((s) => s.setSort);
  const width = useLogViewStore((s) => (column === 'url' ? undefined : s.columnWidths[column as ResizableColumn]));
  const active = sort.column === column;

  return (
    <span style={column === 'url' ? undefined : { width }} className={cn('relative shrink-0 select-none', className)}>
      <button
        type="button"
        onClick={() => setSort(column)}
        className={cn(
          'flex w-full items-center gap-0.5 hover:text-[var(--foreground)]',
          align === 'right' && 'justify-end',
          active && 'text-[var(--foreground)]',
        )}
        title={`Sort by ${COLUMN_LABELS[column]}`}
      >
        {COLUMN_LABELS[column]}
        {active && (sort.direction === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </button>
      {column !== 'url' && <ResizeHandle column={column as ResizableColumn} />}
    </span>
  );
}

/** Drag handle at a resizable column's right edge (issue #24's column resize). */
function ResizeHandle({ column }: { column: ResizableColumn }) {
  const setColumnWidth = useLogViewStore((s) => s.setColumnWidth);
  const width = useLogViewStore((s) => s.columnWidths[column]);

  const onPointerDown = (event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: PointerEvent) => setColumnWidth(column, startWidth + (moveEvent.clientX - startX));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      title="Drag to resize"
      className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none"
    />
  );
}

function GroupHeaderRow({ host, count, style }: { host: string; count: number; style: CSSProperties }) {
  return (
    <div
      style={style}
      className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 text-[11px] font-medium text-[var(--muted)] font-mono-ui"
    >
      {host}
      <span className="rounded-full bg-[var(--row-hover)] px-1.5 text-[10px]">{count}</span>
    </div>
  );
}

function LogRow({
  exchange,
  selected,
  compareOrder,
  timelineSpan,
  onSelect,
  style,
}: {
  exchange: CapturedExchange;
  selected: boolean;
  /** Index in the compare set (0/1), or -1 if not marked for compare (issue #19 — ctrl/cmd-click a row to mark it). */
  compareOrder: number;
  timelineSpan: TimelineSpan | null;
  onSelect: (event: { metaKey: boolean; ctrlKey: boolean }) => void;
  style: CSSProperties;
}) {
  const columnWidths = useLogViewStore((s) => s.columnWidths);
  const pending = exchange.statusCode === undefined && !exchange.error;
  const inCompare = compareOrder >= 0;
  const bar = timelineSpan ? computeTimelineBar(exchange, timelineSpan) : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      style={style}
      title={inCompare ? undefined : 'Click to inspect — ctrl/cmd-click to mark for Compare'}
      className={cn(
        'flex w-full items-center border-b border-[var(--border)]/50 px-3 text-left text-xs font-mono-ui transition-colors',
        selected ? 'bg-[var(--row-selected)]' : 'hover:bg-[var(--row-hover)]',
        inCompare && 'border-l-2 border-l-[var(--accent)]',
        pending && 'opacity-60',
      )}
    >
      {inCompare && (
        <span className="mr-1.5 shrink-0 rounded bg-[var(--accent)] px-1 text-[10px] font-semibold text-[var(--accent-foreground)]">
          {compareOrder + 1}
        </span>
      )}
      <span style={{ width: columnWidths.time }} className="shrink-0 text-[var(--muted)]">
        {formatTime(exchange.startedAt)}
      </span>
      <span style={{ width: columnWidths.method }} className="shrink-0">
        <MethodBadge method={exchange.method} />
      </span>
      <span style={{ width: columnWidths.status }} className="shrink-0">
        {exchange.breakpoint ? (
          <BreakpointBadge phase={exchange.breakpoint} />
        ) : (
          <StatusBadge status={exchange.statusCode} error={exchange.error} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate pr-2">
        {exchange.protocol === 'HTTP/2' && (
          <>
            <ProtocolBadge protocol={exchange.protocol} />{' '}
          </>
        )}
        {exchange.url}
      </span>
      <span style={{ width: columnWidths.duration }} className="shrink-0 text-right text-[var(--muted)]">
        {formatDuration(exchange.durationMs)}
      </span>
      <span style={{ width: columnWidths.size }} className="shrink-0 text-right text-[var(--muted)]">
        {exchange.responseBodySize > 0 ? formatBytes(exchange.responseBodySize) : '—'}
      </span>
      <span className="shrink-0 pl-2" style={{ width: TIMELINE_WIDTH }}>
        {bar && (
          <span className="relative block h-1.5 w-full rounded-full bg-[var(--border)]/40">
            <span
              className={cn(
                'absolute h-full rounded-full',
                pending ? 'bg-[var(--status-pending)]' : 'bg-[var(--accent)]',
              )}
              style={{ left: `${bar.offsetPct}%`, width: `${bar.widthPct}%` }}
            />
          </span>
        )}
      </span>
    </button>
  );
}
