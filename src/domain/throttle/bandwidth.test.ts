import { describe, expect, it, vi } from 'vitest';
import { BandwidthState, RETRANSMIT_DELAY_MS, transferDelayMs } from './bandwidth';

describe('BandwidthState', () => {
  it('returns 0 delay when unlimited (kbps <= 0)', () => {
    const bandwidth = new BandwidthState();
    expect(bandwidth.delayFor(1000, 0)).toBe(0);
  });

  it('charges even a lone first chunk for the time it takes to "transmit"', () => {
    const bandwidth = new BandwidthState();
    // 8 kbps = 1000 bytes/sec, so a 1000-byte chunk takes ~1000ms.
    const delay = bandwidth.delayFor(1000, 8);
    expect(delay).toBeGreaterThan(900);
  });
});

describe('transferDelayMs', () => {
  it('adds no extra delay when packetLossPct is 0', () => {
    const bandwidth = new BandwidthState();
    expect(transferDelayMs(0, 0, 0, bandwidth)).toBe(0);
  });

  it('adds the retransmit stall when loss is forced (Math.random mocked to 0)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const bandwidth = new BandwidthState();
    expect(transferDelayMs(0, 0, 100, bandwidth)).toBe(RETRANSMIT_DELAY_MS);
    vi.restoreAllMocks();
  });
});
