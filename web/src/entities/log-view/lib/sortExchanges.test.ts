import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '@/shared/api';
import { groupExchangesByHost, sortExchanges } from './sortExchanges';

function exchange(overrides: Partial<CapturedExchange> & { id: string }): CapturedExchange {
  return {
    method: 'GET',
    url: 'https://example.com/',
    host: 'example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    startedAt: 0,
    responseBodySize: 0,
    ...overrides,
  };
}

describe('sortExchanges', () => {
  it('sorts ascending by the given numeric column', () => {
    const exchanges = [exchange({ id: 'a', durationMs: 300 }), exchange({ id: 'b', durationMs: 100 })];
    const sorted = sortExchanges(exchanges, { column: 'duration', direction: 'asc' });
    expect(sorted.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('sorts descending when direction is desc', () => {
    const exchanges = [exchange({ id: 'a', durationMs: 100 }), exchange({ id: 'b', durationMs: 300 })];
    const sorted = sortExchanges(exchanges, { column: 'duration', direction: 'desc' });
    expect(sorted.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('sorts lexicographically by url', () => {
    const exchanges = [exchange({ id: 'a', url: 'https://b.com/' }), exchange({ id: 'b', url: 'https://a.com/' })];
    const sorted = sortExchanges(exchanges, { column: 'url', direction: 'asc' });
    expect(sorted.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('always sorts undefined values (e.g. a still-pending status/duration) last, regardless of direction', () => {
    const exchanges = [exchange({ id: 'pending', statusCode: undefined }), exchange({ id: 'done', statusCode: 200 })];
    expect(sortExchanges(exchanges, { column: 'status', direction: 'asc' }).map((e) => e.id)).toEqual([
      'done',
      'pending',
    ]);
    expect(sortExchanges(exchanges, { column: 'status', direction: 'desc' }).map((e) => e.id)).toEqual([
      'done',
      'pending',
    ]);
  });

  it('does not mutate the input array', () => {
    const exchanges = [exchange({ id: 'a', durationMs: 300 }), exchange({ id: 'b', durationMs: 100 })];
    sortExchanges(exchanges, { column: 'duration', direction: 'asc' });
    expect(exchanges.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('groupExchangesByHost', () => {
  it('groups rows by host, host groups alphabetical', () => {
    const exchanges = [
      exchange({ id: 'a', host: 'b.com' }),
      exchange({ id: 'b', host: 'a.com' }),
      exchange({ id: 'c', host: 'a.com' }),
    ];
    const groups = groupExchangesByHost(exchanges);
    expect(groups.map((g) => g.host)).toEqual(['a.com', 'b.com']);
    expect(groups[0]?.exchanges.map((e) => e.id)).toEqual(['b', 'c']);
    expect(groups[1]?.exchanges.map((e) => e.id)).toEqual(['a']);
  });

  it('preserves each group’s incoming (already-sorted) order', () => {
    const exchanges = [
      exchange({ id: 'a', host: 'x.com', durationMs: 300 }),
      exchange({ id: 'b', host: 'x.com', durationMs: 100 }),
    ];
    const groups = groupExchangesByHost(exchanges);
    expect(groups[0]?.exchanges.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array for no exchanges', () => {
    expect(groupExchangesByHost([])).toEqual([]);
  });
});
