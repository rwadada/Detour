import type { ExchangeTiming } from '@/shared/api';
import { cn } from '@/shared/lib/utils';

/** One `ExchangeTiming` phase, in the order it actually occurs on the wire. */
const PHASES: ReadonlyArray<{ key: keyof ExchangeTiming; label: string; color: string }> = [
  { key: 'dnsMs', label: 'DNS Lookup', color: 'var(--timing-dns)' },
  { key: 'tcpMs', label: 'Initial Connection', color: 'var(--timing-tcp)' },
  { key: 'tlsMs', label: 'TLS Handshake', color: 'var(--timing-tls)' },
  { key: 'ttfbMs', label: 'Waiting (TTFB)', color: 'var(--timing-ttfb)' },
  { key: 'transferMs', label: 'Content Download', color: 'var(--timing-transfer)' },
];

/**
 * Per-request timing waterfall (issue #141): a horizontal stacked bar of the
 * DNS/TCP/TLS/TTFB/transfer phases `ExchangeTiming` (issue #140) measured,
 * each segment's width proportional to its share of the total, plus a
 * legend with the exact millisecond value for every phase that was
 * actually measured. A phase `timing` doesn't have (e.g. `tlsMs` for plain
 * HTTP, or every field when the exchange never reached upstream) is simply
 * absent — its color never appears in the bar or the legend.
 */
export function TimingWaterfall({ timing }: { timing: ExchangeTiming | undefined }) {
  const measured = PHASES.map((phase) => ({ ...phase, ms: timing?.[phase.key] })).filter(
    (phase): phase is { key: keyof ExchangeTiming; label: string; color: string; ms: number } => phase.ms !== undefined,
  );

  if (measured.length === 0) {
    // `timing.connectionReused` (issue #162) never coincides with an empty
    // `measured` here: `attachTiming` only ever attaches a `timing` object
    // once at least one of these same five phases is set, so a `timing`
    // that reaches this component at all always has something to show.
    return (
      <p className="p-3 text-xs text-[var(--muted)]">
        No timing breakdown available — this request never reached an upstream server (e.g. a mock, a blocked host, or a
        breakpoint aborted before forwarding).
      </p>
    );
  }

  const total = measured.reduce((sum, phase) => sum + phase.ms, 0) || 1;

  return (
    <div className="p-3">
      {timing?.connectionReused && (
        <p className="mb-2 text-xs text-[var(--muted)]">
          Connection reused (keep-alive) — DNS/TCP/TLS were not repeated for this request.
        </p>
      )}
      <div
        className="flex h-4 w-full overflow-hidden rounded-sm border border-[var(--border)]"
        role="img"
        aria-label={measured.map((phase) => `${phase.label}: ${phase.ms}ms`).join(', ')}
      >
        {measured.map((phase) => (
          <div
            key={phase.key}
            className={cn('h-full', phase.ms === 0 && 'min-w-px')}
            style={{ width: `${(phase.ms / total) * 100}%`, backgroundColor: phase.color }}
            title={`${phase.label}: ${phase.ms}ms`}
          />
        ))}
      </div>

      <ul className="mt-3 space-y-1.5">
        {measured.map((phase) => (
          <li key={phase.key} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-2 text-[var(--foreground)]">
              <span className="h-2.5 w-2.5 shrink-0 rounded-xs" style={{ backgroundColor: phase.color }} />
              {phase.label}
            </span>
            <span className="font-mono-ui text-[var(--muted)]">{phase.ms}ms</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
