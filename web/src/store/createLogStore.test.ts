import { describe, expect, it, vi } from 'vitest';
import type { DashboardConnector, DashboardSocketHandlers } from '@/lib/ws';
import type { CapturedExchange, DashboardClientMessage } from '@/types';
import { DEFAULT_FILTERS, DEFAULT_THROTTLE_STATE, createLogStore, matchesFilters } from './createLogStore';

// The store batches request/response/breakpoint updates via
// `requestAnimationFrame` (see createLogStore.ts's `scheduleFlush`) — not
// available in vitest's `node` environment, and not something these tests
// care about timing-wise. Stubbed to capture the pending callback instead of
// actually scheduling one; `fakeConnector().emit` below runs it right after
// each message, synchronously — calling it eagerly *inside* the stub (i.e.
// making requestAnimationFrame itself synchronous) would instead reorder
// `scheduleFlush`'s own `flushHandle = requestAnimationFrame(flush)`
// assignment to run *after* `flush()` already reset `flushHandle` to
// `undefined`, defeating its dedupe guard.
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

/**
 * A fake `DashboardConnector` that captures the handlers the store registers
 * (so a test can drive them by hand, simulating server messages/status
 * changes) and records every `send` call — instead of opening a real
 * WebSocket, per `createLogStore`'s injectable-connector design.
 */
function fakeConnector() {
  const sent: DashboardClientMessage[] = [];
  let handlers: DashboardSocketHandlers | undefined;
  const connect: DashboardConnector = (h) => {
    handlers = h;
    return { close: vi.fn(), send: (message) => sent.push(message) };
  };
  return {
    connect,
    sent,
    emit: (message: Parameters<DashboardSocketHandlers['onMessage']>[0]) => {
      handlers?.onMessage(message);
      // Messages that batch through `scheduleFlush` (request/response/
      // breakpoint) only apply to `exchanges` once their animation frame
      // runs — flush it immediately so a test can assert right after
      // `emit()` without needing to know which message types batch and
      // which apply synchronously.
      flushPendingFrame();
    },
    setStatus: (status: Parameters<DashboardSocketHandlers['onStatusChange']>[0]) => handlers?.onStatusChange(status),
  };
}

/**
 * `buffer`/`pendingUpserts` in useLogStore.ts are module-level singletons
 * shared by every `createLogStore()` call (the real app only ever creates
 * one, via `useLogStore`) — `clear()` resets both, so each test starts from
 * a clean slate regardless of what an earlier test's store instance left
 * behind.
 */
function setupStore() {
  const fake = fakeConnector();
  const store = createLogStore(fake.connect);
  store.getState().clear();
  return { store, fake };
}

