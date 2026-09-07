import { FoldVertical, Layers, UnfoldVertical } from 'lucide-react';
import { useMemo } from 'react';
import { matchesFilters, useExchangeStore } from '@/entities/exchange';
import { groupExchangesByHost, useLogViewStore } from '@/entities/log-view';
import { Button, PillToggle } from '@/shared/ui';

/** Toolbar control for "Group by host" (issue #24): groups the log table's rows under collapsible per-host headers instead of one flat list. */
export function GroupByHostToggle() {
  const groupByHost = useLogViewStore((s) => s.groupByHost);
  const toggleGroupByHost = useLogViewStore((s) => s.toggleGroupByHost);
  const expandAllHosts = useLogViewStore((s) => s.expandAllHosts);
  const collapseAllHosts = useLogViewStore((s) => s.collapseAllHosts);
  const exchanges = useExchangeStore((s) => s.exchanges);
  const filters = useExchangeStore((s) => s.filters);

  // The same host set the table itself groups by (LogTable.tsx computes this
  // independently, off its own already-sorted list — recomputing here off
  // unsorted exchanges gets the same *set* of hosts either way, since
  // groupExchangesByHost sorts its own output alphabetically regardless of
  // input order, and sort order otherwise has no bearing on which hosts exist).
  const hosts = useMemo(
    () => groupExchangesByHost(exchanges.filter((e) => matchesFilters(e, filters))).map((g) => g.host),
    [exchanges, filters],
  );

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
          >
            <UnfoldVertical className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => collapseAllHosts(hosts)}
            title="Collapse all hosts"
          >
            <FoldVertical className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}
