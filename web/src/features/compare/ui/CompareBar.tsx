import { GitCompare, X } from 'lucide-react';
import { useState } from 'react';
import { useExchangeStore } from '@/entities/exchange';
import { Button } from '@/shared/ui';
import { CompareDialog } from './CompareDialog';

/**
 * Shown in `FilterBar` once at least one row is marked for Compare (issue
 * #19: ctrl/cmd-click a row in `LogTable` to mark it). Opens `CompareDialog`
 * once two are marked; renders nothing otherwise, so it costs no space in
 * the common case where nothing is marked.
 */
export function CompareBar() {
  const compareIds = useExchangeStore((s) => s.compareIds);
  const clearCompare = useExchangeStore((s) => s.clearCompare);
  const [open, setOpen] = useState(false);

  if (compareIds.length === 0) return null;

  const ready = compareIds.length === 2;

  return (
    <>
      <div className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs">
        <GitCompare className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span>{ready ? 'Compare ready' : `${compareIds.length} selected — pick one more`}</span>
        {ready && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            Compare
          </Button>
        )}
        <button
          type="button"
          onClick={clearCompare}
          className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--row-hover)]"
          title="Clear compare selection"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <CompareDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
