import { useExchangeStore } from '@/entities/exchange';
import { useBreakpointResumeStore } from '../model/store';

/** Header pill showing how many exchanges are currently paused by a breakpoint, jumping the inspector to the first one on click. */
export function PausedBreakpointsIndicator() {
  const pausedBreakpoints = useBreakpointResumeStore((s) => s.pausedBreakpoints);
  const select = useExchangeStore((s) => s.select);
  const pausedIds = Object.keys(pausedBreakpoints);

  if (pausedIds.length === 0) return null;

  return (
    <button
      type="button"
      onClick={() => select(pausedIds[0] ?? null)}
      className="flex animate-pulse items-center gap-1.5 rounded-full border border-[var(--status-3xx)] px-2 py-0.5 text-xs font-medium text-[var(--status-3xx)]"
      title="Jump to a paused exchange"
    >
      ⏸ {pausedIds.length} paused
    </button>
  );
}
