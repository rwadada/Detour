import { Pause, Play } from 'lucide-react';
import { useExchangeStore } from '@/entities/exchange';
import { PillToggle } from '@/shared/ui';

/**
 * Toolbar control for Pause/Tail (issue #24): freezes the log table's view
 * so a fast-moving stream can be read without new rows yanking the scroll
 * position — traffic keeps being captured underneath either way (see
 * `entities/exchange`'s `paused`/`togglePause`), nothing is lost by pausing.
 */
export function PauseTailToggle() {
  const paused = useExchangeStore((s) => s.paused);
  const togglePause = useExchangeStore((s) => s.togglePause);

  return (
    <PillToggle
      active={paused}
      onClick={togglePause}
      icon={paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
      title={
        paused
          ? 'Log view is paused — click to resume tailing live traffic'
          : 'Click to pause the log view (capture keeps running in the background)'
      }
    >
      {paused ? 'Paused' : 'Tail'}
    </PillToggle>
  );
}
