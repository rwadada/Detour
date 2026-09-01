import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FilterBar } from '@/components/FilterBar';
import { Header } from '@/components/Header';
import { InspectorPanel } from '@/components/InspectorPanel';
import { LogTable } from '@/components/LogTable';

export default function App() {
  return (
    <div className="flex h-full flex-col">
      <Header />
      <PanelGroup direction="horizontal" className="flex-1 overflow-hidden">
        <Panel defaultSize={62} minSize={30} className="flex flex-col overflow-hidden">
          <FilterBar />
          <LogTable />
        </Panel>
        <PanelResizeHandle className="w-px bg-[var(--border)] hover:bg-[var(--accent)] data-[resize-handle-active]:bg-[var(--accent)]" />
        <Panel defaultSize={38} minSize={22} className="overflow-hidden bg-[var(--panel)]">
          <InspectorPanel />
        </Panel>
      </PanelGroup>
    </div>
  );
}
