import { Badge } from '@/shared/ui';
import { cn } from '@/shared/lib/utils';

function statusColorVar(status?: number): string {
  if (status === undefined) return 'var(--status-pending)';
  if (status >= 500) return 'var(--status-5xx)';
  if (status >= 400) return 'var(--status-4xx)';
  if (status >= 300) return 'var(--status-3xx)';
  return 'var(--status-2xx)';
}

function statusLabel(status?: number, error?: string): string {
  if (error) return 'ERR';
  if (status !== undefined) return String(status);
  return '···';
}

export function StatusBadge({ status, error }: { status?: number; error?: string }) {
  const color = statusColorVar(status);
  const label = statusLabel(status, error);
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
  return (
    <Badge className="min-w-[3.5rem] justify-center text-[var(--method)]" style={{ color: 'var(--method)' }}>
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
