import type { ThrottleState } from '@/shared/api';
import { Input } from '@/shared/ui';

/**
 * The four numeric Throttle fields (Download/Upload/Latency/Packet loss),
 * shared by `features/throttle`'s toolbar popover and `features/settings-
 * panel`'s consolidated form — both edit the exact same `ThrottleState`,
 * just in different-sized containers.
 */
export function ThrottleFields({
  throttle,
  onChange,
}: {
  throttle: ThrottleState;
  onChange: (patch: Partial<Omit<ThrottleState, 'enabled'>>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="text-[10px] text-[var(--muted)]">
        Download (Kbps)
        <Input
          type="number"
          min={0}
          value={throttle.downKbps}
          onChange={(e) => onChange({ downKbps: Math.max(0, Number(e.target.value) || 0) })}
          className="mt-0.5 h-7 text-xs"
        />
      </label>
      <label className="text-[10px] text-[var(--muted)]">
        Upload (Kbps)
        <Input
          type="number"
          min={0}
          value={throttle.upKbps}
          onChange={(e) => onChange({ upKbps: Math.max(0, Number(e.target.value) || 0) })}
          className="mt-0.5 h-7 text-xs"
        />
      </label>
      <label className="text-[10px] text-[var(--muted)]">
        Latency (ms)
        <Input
          type="number"
          min={0}
          value={throttle.latencyMs}
          onChange={(e) => onChange({ latencyMs: Math.max(0, Number(e.target.value) || 0) })}
          className="mt-0.5 h-7 text-xs"
        />
      </label>
      <label className="text-[10px] text-[var(--muted)]">
        Packet loss (%)
        <Input
          type="number"
          min={0}
          max={100}
          value={throttle.packetLossPct}
          onChange={(e) => onChange({ packetLossPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
          className="mt-0.5 h-7 text-xs"
        />
      </label>
    </div>
  );
}