describe('createLogStore', () => {
  it('starts "connecting" and reflects status changes from the connector', () => {
    const { store, fake } = setupStore();
    expect(store.getState().connectionStatus).toBe('connecting');
    fake.setStatus('open');
    expect(store.getState().connectionStatus).toBe('open');
    fake.setStatus('closed');
    expect(store.getState().connectionStatus).toBe('closed');
  });

  it('replaces exchanges wholesale on a backlog message', () => {
    const { store, fake } = setupStore();
    fake.emit({ type: 'backlog', items: [exchange({ id: 'a' }), exchange({ id: 'b' })] });
    expect(store.getState().exchanges.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('upserts request/response updates for the same id in place', () => {
    const { store, fake } = setupStore();
    fake.emit({ type: 'request', exchange: exchange({ id: 'a' }) });
    fake.emit({ type: 'response', exchange: exchange({ id: 'a', statusCode: 200 }) });
    expect(store.getState().exchanges).toHaveLength(1);
    expect(store.getState().exchanges[0]?.statusCode).toBe(200);
  });

  it('tracks a breakpoint-paused exchange, clearing it once resumed/aborted', () => {
    const { store, fake } = setupStore();
    const payload = { phase: 'request' as const, id: 'a', method: 'GET', path: '/', headers: {}, bodyTruncated: false };
    fake.emit({ type: 'breakpoint', exchange: exchange({ id: 'a', breakpoint: 'request' }), payload });
    expect(store.getState().pausedBreakpoints['a']).toEqual(payload);

    // A `request`/`response` update for the same id means it just resumed
    // (or was aborted) — from this tab or another.
    fake.emit({ type: 'request', exchange: exchange({ id: 'a' }) });
    expect(store.getState().pausedBreakpoints['a']).toBeUndefined();
  });

  it('caps stored errors at MAX_ERRORS, newest first', () => {
    const { store, fake } = setupStore();
    fake.emit({ type: 'error', event: { errorKind: 'A', message: 'first' } });
    fake.emit({ type: 'error', event: { errorKind: 'B', message: 'second' } });
    expect(store.getState().errors.map((e) => e.message)).toEqual(['second', 'first']);
  });

  it('mirrors intercept/focus/throttle state pushed from the server', () => {
    const { store, fake } = setupStore();
    fake.emit({ type: 'intercept', state: { enabled: false } });
    fake.emit({ type: 'focus', state: { hosts: ['example.com'] } });
    const throttle = { enabled: true, downKbps: 100, upKbps: 50, latencyMs: 10, packetLossPct: 0 };
    fake.emit({ type: 'throttle', state: throttle });

    expect(store.getState().interceptEnabled).toBe(false);
    expect(store.getState().focusHosts).toEqual(['example.com']);
    expect(store.getState().throttle).toEqual(throttle);
  });

  it('sends the expected wire message for each server-bound action', () => {
    const { store, fake } = setupStore();
    store.getState().setIntercept(false);
    store.getState().setFocus(['a.com']);
    store.getState().setThrottle(DEFAULT_THROTTLE_STATE);
    store.getState().resumeBreakpointRequest('a', { method: 'POST' });
    store.getState().resumeBreakpointResponse('a', { status: 204 });
    store.getState().abortBreakpoint('a', 'response');

    expect(fake.sent).toEqual([
      { type: 'setIntercept', enabled: false },
      { type: 'setFocus', hosts: ['a.com'] },
      { type: 'setThrottle', state: DEFAULT_THROTTLE_STATE },
      { type: 'breakpointResume', command: { id: 'a', phase: 'request', action: 'resume', edits: { method: 'POST' } } },
      { type: 'breakpointResume', command: { id: 'a', phase: 'response', action: 'resume', edits: { status: 204 } } },
      { type: 'breakpointResume', command: { id: 'a', phase: 'response', action: 'abort' } },
    ]);
  });

  it('select()/setFilters() update local state without sending anything to the server', () => {
    const { store, fake } = setupStore();
    fake.emit({ type: 'backlog', items: [exchange({ id: 'a' })] });

    store.getState().select('a');
    store.getState().setFilters({ method: 'GET' });

    expect(store.getState().selectedId).toBe('a');
    expect(store.getState().filters).toEqual({ ...DEFAULT_FILTERS, method: 'GET' });
    expect(fake.sent).toEqual([]);
  });

  it('clear() empties exchanges/selection/errors, but leaves paused breakpoints untouched', () => {
    const { store, fake } = setupStore();
    const payload = { phase: 'request' as const, id: 'p', method: 'GET', path: '/', headers: {}, bodyTruncated: false };
    fake.emit({ type: 'backlog', items: [exchange({ id: 'a' })] });
    fake.emit({ type: 'error', event: { errorKind: 'A', message: 'boom' } });
    fake.emit({ type: 'breakpoint', exchange: exchange({ id: 'p', breakpoint: 'request' }), payload });
    store.getState().select('a');

    store.getState().clear();

    expect(store.getState().exchanges).toEqual([]);
    expect(store.getState().selectedId).toBeNull();
    expect(store.getState().errors).toEqual([]);
    // Still genuinely paused server-side — clearing the log table shouldn't
    // hide it, or there'd be no way left to resume it.
    expect(store.getState().pausedBreakpoints['p']).toEqual(payload);
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
