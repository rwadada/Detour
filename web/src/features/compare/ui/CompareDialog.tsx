import { useMemo } from 'react';
import { isPassthroughDone, MethodBadge, StatusBadge, useExchangeStore } from '@/entities/exchange';
import type { CapturedExchange } from '@/shared/api';
import { cn } from '@/shared/lib/utils';
import { Dialog } from '@/shared/ui';
import { diffExchanges, type BodyDiffLine, type HeaderDiffRow } from '../model/diffExchanges';

/** The Compare dialog (issue #19): two selected exchanges side by side — status/URL, header diff, body diff. Opened from `CompareBar` once two rows are marked for compare. */
export function CompareDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const exchanges = useExchangeStore((s) => s.exchanges);
  const compareIds = useExchangeStore((s) => s.compareIds);
  const [aId, bId] = compareIds;
  const a = useMemo(() => exchanges.find((e) => e.id === aId), [exchanges, aId]);
  const b = useMemo(() => exchanges.find((e) => e.id === bId), [exchanges, bId]);
  const diff = useMemo(() => (a && b ? diffExchanges(a, b) : null), [a, b]);

  if (!a || !b || !diff) return null;

  return (
    <Dialog open={open} onClose={onClose} title="Compare" className="max-w-5xl">
      <div className="grid grid-cols-2 gap-4">
        <ExchangeSummary exchange={a} />
        <ExchangeSummary exchange={b} />
      </div>
      <HeaderDiffSection title="Request Headers" rows={diff.headers.request} />
      <HeaderDiffSection title="Response Headers" rows={diff.headers.response} />
      <BodyDiffSection title="Request Body" rows={diff.requestBody} />
      <BodyDiffSection title="Response Body" rows={diff.responseBody} />
    </Dialog>
  );
}

function ExchangeSummary({ exchange }: { exchange: CapturedExchange }) {
  return (
    <div className="rounded-md border border-[var(--border)] p-2">
      <div className="flex items-center gap-2">
        <MethodBadge method={exchange.method} />
        <StatusBadge status={exchange.statusCode} error={exchange.error} passthrough={isPassthroughDone(exchange)} />
      </div>
      <p className="mt-1 break-all font-mono-ui text-xs text-[var(--muted)]">{exchange.url}</p>
    </div>
  );
}

function HeaderDiffSection({ title, rows }: { title: string; rows: HeaderDiffRow[] }) {
  const changed = rows.filter((r) => r.status !== 'same');
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
        {title} {changed.length > 0 && <span className="text-[var(--accent)]">({changed.length} changed)</span>}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">None.</p>
      ) : (
        <div className="space-y-0.5 font-mono-ui text-xs">
          {rows.map((row) => (
            <div
              key={row.name}
              className={cn(
                'grid grid-cols-[10rem_1fr_1fr] gap-2 rounded px-1 py-0.5',
                row.status !== 'same' && 'bg-[var(--accent)]/10',
              )}
            >
              <span className="truncate text-[var(--muted)]">{row.name}</span>
              <span className={cn('truncate', row.status === 'removed' && 'text-[var(--status-5xx)]')}>
                {row.a ?? '—'}
              </span>
              <span className={cn('truncate', row.status === 'added' && 'text-[var(--status-2xx)]')}>
                {row.b ?? '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BodyDiffSection({ title, rows }: { title: string; rows: BodyDiffLine[] }) {
  const changedCount = rows.filter((r) => !r.same).length;
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
        {title} {changedCount > 0 && <span className="text-[var(--accent)]">({changedCount} lines differ)</span>}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">No body on either side.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 overflow-hidden rounded-md border border-[var(--border)]">
          <BodyColumn lines={rows.map((r) => r.a)} diffFlags={rows.map((r) => !r.same)} />
          <BodyColumn
            lines={rows.map((r) => r.b)}
            diffFlags={rows.map((r) => !r.same)}
            className="border-l border-[var(--border)]"
          />
        </div>
      )}
    </div>
  );
}

function BodyColumn({
  lines,
  diffFlags,
  className,
}: {
  lines: (string | undefined)[];
  diffFlags: boolean[];
  className?: string;
}) {
  return (
    <pre className={cn('max-h-56 overflow-auto p-2 font-mono-ui text-xs', className)}>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reordered — index is a stable, correct key here.
        <div key={i} className={cn(diffFlags[i] && 'bg-[var(--accent)]/10')}>
          {line ?? <span className="text-[var(--muted)]">·</span>}
        </div>
      ))}
    </pre>
  );
}
