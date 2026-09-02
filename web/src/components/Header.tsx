import { Moon, Shield, ShieldOff, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FocusControl } from '@/components/FocusControl';
import { ThrottleControl } from '@/components/ThrottleControl';
import { setTheme, useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { useLogStore } from '@/store/useLogStore';

const STATUS_LABEL: Record<string, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  closed: 'Disconnected',
};

const STATUS_DOT: Record<string, string> = {
  connecting: 'bg-[var(--status-3xx)]',
  open: 'bg-[var(--status-2xx)]',
  closed: 'bg-[var(--status-5xx)]',
};

export function Header() {
  const status = useLogStore((s) => s.connectionStatus);
  const pausedBreakpoints = useLogStore((s) => s.pausedBreakpoints);
  const select = useLogStore((s) => s.select);
  const interceptEnabled = useLogStore((s) => s.interceptEnabled);
  const setIntercept = useLogStore((s) => s.setIntercept);
  const theme = useTheme();
  const pausedIds = Object.keys(pausedBreakpoints);

  return (
    <header className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold tracking-tight">Detour</span>
        <span className="text-xs text-[var(--muted)]">Dashboard</span>
      </div>
      <div className="flex items-center gap-3">
        {pausedIds.length > 0 && (
          <button
            type="button"
            onClick={() => select(pausedIds[0] ?? null)}
            className="flex animate-pulse items-center gap-1.5 rounded-full border border-[var(--status-3xx)] px-2 py-0.5 text-xs font-medium text-[var(--status-3xx)]"
            title="Jump to a paused exchange"
          >
            ⏸ {pausedIds.length} paused
          </button>
        )}
        <div className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
          <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[status], status === 'open' && 'animate-pulse')} />
          {STATUS_LABEL[status]}
        </div>
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
        <FocusControl />
        <ThrottleControl />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </header>
  );
}
