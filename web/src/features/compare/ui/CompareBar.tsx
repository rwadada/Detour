import { GitCompare, X } from 'lucide-react';
import { useState } from 'react';
import { useExchangeStore } from '@/entities/exchange';
import { Button } from '@/shared/ui';
import { CompareDialog } from './CompareDialog';

/**
 * Shown in `FilterBar` once at least one row is marked for Compare (issue
 * #19: ctrl/cmd-click a row in `LogTable` to mark it). Opens `CompareDialog`
 * once two are marked.
 *
 * Before anything is marked, this rendered nothing at all — the only way to
 * learn ctrl/cmd-click marks a row for Compare was a native `title` tooltip
 * on the row itself, which needs a multi-second hover on the exact row to
 * ever surface (QA/design review: the feature was effectively undiscoverable
 * without already knowing it existed). A short static hint here — cheap,
 * always in the same spot rows are clicked from — replaces that reliance on
 * a tooltip nobody hovers long enough to see.
 */
export function CompareBar() {
  const compareIds = useExchangeStore((s) => s.compareIds);
  const clearCompare = useExchangeStore((s) => s.clearCompare);
  const hasExchanges = useExchangeStore((s) => s.exchanges.length > 0);
  const [open, setOpen] = useState(false);

  if (compareIds.length === 0) {
    if (!hasExchanges) return null;
    return <span className="text-[10px] text-[var(--muted)]">⌘/Ctrl-click two rows to compare</span>;
  }

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
