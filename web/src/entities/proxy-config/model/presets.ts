import type { ThrottleState } from '@/shared/api';

export type PresetKey = 'fast3g' | 'slow3g' | 'custom';

/** Loosely modeled on Chrome DevTools' "Fast 3G"/"Slow 3G" network presets, for a familiar starting point before hand-tweaking. */
export const PRESETS: Record<Exclude<PresetKey, 'custom'>, Omit<ThrottleState, 'enabled'>> = {
  fast3g: { downKbps: 1600, upKbps: 750, latencyMs: 562, packetLossPct: 0 },
  slow3g: { downKbps: 400, upKbps: 400, latencyMs: 2000, packetLossPct: 0 },
};

/** Which preset (if any) a profile's rate/delay fields exactly match — 'custom' when they match none, so hand-tweaked values don't silently relabel themselves as a preset. */
export function presetFor(state: ThrottleState): PresetKey {
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
