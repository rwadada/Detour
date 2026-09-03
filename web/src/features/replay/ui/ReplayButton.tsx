import { RotateCw } from 'lucide-react';
import type { CapturedExchange } from '@/shared/api';
import { Button } from '@/shared/ui';
import { useReplayStore } from '../model/store';

/** Re-sends a captured exchange for real (issue #19), shown in `InspectorPanel`. The replayed request appears as a new row in the log table once the server responds. */
export function ReplayButton({ exchange }: { exchange: CapturedExchange }) {
  const replay = useReplayStore((s) => s.replay);

  return (
    <Button variant="ghost" size="icon" onClick={() => replay(exchange)} title="Replay this request">
      <RotateCw className="h-3.5 w-3.5" />
    </Button>
  );
}
