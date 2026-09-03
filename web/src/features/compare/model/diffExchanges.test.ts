import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '@/shared/api';
import { diffBodyLines, diffExchanges, diffHeaders } from './diffExchanges';

describe('diffHeaders', () => {
  it('marks a header present only in b as added, only in a as removed', () => {
    const rows = diffHeaders({ a: '1' }, { b: '2' });
    expect(rows).toEqual([
      { name: 'a', a: '1', b: undefined, status: 'removed' },
      { name: 'b', a: undefined, b: '2', status: 'added' },
    ]);
  });

  it('marks a header with the same value as same, a different value as changed', () => {
    const rows = diffHeaders({ x: 'same', y: 'old' }, { x: 'same', y: 'new' });
    expect(rows).toEqual([
      { name: 'x', a: 'same', b: 'same', status: 'same' },
      { name: 'y', a: 'old', b: 'new', status: 'changed' },
    ]);
  });

  it('handles undefined headers on either side', () => {
    expect(diffHeaders(undefined, { a: '1' })).toEqual([{ name: 'a', a: undefined, b: '1', status: 'added' }]);
    expect(diffHeaders(undefined, undefined)).toEqual([]);
  });

  it('sorts rows by header name', () => {
    const rows = diffHeaders({ zeta: '1', alpha: '1' }, {});
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('diffBodyLines', () => {
  it('marks identical lines as same', () => {
    expect(diffBodyLines('a\nb', 'a\nb')).toEqual([
      { a: 'a', b: 'a', same: true },
      { a: 'b', b: 'b', same: true },
    ]);
  });

  it('marks differing lines as not-same', () => {
    expect(diffBodyLines('a\nb', 'a\nc')).toEqual([
      { a: 'a', b: 'a', same: true },
      { a: 'b', b: 'c', same: false },
    ]);
  });

  it('pads the shorter side with undefined', () => {
    expect(diffBodyLines('a', 'a\nb')).toEqual([
      { a: 'a', b: 'a', same: true },
      { a: undefined, b: 'b', same: false },
    ]);
  });

  it('treats both sides absent as no lines', () => {
    expect(diffBodyLines(undefined, undefined)).toEqual([]);
  });
});

describe('diffExchanges', () => {
  function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
    return {
      id: 'x1',
      method: 'GET',
      url: 'https://example.com/',
      host: 'example.com',
      isSSL: true,
      protocol: 'HTTP/1.1',
      requestHeaders: {},
      requestBodySize: 0,
      responseBodySize: 0,
      startedAt: 0,
      ...overrides,
    };
  }

  it('diffs headers and decoded bodies for both request and response', () => {
    const a = exchange({
      requestHeaders: { 'content-type': 'application/json' },
      responseHeaders: { 'x-status': 'a' },
      responseBody: btoa('hello'),
    });
    const b = exchange({
      requestHeaders: { 'content-type': 'application/json' },
      responseHeaders: { 'x-status': 'b' },
      responseBody: btoa('world'),
    });

    const diff = diffExchanges(a, b);

    expect(diff.headers.request).toEqual([
      { name: 'content-type', a: 'application/json', b: 'application/json', status: 'same' },
    ]);
    expect(diff.headers.response).toEqual([{ name: 'x-status', a: 'a', b: 'b', status: 'changed' }]);
    expect(diff.responseBody).toEqual([{ a: 'hello', b: 'world', same: false }]);
  });
});
