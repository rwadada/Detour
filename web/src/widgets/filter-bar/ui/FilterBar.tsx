import { useMemo } from 'react';
import { Search, Trash2 } from 'lucide-react';
import { matchesFilters, useExchangeStore } from '@/entities/exchange';
import { CompareBar } from '@/features/compare';
import { Button, Input, Select } from '@/shared/ui';

const METHODS = ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const STATUS_CLASSES = ['ALL', 'pending', '2xx', '3xx', '4xx', '5xx'];

export function FilterBar() {
  const filters = useExchangeStore((s) => s.filters);
  const setFilters = useExchangeStore((s) => s.setFilters);
  const clear = useExchangeStore((s) => s.clear);
  const exchanges = useExchangeStore((s) => s.exchanges);
  const shownCount = useMemo(
    () => exchanges.reduce((n, e) => n + (matchesFilters(e, filters) ? 1 : 0), 0),
    [exchanges, filters],
  );
  const isFiltered = filters.method !== 'ALL' || filters.status !== 'ALL' || filters.query !== '';

  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
        <Input
          value={filters.query}
          onChange={(e) => setFilters({ query: e.target.value })}
          placeholder="Filter by URL…"
          className="pl-7"
        />
      </div>
      <Select value={filters.method} onChange={(e) => setFilters({ method: e.target.value })}>
        {METHODS.map((m) => (
          <option key={m} value={m}>
            {m === 'ALL' ? 'Method: All' : m}
          </option>
        ))}
      </Select>
      <Select value={filters.status} onChange={(e) => setFilters({ status: e.target.value })}>
        {STATUS_CLASSES.map((s) => (
          <option key={s} value={s}>
            {s === 'ALL' ? 'Status: All' : s}
          </option>
        ))}
      </Select>
      <span className="whitespace-nowrap text-xs text-[var(--muted)] font-mono-ui">
        {isFiltered ? `${shownCount} of ${exchanges.length} shown` : `${exchanges.length} shown`}
      </span>
      <CompareBar />
      <Button variant="outline" size="sm" onClick={clear} title="Clear log">
        <Trash2 className="h-3.5 w-3.5" />
        Clear
      </Button>
    </div>
  );
}
