import { create } from 'zustand';
import { RingBuffer } from '@/lib/ringBuffer';
import { connectDashboardSocket, type ConnectionStatus, type DashboardConnector } from '@/lib/ws';
import type {
  BreakpointPayload,
  BreakpointRequestEdits,
  BreakpointResponseEdits,
  CapturedExchange,
  ProxyErrorEvent,
  ThrottleState,
} from '@/types';

/** Throttle's true no-op default (see `src/types.ts`'s `ThrottleState`) — used until the server's own `throttle` message arrives. */
export const DEFAULT_THROTTLE_STATE: ThrottleState = {
  enabled: false,
  downKbps: 0,
  upKbps: 0,
  latencyMs: 0,
  packetLossPct: 0,
};

/** Bounds memory: with `MAX_ERRORS` and a ~1KB average exchange, this store's array itself never exceeds a few MB regardless of session length. */
const MAX_EXCHANGES = 5000;
const MAX_ERRORS = 200;

export interface Filters {
  /** 'ALL' or an exact HTTP method. */
  method: string;
  /** 'ALL', 'pending', or a status class: '2xx' | '3xx' | '4xx' | '5xx'. */
  status: string;
  /** Case-insensitive substring match against the exchange URL. */
  query: string;
}

export const DEFAULT_FILTERS: Filters = { method: 'ALL', status: 'ALL', query: '' };

interface LogStoreState {
  exchanges: CapturedExchange[];
  selectedId: string | null;
  connectionStatus: ConnectionStatus;
  filters: Filters;
  errors: ProxyErrorEvent[];
  /** Exchanges currently paused by a `breakpoint` rule, keyed by exchange id — awaiting resume/abort from this (or any other connected) dashboard tab. */
  pausedBreakpoints: Record<string, BreakpointPayload>;
  /** Whether the proxy is actively intercepting traffic (see `src/types.ts`'s `InterceptState`). Defaults to `true` until the server's own `intercept` message arrives. */
  interceptEnabled: boolean;
  /** The "Focus" host allowlist (see `src/types.ts`'s `FocusState`). Empty means unrestricted — every host is intercepted. */
  focusHosts: string[];
  /** The "Throttle" network-simulation profile (see `src/types.ts`'s `ThrottleState`). Defaults to `DEFAULT_THROTTLE_STATE` until the server's own `throttle` message arrives. */
  throttle: ThrottleState;

  select: (id: string | null) => void;
  setFilters: (patch: Partial<Filters>) => void;
  clear: () => void;
  /** Resumes a paused request, optionally with edits. Omit `edits` to forward it unchanged. */
  resumeBreakpointRequest: (id: string, edits?: BreakpointRequestEdits) => void;
  /** Resumes a paused response, optionally with edits. Omit `edits` to return it unchanged. */
  resumeBreakpointResponse: (id: string, edits?: BreakpointResponseEdits) => void;
  /** Aborts a paused exchange instead of letting it continue. */
  abortBreakpoint: (id: string, phase: 'request' | 'response') => void;
  /** Turns interception on/off. */
  setIntercept: (enabled: boolean) => void;
  /** Replaces the Focus host allowlist wholesale. Pass an empty array to intercept every host again. */
  setFocus: (hosts: string[]) => void;
  /** Replaces the Throttle profile wholesale. Pass `{ ...DEFAULT_THROTTLE_STATE }` (or `enabled: false`) to turn it off. */
  setThrottle: (state: ThrottleState) => void;
}

const buffer = new RingBuffer<CapturedExchange>(MAX_EXCHANGES, (item) => item.id);

// Incoming WS messages can arrive far faster than React should re-render
// (a busy proxy can easily push hundreds of exchanges/sec). Rather than
// calling `set()` per message, updates are queued here and flushed at most
// once per animation frame — one re-render covers however many messages
// arrived in that ~16ms window instead of one per message.
let pendingUpserts: CapturedExchange[] = [];
let flushHandle: number | undefined;

/**
 * Builds the log store, taking the dashboard connection as a parameter
 * (defaulting to the real WebSocket-backed `connectDashboardSocket`) instead
 * of calling it directly — so a test can supply a fake connector (capturing
 * `onMessage`/`onStatusChange` to drive by hand, and a `send` spy to assert
 * on) rather than standing up a real WebSocket.
 *
 * Deliberately not called eagerly at this module's top level: doing so would
 * make merely *importing* this file (e.g. to reuse `matchesFilters` from a
 * test) open a real WebSocket connection as a side effect. The app's actual
 * singleton — built with the real connector — lives in `useLogStore.ts`,
 * which imports this factory.
 */
