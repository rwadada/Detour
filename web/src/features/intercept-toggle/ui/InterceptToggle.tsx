import { Shield, ShieldOff } from 'lucide-react';
import { useInterceptStore } from '@/entities/proxy-config';
import { cn } from '@/shared/lib/utils';

export function InterceptToggle() {
  const interceptEnabled = useInterceptStore((s) => s.interceptEnabled);
  const setIntercept = useInterceptStore((s) => s.setIntercept);

  return (
    <button
      type="button"
      onClick={() => setIntercept(!interceptEnabled)}
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
        // `--accent`, not `--status-2xx`: that token means "2xx response" everywhere else this app
        // uses it (StatusBadge, the log table) — reusing it here for "feature is on" taught the
        // opposite lesson at a glance once the two shared a color in the same UI.
        interceptEnabled ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--muted)] text-[var(--muted)]',
      )}
      title={
        interceptEnabled
          ? 'Intercept is on — click to turn off (TLS passthrough, rewrite rules disabled; routing still applies)'
          : 'Intercept is off — click to turn back on'
      }
    >
      {interceptEnabled ? <Shield className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
      Intercept {interceptEnabled ? 'On' : 'Off'}
    </button>
  );
}
