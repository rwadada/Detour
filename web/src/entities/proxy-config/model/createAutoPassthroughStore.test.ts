import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createAutoPassthroughStore, formatRemaining, liveAutoPassthroughEntries } from './createAutoPassthroughStore';

describe('createAutoPassthroughStore (issue #302)', () => {
  it('is null until the server sends its state', () => {
    const fake = fakeDashboardConnection();
    expect(createAutoPassthroughStore(fake.connection).getState().autoPassthrough).toBeNull();
  });

  it("anchors each record to this page's clock when the message arrives", () => {
    const fake = fakeDashboardConnection();
    const store = createAutoPassthroughStore(fake.connection, () => 1_000);
    fake.emit({
      type: 'autoPassthrough',
      state: {
        enabled: true,
        entries: [{ clientAddress: '127.0.0.1', host: 'a.example', port: 443, remainingMs: 5_000 }],
        total: 1,
      },
    });
    expect(store.getState().autoPassthrough).toEqual({
      enabled: true,
      entries: [{ clientAddress: '127.0.0.1', host: 'a.example', port: 443, expiresAt: 6_000 }],
      total: 1,
    });
  });

  it('forgetAll sends a forgetAutoPassthrough command', () => {
    const fake = fakeDashboardConnection();
    createAutoPassthroughStore(fake.connection).getState().forgetAll();
    expect(fake.sent).toEqual([{ type: 'forgetAutoPassthrough' }]);
  });
});

describe('liveAutoPassthroughEntries', () => {
  it('drops lapsed entries and orders the rest soonest-to-lapse first', () => {
    const entry = (host: string, expiresAt: number) => ({ host, port: 443, expiresAt });
    const state = { enabled: true, entries: [entry('late', 300), entry('gone', 100), entry('soon', 200)], total: 3 };
    expect(liveAutoPassthroughEntries(state, 100).map((e) => e.host)).toEqual(['soon', 'late']);
  });
});

describe('formatRemaining', () => {
  it('formats m:ss, rounding up and never going negative', () => {
    expect(formatRemaining(600_000, 0)).toBe('10:00');
    expect(formatRemaining(61_001, 0)).toBe('1:02');
    expect(formatRemaining(0, 5_000)).toBe('0:00');
  });
});
