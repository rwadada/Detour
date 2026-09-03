import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
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
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar />
        <ContextBar />
        <ImportedBanner />
        <PanelGroup direction="horizontal" className="flex-1 overflow-hidden">
          <Panel defaultSize={62} minSize={30} className="flex flex-col overflow-hidden">
            <LogTable />
          </Panel>
          <PanelResizeHandle className="w-px bg-[var(--border)] hover:bg-[var(--accent)] data-[resize-handle-active]:bg-[var(--accent)]" />
          <Panel defaultSize={38} minSize={22} className="overflow-hidden bg-[var(--panel)]">
            <InspectorPanel />
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
