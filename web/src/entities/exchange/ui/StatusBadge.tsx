import { Tag } from 'lucide-react';
import { Badge } from '@/shared/ui';
import { cn } from '@/shared/lib/utils';

function statusColorVar(status?: number, error?: string): string {
  // Checked first — an exchange can have `error` set with no `statusCode`
  // at all (a proxy-level failure before any response arrived; every
  // passthrough tunnel failure), and until this was added that fell
  // through to the `status === undefined` branch below: the label already
  // showed `ERR` (see `statusLabel`), but the color stayed the "pending"
  // gray instead of the red a failure should be.
  if (error) return 'var(--status-5xx)';
  if (status === undefined) return 'var(--status-pending)';
  if (status >= 500) return 'var(--status-5xx)';
  if (status >= 400) return 'var(--status-4xx)';
  if (status >= 300) return 'var(--status-3xx)';
  return 'var(--status-2xx)';
}

function statusLabel(status?: number, error?: string, passthrough?: boolean): string {
  if (error) return 'ERR';
  // Checked before the `status === undefined` fallback below, not after —
  // a passthrough tunnel's `statusCode` is never anything *but* undefined
  // (see `CapturedExchange.passthrough`'s doc comment), so without this it
  // would show the same '···' as a request still genuinely in flight,
  // forever, even once the tunnel's long since closed.
  if (passthrough) return 'TLS';
  if (status !== undefined) return String(status);
  return '···';
}

export function StatusBadge({
  status,
  error,
  passthrough,
}: {
  status?: number;
  error?: string;
  passthrough?: boolean;
}) {
  const color = statusColorVar(status, error);
  const label = statusLabel(status, error, passthrough);
  return (
    <Badge
      className={cn('min-w-[3.25rem] justify-center border')}
      style={{ color, borderColor: color, backgroundColor: `color-mix(in oklch, ${color} 14%, transparent)` }}
    >
      {label}
    </Badge>
  );
}

export function MethodBadge({ method }: { method: string }) {
  // min-w fits `OPTIONS` (the longest method in the Method filter's own
  // option list — see `web/src/widgets/toolbar/ui/Toolbar.tsx`'s
  // `METHODS`) and `CONNECT` (not filterable there, but still a real
  // method a captured exchange can carry — proxyServer.ts records one for
  // every CONNECT tunnel, and it renders through this same badge). At the
  // previous 3.5rem, either overflowed this badge's box, visually running
  // into whatever sits to its left (the Time column, in the log table)
  // with no gap. Pair any change here with `DEFAULT_COLUMN_WIDTHS.method`
  // (`entities/log-view`), which sizes the log table's own column to match.
  return (
    <Badge className="min-w-[4.5rem] justify-center text-[var(--method)]" style={{ color: 'var(--method)' }}>
      {method}
    </Badge>
  );
}

/**
 * Shown next to the method/status of an HTTP/2-negotiated exchange (issue
 * #16). Renders nothing for the (overwhelmingly common) HTTP/1.1 case,
 * rather than a column showing the same label on every row.
 */
export function ProtocolBadge({ protocol }: { protocol: 'HTTP/1.1' | 'HTTP/2' }) {
  if (protocol !== 'HTTP/2') return null;
  return (
    <Badge
      className="min-w-[2rem] justify-center border"
      style={{
        color: 'var(--accent)',
        borderColor: 'var(--accent)',
        backgroundColor: 'color-mix(in oklch, var(--accent) 14%, transparent)',
      }}
      title="Negotiated HTTP/2 with the client"
    >
      h2
    </Badge>
  );
}

/** Shown in place of `StatusBadge` for an exchange currently paused by a `breakpoint` rule. */
/**
 * Which rule (if any) matched this exchange — previously only visible in
 * `InspectorPanel`'s detail view, one exchange at a time, which made it
 * impossible to tell at a glance which of several rules applied across a
 * whole session's traffic without clicking into every row (a bug report:
 * "with 2+ rules I can't see [which one applied]"). A fixed-size icon
 * rather than the rule's own (arbitrary-length) name as a text badge —
 * `LogRow`'s URL cell is already tight on width, and a review of the first
 * version of this (a truncated text badge) found it could still crowd out
 * the URL text almost entirely. The full name is still always available,
 * both in the `title` tooltip here and in `InspectorPanel`'s own "rule:"
 * line once a row is selected.
 */
export function RuleBadge({ ruleName }: { ruleName: string }) {
  return (
    <span className="inline-flex shrink-0 items-center" style={{ color: 'var(--accent)' }} title={`Rule: ${ruleName}`}>
      <Tag className="h-3 w-3" />
    </span>
  );
}

export function BreakpointBadge({ phase }: { phase: 'request' | 'response' }) {
  const color = 'var(--status-3xx)';
  return (
    <Badge
      className="min-w-[3.25rem] animate-pulse justify-center border"
      style={{ color, borderColor: color, backgroundColor: `color-mix(in oklch, ${color} 14%, transparent)` }}
      title={`Paused at ${phase} breakpoint`}
    >
      ⏸ {phase === 'request' ? 'REQ' : 'RES'}
    </Badge>
  );
}
