import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { ProtocolMismatchBanner } from '@/entities/proxy-config';
import { HistoryBanner } from '@/features/history';
import { UpdateBanner } from '@/features/update-notice';
import { ImportedBanner } from '@/features/log-viewer';
import { ContextBar } from '@/widgets/context-bar';
import { InspectorPanel } from '@/widgets/inspector-panel';
import { LogTable } from '@/widgets/log-table';
import { Sidebar } from '@/widgets/sidebar';
import { Toolbar } from '@/widgets/toolbar';

/**
 * Issue #24's layout refresh: a collapsible `Sidebar` (session/rules info)
 * alongside the main area, which stacks `Toolbar` (search/filters/actions),
 * `ContextBar` (Live/Paused/Viewer, counts, Compare), the log table, and the
 * resizable inspector panel — replacing the old flat single-row `Header` +
 * `FilterBar`.
 */
export default function App() {
  // Persists the split (the inspector panel's width) to localStorage — issue #24 Phase 5's panel-size
  // persistence. v4 no longer has `autoSaveId`: the layout is saved/restored through this hook, keyed by
  // the group id, and handed to `Group` below.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'detour-main-panels' });

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar />
        <ContextBar />
        <ProtocolMismatchBanner />
        <ImportedBanner />
        <UpdateBanner />
        <HistoryBanner />
        {/* In v4 a bare number is pixels, so sizes are `%` strings (v3 read numbers as percentages). */}
        <Group
          id="detour-main-panels"
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          className="flex-1 overflow-hidden"
        >
          <Panel id="log" defaultSize="62%" minSize="30%" className="flex flex-col overflow-hidden">
            <LogTable />
          </Panel>
          <Separator className="w-px bg-[var(--border)] hover:bg-[var(--accent)] data-[separator=active]:bg-[var(--accent)] data-[separator=focus]:bg-[var(--accent)]" />
          <Panel id="inspector" defaultSize="38%" minSize="22%" className="overflow-hidden bg-[var(--panel)]">
            <InspectorPanel />
          </Panel>
        </Group>
      </div>
    </div>
  );
}