export function createLogStore(connect: DashboardConnector = connectDashboardSocket) {
  return create<LogStoreState>((set) => {
    const flush = () => {
      flushHandle = undefined;
      if (pendingUpserts.length === 0) return;
      for (const item of pendingUpserts) buffer.upsert(item);
      pendingUpserts = [];
      set({ exchanges: buffer.toArray() });
    };

    const scheduleFlush = () => {
      if (flushHandle === undefined) flushHandle = requestAnimationFrame(flush);
    };

    const socket = connect({
      onStatusChange: (status) => set({ connectionStatus: status }),
      onMessage: (message) => {
        switch (message.type) {
          case 'backlog':
            buffer.clear();
            for (const item of message.items) buffer.upsert(item);
            pendingUpserts = [];
            set({ exchanges: buffer.toArray() });
            return;
          case 'request':
          case 'response':
            pendingUpserts.push(message.exchange);
            scheduleFlush();
            // A `request`/`response` update for an id that was paused means
            // it just resumed (or was aborted) — from this tab or another —
            // so it's no longer awaiting an editor here.
            set((state) => {
              if (!(message.exchange.id in state.pausedBreakpoints)) return state;
              const pausedBreakpoints = { ...state.pausedBreakpoints };
              delete pausedBreakpoints[message.exchange.id];
              return { pausedBreakpoints };
            });
            return;
          case 'error':
            set((state) => ({ errors: [message.event, ...state.errors].slice(0, MAX_ERRORS) }));
            return;
          case 'breakpoint':
            pendingUpserts.push(message.exchange);
            scheduleFlush();
            set((state) => ({
              pausedBreakpoints: { ...state.pausedBreakpoints, [message.payload.id]: message.payload },
            }));
            return;
          case 'intercept':
            set({ interceptEnabled: message.state.enabled });
            return;
          case 'focus':
            set({ focusHosts: message.state.hosts });
            return;
          case 'throttle':
            set({ throttle: message.state });
            return;
        }
      },
    });

    return {
      exchanges: [],
      selectedId: null,
      connectionStatus: 'connecting',
      filters: DEFAULT_FILTERS,
      errors: [],
      pausedBreakpoints: {},
      interceptEnabled: true,
      focusHosts: [],
      throttle: DEFAULT_THROTTLE_STATE,

      select: (id) => set({ selectedId: id }),
      setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
      clear: () => {
        buffer.clear();
        pendingUpserts = [];
        set({ exchanges: [], selectedId: null, errors: [] });
        // Deliberately not touched: entries in `pausedBreakpoints` reflect
        // exchanges genuinely still paused server-side — clearing the log
        // table shouldn't hide them, or there'd be no way left to resume them.
      },
      resumeBreakpointRequest: (id, edits) =>
        socket.send({ type: 'breakpointResume', command: { id, phase: 'request', action: 'resume', edits } }),
      resumeBreakpointResponse: (id, edits) =>
        socket.send({ type: 'breakpointResume', command: { id, phase: 'response', action: 'resume', edits } }),
      abortBreakpoint: (id, phase) =>
        socket.send({ type: 'breakpointResume', command: { id, phase, action: 'abort' } }),
      setIntercept: (enabled) => socket.send({ type: 'setIntercept', enabled }),
      setFocus: (hosts) => socket.send({ type: 'setFocus', hosts }),
      setThrottle: (state) => socket.send({ type: 'setThrottle', state }),
    };
  });
}

function statusClass(status?: number): string {
  if (status === undefined) return 'pending';
  return `${Math.floor(status / 100)}xx`;
}

export function matchesFilters(exchange: CapturedExchange, filters: Filters): boolean {
  if (filters.method !== 'ALL' && exchange.method !== filters.method) return false;
  if (filters.status !== 'ALL' && statusClass(exchange.statusCode) !== filters.status) return false;
  if (filters.query && !exchange.url.toLowerCase().includes(filters.query.toLowerCase())) return false;
  return true;
}
