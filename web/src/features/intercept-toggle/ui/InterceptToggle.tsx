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
        interceptEnabled
          ? 'border-[var(--status-2xx)] text-[var(--status-2xx)]'
          : 'border-[var(--muted)] text-[var(--muted)]',
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
