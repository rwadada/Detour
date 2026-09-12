import { FoldVertical, Layers, UnfoldVertical } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { matchesFilters, useExchangeStore } from '@/entities/exchange';
import { useLogViewStore } from '@/entities/log-view';
import type { CapturedExchange } from '@/shared/api';
import { Button, PillToggle } from '@/shared/ui';

// A stable reference for the exchanges selector below to return while
// groupByHost is off, instead of the live store's `exchanges` array — that
// array gets a new identity on every incoming exchange, and subscribing to
// it directly would re-render this component on every one of those even
// though nothing it renders depends on exchange data while grouping is off.
const EMPTY_EXCHANGES: CapturedExchange[] = [];

/** Toolbar control for "Group by host" (issue #24): groups the log table's rows under collapsible per-host headers instead of one flat list. */
export function GroupByHostToggle() {
  const groupByHost = useLogViewStore((s) => s.groupByHost);
  const toggleGroupByHost = useLogViewStore((s) => s.toggleGroupByHost);
  const expandAllHosts = useLogViewStore((s) => s.expandAllHosts);
  const collapseAllHosts = useLogViewStore((s) => s.collapseAllHosts);
  const noteHostsSeen = useLogViewStore((s) => s.noteHostsSeen);
  // Reads through to the live `exchanges` array only while groupByHost is on
  // — see EMPTY_EXCHANGES above. filters stays a plain selector since it
  // only changes on a deliberate user action, not on every exchange.
  const exchanges = useExchangeStore((s) => (groupByHost ? s.exchanges : EMPTY_EXCHANGES));
  const filters = useExchangeStore((s) => s.filters);

  // collapseAllHosts() only needs the unique host names, not full HostGroup
  // objects — a plain Set avoids the per-host exchange-array allocations and
  // sort groupExchangesByHost does for LogTable's own (separate) grouping
  // pass.
  const hosts = useMemo(() => {
    if (!groupByHost) return [];
    const distinct = new Set<string>();
    for (const exchange of exchanges) {
      if (matchesFilters(exchange, filters)) distinct.add(exchange.host);
    }
    return [...distinct];
  }, [groupByHost, exchanges, filters]);

  // Keeps `knownHosts` current so a genuinely new host is auto-collapsed
  // while "Collapse all" is still in effect (issue #117) — see
  // `noteHostsSeen`'s own doc comment. An effect (rather than a plain call
  // during render) since this is a side effect on a store shared with other
  // components (`LogTable`'s own `collapsedHosts` read among them), not
  // something this component's own render output depends on; `[hosts, ...]`
  // means it only actually runs `noteHostsSeen` when the filtered host list
  // changes, not on every unrelated re-render.
  useEffect(() => {
    if (hosts.length > 0) noteHostsSeen(hosts);
  }, [hosts, noteHostsSeen]);

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
            type="button"
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
            type="button"
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
