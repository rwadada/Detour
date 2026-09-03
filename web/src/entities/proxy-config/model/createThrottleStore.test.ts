import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { DEFAULT_THROTTLE_STATE, createThrottleStore } from './createThrottleStore';

describe('createThrottleStore', () => {
  it('defaults to the true no-op profile', () => {
    const fake = fakeDashboardConnection();
    const store = createThrottleStore(fake.connection);
    expect(store.getState().throttle).toEqual(DEFAULT_THROTTLE_STATE);
  });

  it('mirrors the server-pushed profile', () => {
    const fake = fakeDashboardConnection();
    const store = createThrottleStore(fake.connection);
    const profile = { enabled: true, downKbps: 100, upKbps: 50, latencyMs: 10, packetLossPct: 0 };
    fake.emit({ type: 'throttle', state: profile });
    expect(store.getState().throttle).toEqual(profile);
  });

  it('setThrottle sends a setThrottle command', () => {
    const fake = fakeDashboardConnection();
    const store = createThrottleStore(fake.connection);
    store.getState().setThrottle(DEFAULT_THROTTLE_STATE);
    expect(fake.sent).toEqual([{ type: 'setThrottle', state: DEFAULT_THROTTLE_STATE }]);
  });
});
