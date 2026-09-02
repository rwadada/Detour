import { Moon, Sun } from 'lucide-react';
import { PausedBreakpointsIndicator } from '@/features/breakpoint-resume';
import { FocusControl } from '@/features/focus';
import { InterceptToggle } from '@/features/intercept-toggle';
import { ThrottleControl } from '@/features/throttle';
import { useConnectionStatus } from '@/shared/api';
import { setTheme, useTheme } from '@/shared/lib/theme';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui';

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
  const status = useConnectionStatus();
  const theme = useTheme();

  return (
    <header className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold tracking-tight">Detour</span>
        <span className="text-xs text-[var(--muted)]">Dashboard</span>
      </div>
      <div className="flex items-center gap-3">
        <PausedBreakpointsIndicator />
        <div className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
          <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[status], status === 'open' && 'animate-pulse')} />
          {STATUS_LABEL[status]}
        </div>
        <InterceptToggle />
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
