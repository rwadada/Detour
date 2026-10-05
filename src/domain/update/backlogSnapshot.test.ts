import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '../exchange/types';
import { BACKLOG_SNAPSHOT_TTL_MS, parseBacklogSnapshot, serializeBacklogSnapshot } from './backlogSnapshot';

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'a',
    method: 'GET',
    url: 'https://example.com/',
    host: 'example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    startedAt: 1,
    statusCode: 200,
    responseBodySize: 0,
    finishedAt: 2,
    ...overrides,
  };
}

describe('backlog snapshot', () => {
  it('round-trips finished exchanges including their binary bodies', () => {
    const body = Buffer.from([0, 255, 10, 13]);
    const text = serializeBacklogSnapshot([exchange({ requestBody: body, responseBody: Buffer.from('hi') })], 1000);
    const [restored] = parseBacklogSnapshot(text, 1000);
    expect(restored?.requestBody).toEqual(body);
    expect(restored?.responseBody?.toString()).toBe('hi');
    expect(restored).toMatchObject({ id: 'a', url: 'https://example.com/', statusCode: 200 });
  });

  it('keeps the order of the exchanges', () => {
    const text = serializeBacklogSnapshot([exchange({ id: '1' }), exchange({ id: '2' }), exchange({ id: '3' })], 0);
    expect(parseBacklogSnapshot(text, 0).map((e) => e.id)).toEqual(['1', '2', '3']);
  });

  it('drops exchanges that were still in flight', () => {
    const pending = exchange({ id: 'pending', statusCode: undefined, finishedAt: undefined });
    const failed = exchange({ id: 'failed', statusCode: undefined, finishedAt: undefined, error: 'ECONNRESET' });
    const streaming = exchange({ id: 'streaming', statusCode: 200, finishedAt: undefined });
    const text = serializeBacklogSnapshot([pending, streaming, failed, exchange({ id: 'done' })], 0);
    expect(parseBacklogSnapshot(text, 0).map((e) => e.id)).toEqual(['failed', 'done']);
  });

  it('forgets a breakpoint pause, which cannot be resumed after a restart', () => {
    const text = serializeBacklogSnapshot([exchange({ breakpoint: 'response' })], 0);
    expect(parseBacklogSnapshot(text, 0)[0]?.breakpoint).toBeUndefined();
  });

  it('drops an exchange held at a response breakpoint: it has headers but no end', () => {
    const held = exchange({ id: 'held', finishedAt: undefined, breakpoint: 'response' });
    expect(parseBacklogSnapshot(serializeBacklogSnapshot([held], 0), 0)).toEqual([]);
  });

  it('ignores a snapshot older than the TTL, or dated in the future', () => {
    const text = serializeBacklogSnapshot([exchange()], 1000);
    expect(parseBacklogSnapshot(text, 1000 + BACKLOG_SNAPSHOT_TTL_MS)).toHaveLength(1);
    expect(parseBacklogSnapshot(text, 1000 + BACKLOG_SNAPSHOT_TTL_MS + 1)).toEqual([]);
    expect(parseBacklogSnapshot(text, 999)).toEqual([]);
  });

  it.each([
    ['not JSON', '{oops'],
    ['a non-object', '42'],
    ['null', 'null'],
    ['an unknown version', JSON.stringify({ version: 2, savedAt: 0, items: [] })],
    ['no items array', JSON.stringify({ version: 1, savedAt: 0 })],
    ['no timestamp', JSON.stringify({ version: 1, items: [] })],
  ])('yields nothing for %s', (_label, text) => {
    expect(parseBacklogSnapshot(text, 0)).toEqual([]);
  });

  it('skips malformed entries but keeps the valid ones', () => {
    const valid = JSON.parse(serializeBacklogSnapshot([exchange({ id: 'ok' })], 0)) as { items: unknown[] };
    const text = JSON.stringify({ version: 1, savedAt: 0, items: [null, 'x', { id: 1 }, ...valid.items] });
    expect(parseBacklogSnapshot(text, 0).map((e) => e.id)).toEqual(['ok']);
  });

  it('skips an entry missing fields the dashboard dereferences, such as requestHeaders', () => {
    const [valid] = (JSON.parse(serializeBacklogSnapshot([exchange({ id: 'ok' })], 0)) as { items: object[] }).items;
    const headerless: Record<string, unknown> = { ...(valid as Record<string, unknown>), id: 'bad' };
    delete headerless.requestHeaders;
    const text = JSON.stringify({ version: 1, savedAt: 0, items: [headerless, valid] });
    expect(parseBacklogSnapshot(text, 0).map((e) => e.id)).toEqual(['ok']);
  });
});
