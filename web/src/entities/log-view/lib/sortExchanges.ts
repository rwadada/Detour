import type { CapturedExchange } from '@/shared/api';
import type { SortState } from '../model/createLogViewStore';

/** Numeric value used to compare `column` across two exchanges; `undefined` (pending/no status, no duration) always sorts last regardless of direction — an in-flight request isn't "smaller", it's simply not comparable yet. */
function columnValue(exchange: CapturedExchange, column: SortState['column']): number | string | undefined {
  switch (column) {
    case 'time':
      return exchange.startedAt;
    case 'method':
      return exchange.method;
    case 'status':
      return exchange.statusCode;
    case 'url':
      return exchange.url;
    case 'duration':
      return exchange.durationMs;
    case 'size':
      return exchange.responseBodySize;
    default:
      return undefined;
  }
}

/** Sorts a copy of `exchanges` by `sort`, `undefined` values always last. */
export function sortExchanges(exchanges: CapturedExchange[], sort: SortState): CapturedExchange[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...exchanges].sort((a, b) => {
    const va = columnValue(a, sort.column);
    const vb = columnValue(b, sort.column);
    if (va === undefined && vb === undefined) return 0;
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    if (va < vb) return -1 * sign;
    if (va > vb) return 1 * sign;
    return 0;
  });
}

/** One host's rows for `groupByHost`, in the order `sortExchanges` produced them. */
export interface HostGroup {
  host: string;
  exchanges: CapturedExchange[];
}

/** Groups already-sorted exchanges by `host`, groups alphabetically — a stable, traffic-independent order so groups don't jump around as new requests arrive. */
export function groupExchangesByHost(exchanges: CapturedExchange[]): HostGroup[] {
  const byHost = new Map<string, CapturedExchange[]>();
  for (const exchange of exchanges) {
    const bucket = byHost.get(exchange.host);
    if (bucket) bucket.push(exchange);
    else byHost.set(exchange.host, [exchange]);
  }
  return [...byHost.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, hostExchanges]) => ({ host, exchanges: hostExchanges }));
}
