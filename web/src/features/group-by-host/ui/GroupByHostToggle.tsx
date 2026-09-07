import { FoldVertical, Layers, UnfoldVertical } from 'lucide-react';
import { useMemo } from 'react';
import { matchesFilters, useExchangeStore } from '@/entities/exchange';
import { useLogViewStore } from '@/entities/log-view';
import { Button, PillToggle } from '@/shared/ui';

/** Toolbar control for "Group by host" (issue #24): groups the log table's rows under collapsible per-host headers instead of one flat list. */
export function GroupByHostToggle() {
  const groupByHost = useLogViewStore((s) => s.groupByHost);
  const toggleGroupByHost = useLogViewStore((s) => s.toggleGroupByHost);
  const expandAllHosts = useLogViewStore((s) => s.expandAllHosts);
  const collapseAllHosts = useLogViewStore((s) => s.collapseAllHosts);
  const exchanges = useExchangeStore((s) => s.exchanges);
  const filters = useExchangeStore((s) => s.filters);

  // collapseAllHosts() only needs the unique host names, not full HostGroup
  // objects — a plain Set avoids the per-host exchange-array allocations and
  // sort groupExchangesByHost does for LogTable's own (separate) grouping
  // pass. Skipped entirely while groupByHost is off (the common case, and
  // the only state in which "Collapse all" isn't even rendered) — otherwise
  // this would redo itself on every incoming exchange for nothing, since
  // live traffic keeps `exchanges` changing continuously.
  const hosts = useMemo(() => {
    if (!groupByHost) return [];
    const distinct = new Set<string>();
    for (const exchange of exchanges) {
      if (matchesFilters(exchange, filters)) distinct.add(exchange.host);
    }
    return [...distinct];
  }, [groupByHost, exchanges, filters]);

  return (
    <div className="flex items-center gap-1">
      <PillToggle
        active={groupByHost}
        onClick={toggleGroupByHost}
        icon={<Layers className="h-3 w-3" />}
        title={groupByHost ? 'Grouped by host — click to show a flat list' : 'Click to group rows by host'}
      >
        Group by host
      </PillToggle>
      {groupByHost && (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => expandAllHosts()}
            title="Expand all hosts"
            aria-label="Expand all hosts"
          >
            <UnfoldVertical className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => collapseAllHosts(hosts)}
            title="Collapse all hosts"
            aria-label="Collapse all hosts"
          >
            <FoldVertical className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}
