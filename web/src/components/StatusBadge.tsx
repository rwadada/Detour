import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

function statusColorVar(status?: number): string {
  if (status === undefined) return 'var(--status-pending)';
  if (status >= 500) return 'var(--status-5xx)';
  if (status >= 400) return 'var(--status-4xx)';
  if (status >= 300) return 'var(--status-3xx)';
  return 'var(--status-2xx)';
}

export function StatusBadge({ status, error }: { status?: number; error?: string }) {
  const color = statusColorVar(status);
  const label = error ? 'ERR' : status !== undefined ? String(status) : '···';
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
