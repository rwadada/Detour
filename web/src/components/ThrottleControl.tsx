import { Gauge } from 'lucide-react';
import { useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { PillToggle } from '@/components/ui/pill-toggle';
import { Select } from '@/components/ui/select';
import { useDismissablePopover } from '@/lib/useDismissablePopover';
import { cn } from '@/lib/utils';
import { useLogStore } from '@/store/useLogStore';
import type { ThrottleState } from '@/types';

type PresetKey = 'fast3g' | 'slow3g' | 'custom';

/** Loosely modeled on Chrome DevTools' "Fast 3G"/"Slow 3G" network presets, for a familiar starting point before hand-tweaking. */
const PRESETS: Record<Exclude<PresetKey, 'custom'>, Omit<ThrottleState, 'enabled'>> = {
  fast3g: { downKbps: 1600, upKbps: 750, latencyMs: 562, packetLossPct: 0 },
  slow3g: { downKbps: 400, upKbps: 400, latencyMs: 2000, packetLossPct: 0 },
};

/** Which preset (if any) a profile's rate/delay fields exactly match — 'custom' when they match none, so hand-tweaked values don't silently relabel themselves as a preset. */
function presetFor(state: ThrottleState): PresetKey {
  for (const [key, preset] of Object.entries(PRESETS) as [Exclude<PresetKey, 'custom'>, ThrottleState][]) {
    if (
      preset.downKbps === state.downKbps &&
      preset.upKbps === state.upKbps &&
      preset.latencyMs === state.latencyMs &&
      preset.packetLossPct === state.packetLossPct
    ) {
      return key;
    }
  }
  return 'custom';
}

/**
 * Header control for "Throttle" (issue #13): simulates degraded network
 * conditions — bandwidth cap, latency, packet loss — on proxied traffic.
 * Mirrors FocusControl's popover pattern (a button that opens a small
 * editable panel) since, like Focus, this needs more than a single boolean.
 */
export function ThrottleControl() {
  const throttle = useLogStore((s) => s.throttle);
  const setThrottle = useLogStore((s) => s.setThrottle);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useDismissablePopover(open, containerRef, () => setOpen(false));

  const applyPreset = (key: PresetKey) => {
    if (key === 'custom') return; // no fields to apply — the profile just doesn't match a preset anymore
    setThrottle({ ...throttle, enabled: true, ...PRESETS[key] });
  };

  const patch = (fields: Partial<Omit<ThrottleState, 'enabled'>>) => setThrottle({ ...throttle, ...fields });

  const active = throttle.enabled;

  return (
    <div className="relative" ref={containerRef}>
      <PillToggle
        active={active}
        onClick={() => setOpen((v) => !v)}
        icon={<Gauge className="h-3 w-3" />}
        title={
          active
            ? `Throttle is on — ${throttle.downKbps || '∞'} Kbps↓ / ${throttle.upKbps || '∞'} Kbps↑, +${throttle.latencyMs}ms latency, ${throttle.packetLossPct}% simulated loss`
            : 'Throttle is off — click to simulate bandwidth/latency/packet loss'
        }
      >
        Throttle {active ? 'On' : 'Off'}
      </PillToggle>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2.5 shadow-lg">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs text-[var(--muted)]">Simulate degraded network conditions.</p>
            <button
              type="button"
              onClick={() => setThrottle({ ...throttle, enabled: !throttle.enabled })}
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                active
                  ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                  : 'border border-[var(--border)] text-[var(--muted)]',
              )}
            >
              {active ? 'On' : 'Off'}
            </button>
          </div>
          <Select
            value={presetFor(throttle)}
            onChange={(e) => applyPreset(e.target.value as PresetKey)}
            className="mb-2 w-full"
          >
            <option value="fast3g">Fast 3G</option>
            <option value="slow3g">Slow 3G</option>
            <option value="custom">Custom</option>
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] text-[var(--muted)]">
              Download (Kbps)
              <Input
                type="number"
                min={0}
                value={throttle.downKbps}
                onChange={(e) => patch({ downKbps: Math.max(0, Number(e.target.value) || 0) })}
                className="mt-0.5 h-7 text-xs"
              />
            </label>
            <label className="text-[10px] text-[var(--muted)]">
              Upload (Kbps)
              <Input
                type="number"
                min={0}
                value={throttle.upKbps}
                onChange={(e) => patch({ upKbps: Math.max(0, Number(e.target.value) || 0) })}
                className="mt-0.5 h-7 text-xs"
              />
            </label>
            <label className="text-[10px] text-[var(--muted)]">
              Latency (ms)
              <Input
                type="number"
                min={0}
                value={throttle.latencyMs}
                onChange={(e) => patch({ latencyMs: Math.max(0, Number(e.target.value) || 0) })}
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
                onChange={(e) => patch({ packetLossPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
                className="mt-0.5 h-7 text-xs"
              />
            </label>
          </div>
          <p className="mt-2 text-[10px] text-[var(--muted)]">0 means unlimited/none for that field.</p>
        </div>
      )}
    </div>
  );
}
