import { Layers } from 'lucide-react';
import { useLogViewStore } from '@/entities/log-view';
import { PillToggle } from '@/shared/ui';

/** Toolbar control for "Group by host" (issue #24): groups the log table's rows under collapsible per-host headers instead of one flat list. */
export function GroupByHostToggle() {
  const groupByHost = useLogViewStore((s) => s.groupByHost);
  const toggleGroupByHost = useLogViewStore((s) => s.toggleGroupByHost);

  return (
    <PillToggle
      active={groupByHost}
      onClick={toggleGroupByHost}
      icon={<Layers className="h-3 w-3" />}
      title={groupByHost ? 'Grouped by host — click to show a flat list' : 'Click to group rows by host'}
    >
      Group by host
    </PillToggle>
  );
}
