import type { CapturedExchange } from '@/shared/api';

export interface TimelineSpan {
  /** Earliest `startedAt` among the visible rows — the waterfall's 0% mark. */
  min: number;
  /** Latest of `finishedAt`/`startedAt` among the visible rows — the waterfall's 100% mark. */
  max: number;
}

/** The visible time range a Timeline column's bars are scaled against — recomputed whenever the visible row set changes, so the waterfall always spans exactly what's on screen. */
export function computeTimelineSpan(exchanges: CapturedExchange[]): TimelineSpan | null {
  if (exchanges.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const exchange of exchanges) {
    if (exchange.startedAt < min) min = exchange.startedAt;
    const end = exchange.finishedAt ?? exchange.startedAt;
    if (end > max) max = end;
  }
  // A single instant (one row, or every row started/finished at the same
  // ms) would divide by zero below — treat it as a 1ms span so every bar
  // still renders at a visible, non-NaN width.
  if (max <= min) max = min + 1;
  return { min, max };
}

export interface TimelineBar {
  /** 0-100, the bar's left edge as a percentage of `span`. */
  offsetPct: number;
  /** 0-100, the bar's width as a percentage of `span`; a still-pending exchange (no `finishedAt`) gets a minimum sliver so it's visible rather than a zero-width line. */
  widthPct: number;
}

/** Positions one exchange's waterfall bar within `span` (see `computeTimelineSpan`). */
export function computeTimelineBar(exchange: CapturedExchange, span: TimelineSpan): TimelineBar {
  const total = span.max - span.min;
  const start = exchange.startedAt - span.min;
  const end = (exchange.finishedAt ?? exchange.startedAt) - span.min;
  const offsetPct = (start / total) * 100;
  const widthPct = Math.max(((end - start) / total) * 100, exchange.finishedAt ? 0 : 0.5);
  return { offsetPct: Math.min(Math.max(offsetPct, 0), 100), widthPct: Math.min(widthPct, 100 - offsetPct) };
}
