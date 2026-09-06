import { describe, expect, it, vi } from 'vitest';
import { fakeDashboardConnection, type CapturedExchange, type DashboardServerMessage } from '@/shared/api';
import { DEFAULT_FILTERS, createExchangeStore, isPassthroughDone, matchesFilters } from './createExchangeStore';

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
    protocol: 'HTTP/1.1',
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

  it('toggleCompare() adds and removes ids from the compare set', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);

    store.getState().toggleCompare('a');
    expect(store.getState().compareIds).toEqual(['a']);

    store.getState().toggleCompare('b');
    expect(store.getState().compareIds).toEqual(['a', 'b']);

    store.getState().toggleCompare('a');
    expect(store.getState().compareIds).toEqual(['b']);
  });

  it('toggleCompare() drops the oldest id once a 3rd is toggled on', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);

    store.getState().toggleCompare('a');
    store.getState().toggleCompare('b');
    store.getState().toggleCompare('c');

    expect(store.getState().compareIds).toEqual(['b', 'c']);
  });

  it('clearCompare() empties the compare set', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);
    store.getState().toggleCompare('a');

    store.getState().clearCompare();

    expect(store.getState().compareIds).toEqual([]);
  });

  it('clear() empties exchanges and selection', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);
    fake.emit({ type: 'backlog', items: [exchange({ id: 'a' })] });
    store.getState().select('a');
    store.getState().toggleCompare('a');

    store.getState().clear();

    expect(store.getState().exchanges).toEqual([]);
    expect(store.getState().selectedId).toBeNull();
    expect(store.getState().compareIds).toEqual([]);
  });

  it('importExchanges() switches to imported mode, showing the given exchanges', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);
    fake.emit({ type: 'backlog', items: [exchange({ id: 'live-1' })] });
    store.getState().select('live-1');

    store.getState().importExchanges([exchange({ id: 'imported-1' })], 'saved.har');

    expect(store.getState().exchanges.map((e) => e.id)).toEqual(['imported-1']);
    expect(store.getState().source).toBe('imported');
    expect(store.getState().importedFileName).toBe('saved.har');
    expect(store.getState().selectedId).toBeNull();
  });

  it('ignores live traffic pushed in while in imported mode, but keeps buffering it', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);
    store.getState().importExchanges([exchange({ id: 'imported-1' })], 'saved.har');

    fake.emit({ type: 'request', exchange: exchange({ id: 'live-1' }) });

    expect(store.getState().exchanges.map((e) => e.id)).toEqual(['imported-1']);
  });

  it('exitImport() restores whatever live traffic accumulated in the background', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);
    store.getState().importExchanges([exchange({ id: 'imported-1' })], 'saved.har');
    fake.emit({ type: 'request', exchange: exchange({ id: 'live-1' }) });

    store.getState().exitImport();

    expect(store.getState().exchanges.map((e) => e.id)).toEqual(['live-1']);
    expect(store.getState().source).toBe('live');
    expect(store.getState().importedFileName).toBeNull();
  });

  it('clear() also resets imported mode back to live', () => {
    const fake = fakeConnection();
    const store = createExchangeStore(fake.connection);
    store.getState().importExchanges([exchange({ id: 'imported-1' })], 'saved.har');

    store.getState().clear();

    expect(store.getState().exchanges).toEqual([]);
    expect(store.getState().source).toBe('live');
    expect(store.getState().importedFileName).toBeNull();
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

  describe('togglePause (issue #24)', () => {
    it('freezes `exchanges` while paused, even as new traffic arrives', () => {
      const fake = fakeConnection();
      const store = createExchangeStore(fake.connection);
      fake.emit({ type: 'request', exchange: exchange({ id: 'a' }) });

      store.getState().togglePause();
      fake.emit({ type: 'request', exchange: exchange({ id: 'b' }) });

      expect(store.getState().paused).toBe(true);
      expect(store.getState().exchanges.map((e) => e.id)).toEqual(['a']);
    });

    it('catches the view up to the buffer immediately on resume, without waiting for the next message', () => {
      const fake = fakeConnection();
      const store = createExchangeStore(fake.connection);
      fake.emit({ type: 'request', exchange: exchange({ id: 'a' }) });
      store.getState().togglePause();
      fake.emit({ type: 'request', exchange: exchange({ id: 'b' }) });
      expect(store.getState().exchanges.map((e) => e.id)).toEqual(['a']); // still frozen

      store.getState().togglePause();

      expect(store.getState().paused).toBe(false);
      expect(store.getState().exchanges.map((e) => e.id)).toEqual(['a', 'b']);
    });
  });
});

describe('isPassthroughDone', () => {
  it('is false for a non-passthrough exchange, even a finished one', () => {
    expect(isPassthroughDone(exchange({ statusCode: 200, finishedAt: 100 }))).toBe(false);
  });

  it('is false for a passthrough tunnel still open (no finishedAt yet)', () => {
    expect(isPassthroughDone(exchange({ passthrough: true }))).toBe(false);
  });

  it('is true for a passthrough tunnel that has closed', () => {
    expect(isPassthroughDone(exchange({ passthrough: true, finishedAt: 100 }))).toBe(true);
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

  it("matches a closed passthrough tunnel only under 'ALL' status — never 'pending' (it'll never get a statusCode) nor any concrete class (it never had one)", () => {
    const closedTunnel = exchange({ passthrough: true, finishedAt: 100 });
    expect(matchesFilters(closedTunnel, { ...DEFAULT_FILTERS, status: 'ALL' })).toBe(true);
    expect(matchesFilters(closedTunnel, { ...DEFAULT_FILTERS, status: 'pending' })).toBe(false);
    expect(matchesFilters(closedTunnel, { ...DEFAULT_FILTERS, status: '2xx' })).toBe(false);
  });

  it("matches a still-open passthrough tunnel under 'pending', same as any other in-flight exchange", () => {
    const openTunnel = exchange({ passthrough: true });
    expect(matchesFilters(openTunnel, { ...DEFAULT_FILTERS, status: 'pending' })).toBe(true);
  });

  it('filters by a case-insensitive URL substring', () => {
    const withUsers = exchange({ url: 'https://Example.com/Users' });
    const withOrders = exchange({ url: 'https://example.com/orders' });
    expect(matchesFilters(withUsers, { ...DEFAULT_FILTERS, query: 'users' })).toBe(true);
    expect(matchesFilters(withOrders, { ...DEFAULT_FILTERS, query: 'users' })).toBe(false);
  });
});
