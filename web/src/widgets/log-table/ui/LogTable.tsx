import { useMemo, useRef, type CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BreakpointBadge, matchesFilters, MethodBadge, StatusBadge, useExchangeStore } from '@/entities/exchange';
import type { CapturedExchange } from '@/shared/api';
import { cn, formatBytes, formatDuration, formatTime } from '@/shared/lib/utils';

const ROW_HEIGHT = 30;
// If the user has scrolled further than this from the bottom, new rows stop
// auto-scrolling into view — lets them read older entries without the list
// yanking them back down mid-scroll under live traffic.
const STICK_TO_BOTTOM_THRESHOLD_PX = 48;

export function LogTable() {
  const exchanges = useExchangeStore((s) => s.exchanges);
  const filters = useExchangeStore((s) => s.filters);
  const selectedId = useExchangeStore((s) => s.selectedId);
  const select = useExchangeStore((s) => s.select);

  const filtered = useMemo(() => exchanges.filter((e) => matchesFilters(e, filters)), [exchanges, filters]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Keep the view pinned to the newest row as traffic streams in, unless the
  // user has deliberately scrolled up to inspect earlier entries.
  const prevCount = useRef(filtered.length);
  if (filtered.length !== prevCount.current) {
    prevCount.current = filtered.length;
    if (stickToBottom.current && filtered.length > 0) {
      queueMicrotask(() => virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' }));
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
      <div className="flex border-b border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] font-mono-ui">
        <span className="w-20 shrink-0">Time</span>
        <span className="w-16 shrink-0">Method</span>
        <span className="w-14 shrink-0">Status</span>
        <span className="min-w-0 flex-1">URL</span>
        <span className="w-16 shrink-0 text-right">Time</span>
        <span className="w-16 shrink-0 text-right">Size</span>
      </div>
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const exchange = filtered[row.index];
            if (!exchange) return null;
            return (
              <LogRow
                key={exchange.id}
                exchange={exchange}
                selected={exchange.id === selectedId}
                onSelect={() => select(exchange.id)}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: row.size,
                  transform: `translateY(${row.start}px)`,
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LogRow({
  exchange,
  selected,
  onSelect,
  style,
}: {
  exchange: CapturedExchange;
  selected: boolean;
  onSelect: () => void;
  style: CSSProperties;
}) {
  const pending = exchange.statusCode === undefined && !exchange.error;
  return (
    <button
      type="button"
      onClick={onSelect}
      style={style}
      className={cn(
        'flex w-full items-center border-b border-[var(--border)]/50 px-3 text-left text-xs font-mono-ui transition-colors',
        selected ? 'bg-[var(--row-selected)]' : 'hover:bg-[var(--row-hover)]',
        pending && 'opacity-60',
      )}
    >
      <span className="w-20 shrink-0 text-[var(--muted)]">{formatTime(exchange.startedAt)}</span>
      <span className="w-16 shrink-0">
        <MethodBadge method={exchange.method} />
      </span>
      <span className="w-14 shrink-0">
        {exchange.breakpoint ? (
          <BreakpointBadge phase={exchange.breakpoint} />
        ) : (
          <StatusBadge status={exchange.statusCode} error={exchange.error} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate pr-2">{exchange.url}</span>
      <span className="w-16 shrink-0 text-right text-[var(--muted)]">{formatDuration(exchange.durationMs)}</span>
      <span className="w-16 shrink-0 text-right text-[var(--muted)]">
        {exchange.responseBodySize > 0 ? formatBytes(exchange.responseBodySize) : '—'}
      </span>
    </button>
  );
}
