import { Moon, Search, Sun, Trash2 } from 'lucide-react';
import { useExchangeStore } from '@/entities/exchange';
import { BlockHostsControl } from '@/features/block-hosts';
import { FocusControl } from '@/features/focus';
import { GroupByHostToggle } from '@/features/group-by-host';
import { InterceptToggle } from '@/features/intercept-toggle';
import { ExportMenu } from '@/features/log-export';
import { ImportButton } from '@/features/log-viewer';
import { PauseTailToggle } from '@/features/pause-tail';
import { ThrottleControl } from '@/features/throttle';
import { setTheme, useTheme } from '@/shared/lib/theme';
import { Button, Input, Select } from '@/shared/ui';

const METHODS = ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const STATUS_CLASSES = ['ALL', 'pending', '2xx', '3xx', '4xx', '5xx'];

/**
 * The main area's top toolbar (issue #24's layout refresh): search/filters,
 * Group by host, Pause/Tail, Intercept/Focus/Throttle/Block Hosts, and
 * Save/Import/theme. Replaces the old flat `Header` + `FilterBar` — the
 * count/filter summary/Compare those used to show now live in
 * `widgets/context-bar` instead, right below this.
 */
export function Toolbar() {
  const filters = useExchangeStore((s) => s.filters);
  const setFilters = useExchangeStore((s) => s.setFilters);
  const clear = useExchangeStore((s) => s.clear);
  const exchanges = useExchangeStore((s) => s.exchanges);
  const theme = useTheme();

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-2">
      <div className="relative min-w-40 flex-1">
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

      <div className="mx-1 h-4 w-px bg-[var(--border)]" />

      <GroupByHostToggle />
      <PauseTailToggle />
      <InterceptToggle />
      <FocusControl />
      <ThrottleControl />
      <BlockHostsControl />

      <div className="mx-1 h-4 w-px bg-[var(--border)]" />

      <ImportButton />
      <ExportMenu />
      <Button variant="outline" size="sm" onClick={clear} disabled={exchanges.length === 0} title="Clear log">
        <Trash2 className="h-3.5 w-3.5" />
        Clear
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
