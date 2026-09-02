import { describe, expect, it, vi } from 'vitest';
import { fakeDashboardConnection, type CapturedExchange, type DashboardServerMessage } from '@/shared/api';
import { DEFAULT_FILTERS, createExchangeStore, matchesFilters } from './createExchangeStore';

// `scheduleFlush` batches upserts via `requestAnimationFrame` — not
// available in vitest's `node` environment, and not something these tests
// care about timing-wise. Stubbed to capture the pending callback instead
// of scheduling one; `flushPendingFrame()` runs it on demand. (Calling it
// synchronously *inside* the stub would instead reorder `scheduleFlush`'s
// own `flushHandle = requestAnimationFrame(flush)` assignment to run
// *after* `flush()` already reset `flushHandle`, defeating its dedupe guard.)
let pendingFrame: FrameRequestCallback | undefined;
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  pendingFrame = cb;
  return 1;
});
function flushPendingFrame(): void {
  pendingFrame?.(0);
  pendingFrame = undefined;
}

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'x1',
    method: 'GET',
    url: 'https://example.com/',
    host: 'example.com',
    isSSL: true,
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 0,
    ...overrides,
  };
}

/** `fakeDashboardConnection`, plus flushing the batched-update animation frame after every message. */
function fakeConnection() {
  const fake = fakeDashboardConnection();
  return {
    connection: fake.connection,
    emit: (message: DashboardServerMessage) => {
      fake.emit(message);
      flushPendingFrame();
    },
  };
}

describe('createExchangeStore', () => {
  it('replaces exchanges wholesale on a backlog message', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);
    fake.emit({ type: 'backlog', items: [exchange({ id: 'a' }), exchange({ id: 'b' })] });
    expect(store.getState().exchanges.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('upserts request/response updates for the same id in place', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);
    fake.emit({ type: 'request', exchange: exchange({ id: 'a' }) });
    fake.emit({ type: 'response', exchange: exchange({ id: 'a', statusCode: 200 }) });
    expect(store.getState().exchanges).toHaveLength(1);
    expect(store.getState().exchanges[0]?.statusCode).toBe(200);
  });

  it('also upserts the exchange snapshot carried by a breakpoint message', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);
    fake.emit({
      type: 'breakpoint',
      exchange: exchange({ id: 'a', breakpoint: 'request' }),
      payload: { phase: 'request', id: 'a', method: 'GET', path: '/', headers: {}, bodyTruncated: false },
    });
    expect(store.getState().exchanges[0]?.breakpoint).toBe('request');
  });

  it('select()/setFilters() update local state', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);
    fake.emit({ type: 'backlog', items: [exchange({ id: 'a' })] });

    store.getState().select('a');
    store.getState().setFilters({ method: 'GET' });

    expect(store.getState().selectedId).toBe('a');
    expect(store.getState().filters).toEqual({ ...DEFAULT_FILTERS, method: 'GET' });
  });

  it('clear() empties exchanges and selection', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);
    fake.emit({ type: 'backlog', items: [exchange({ id: 'a' })] });
    store.getState().select('a');

    store.getState().clear();

    expect(store.getState().exchanges).toEqual([]);
    expect(store.getState().selectedId).toBeNull();
  });

  it('two store instances never share buffered state', () => {
    const fakeA = fakeConnection();
    const fakeB = fakeConnection();
    const storeA = createExchangeStore(fakeA.connection);
    const storeB = createExchangeStore(fakeB.connection);

    fakeA.emit({ type: 'request', exchange: exchange({ id: 'a' }) });

    expect(storeA.getState().exchanges.map((e) => e.id)).toEqual(['a']);
    expect(storeB.getState().exchanges).toEqual([]);
  });
});

describe('matchesFilters', () => {
  it('matches everything under the default (unfiltered) filters', () => {
    expect(matchesFilters(exchange(), DEFAULT_FILTERS)).toBe(true);
  });

  it('filters by exact HTTP method', () => {
    expect(matchesFilters(exchange({ method: 'POST' }), { ...DEFAULT_FILTERS, method: 'GET' })).toBe(false);
    expect(matchesFilters(exchange({ method: 'GET' }), { ...DEFAULT_FILTERS, method: 'GET' })).toBe(true);
  });

  it('filters by status class, matching "pending" against an in-flight exchange', () => {
    expect(matchesFilters(exchange({ statusCode: 404 }), { ...DEFAULT_FILTERS, status: '4xx' })).toBe(true);
    expect(matchesFilters(exchange({ statusCode: 200 }), { ...DEFAULT_FILTERS, status: '4xx' })).toBe(false);
    expect(matchesFilters(exchange(), { ...DEFAULT_FILTERS, status: 'pending' })).toBe(true);
  });

  it('filters by a case-insensitive URL substring', () => {
    const withUsers = exchange({ url: 'https://Example.com/Users' });
    const withOrders = exchange({ url: 'https://example.com/orders' });
    expect(matchesFilters(withUsers, { ...DEFAULT_FILTERS, query: 'users' })).toBe(true);
    expect(matchesFilters(withOrders, { ...DEFAULT_FILTERS, query: 'users' })).toBe(false);
  });
});
