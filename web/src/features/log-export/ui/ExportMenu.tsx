import { Download } from 'lucide-react';
import { useRef, useState } from 'react';
import { exchangesToHar, useExchangeStore } from '@/entities/exchange';
import { downloadTextFile } from '@/shared/lib/downloadTextFile';
import { useDismissablePopover } from '@/shared/lib/useDismissablePopover';
import { Button } from '@/shared/ui';
import { exportFileName, serializeExchangesAsJson, serializeHar, type ExportFormat } from '../model/exportLog';

/**
 * Header control for exporting the captured log (issue #19): HAR 1.2 for
 * other HTTP-debugging tools, or Detour's own JSON export (re-importable by
 * `LogViewer`'s `ImportButton`). Mirrors `ThrottleControl`'s popover pattern.
 */
export function ExportMenu() {
  const exchanges = useExchangeStore((s) => s.exchanges);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(open, containerRef, () => setOpen(false));

  const handleExport = (format: ExportFormat) => {
    const content = format === 'har' ? serializeHar(exchangesToHar(exchanges)) : serializeExchangesAsJson(exchanges);
    downloadTextFile(exportFileName(format), content);
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        disabled={exchanges.length === 0}
        title={exchanges.length === 0 ? 'No captured requests to export' : 'Export the captured log'}
      >
        <Download className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-44 rounded-md border border-[var(--border)] bg-[var(--panel)] p-1 shadow-lg">
          <button
            type="button"
            onClick={() => handleExport('har')}
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/10"
          >
            Export as HAR
          </button>
          <button
            type="button"
            onClick={() => handleExport('json')}
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/10"
          >
            Export as JSON
          </button>
        </div>
      )}
    </div>
  );
}
