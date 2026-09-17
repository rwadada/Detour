import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import type { CapturedExchange } from '@/shared/api';
import { createHistoryStore } from './createHistoryStore';

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'ex-1',
    method: 'GET',
    url: 'https://api.example.com/users',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 1000,
    statusCode: 200,
    ...overrides,
  };
}

describe('createHistoryStore', () => {
  it('starts disabled before any historyStatus message arrives', () => {
    const fake = fakeDashboardConnection();
    const store = createHistoryStore(fake.connection);
    expect(store.getState().enabled).toBe(false);
  });

  it('reflects historyStatus', () => {
    const fake = fakeDashboardConnection();
    const store = createHistoryStore(fake.connection);
    fake.emit({ type: 'historyStatus', enabled: true });
    expect(store.getState().enabled).toBe(true);
  });

  it('search() sends queryHistory with the current filters and no `before`, and sets loading', () => {
    const fake = fakeDashboardConnection();
    const store = createHistoryStore(fake.connection);
    store.getState().setFilters({ method: 'POST' });
    store.getState().search();

    expect(fake.sent).toHaveLength(1);
    const sent = fake.sent[0] as { type: string; requestId: string; query: Record<string, unknown> };
    expect(sent.type).toBe('queryHistory');
    expect(sent.query).toMatchObject({ method: 'POST', limit: 100 });
    expect(sent.query.before).toBeUndefined();
    expect(store.getState().loading).toBe(true);
  });

  it('replaces items on a search() result matching the latest requestId, and clears loading', () => {
    const fake = fakeDashboardConnection();
    const store = createHistoryStore(fake.connection);
    store.getState().search();
    const requestId = (fake.sent[0] as { requestId: string }).requestId;

    fake.emit({ type: 'historyResult', requestId, items: [exchange()], hasMore: true });

    expect(store.getState().items).toEqual([exchange()]);
    expect(store.getState().hasMore).toBe(true);
    expect(store.getState().loading).toBe(false);
  });

  it('ignores a historyResult for a superseded (stale) requestId', () => {
    const fake = fakeDashboardConnection();
    const store = createHistoryStore(fake.connection);
    store.getState().search();
    const staleRequestId = (fake.sent[0] as { requestId: string }).requestId;
    store.getState().search(); // supersedes the first request

    fake.emit({ type: 'historyResult', requestId: staleRequestId, items: [exchange()], hasMore: false });

    expect(store.getState().items).toEqual([]);
  });

  it("loadMore() sends `before` set to the current items' oldest startedAt, and appends its result", () => {
    const fake = fakeDashboardConnection();
    const store = createHistoryStore(fake.connection);
    store.getState().search();
    const firstRequestId = (fake.sent[0] as { requestId: string }).requestId;
    fake.emit({
      type: 'historyResult',
      requestId: firstRequestId,
      items: [exchange({ id: 'a', startedAt: 2000 })],
      hasMore: true,
    });

    store.getState().loadMore();
    const secondSent = fake.sent[1] as { requestId: string; query: { before?: number } };
    expect(secondSent.query.before).toBe(2000);

    fake.emit({
      type: 'historyResult',
      requestId: secondSent.requestId,
      items: [exchange({ id: 'b', startedAt: 1000 })],
      hasMore: false,
    });
    expect(store.getState().items.map((e) => e.id)).toEqual(['a', 'b']);
    expect(store.getState().hasMore).toBe(false);
  });

  it('reset() clears items/hasMore/loading', () => {
    const fake = fakeDashboardConnection();
    const store = createHistoryStore(fake.connection);
    store.getState().search();
    const requestId = (fake.sent[0] as { requestId: string }).requestId;
    fake.emit({ type: 'historyResult', requestId, items: [exchange()], hasMore: true });

    store.getState().reset();

    expect(store.getState().items).toEqual([]);
    expect(store.getState().hasMore).toBe(false);
    expect(store.getState().loading).toBe(false);
  });

  it('setFilters merges into the existing filters rather than replacing them', () => {
    const fake = fakeDashboardConnection();
    const store = createHistoryStore(fake.connection);
    store.getState().setFilters({ method: 'GET' });
    store.getState().setFilters({ host: 'api.example.com' });
    expect(store.getState().filters).toEqual({ method: 'GET', host: 'api.example.com' });
  });
});
