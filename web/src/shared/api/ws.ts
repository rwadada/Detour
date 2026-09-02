import type { DashboardClientMessage, DashboardServerMessage } from './protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface DashboardSocketHandlers {
  onMessage: (message: DashboardServerMessage) => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

export interface DashboardSocketHandle {
  /** Tears the connection down and stops reconnecting. */
  close: () => void;
  /** Sends a message to the dashboard server, if currently connected (silently dropped otherwise — resuming a breakpoint while disconnected has nothing to resume anyway). */
  send: (message: DashboardClientMessage) => void;
}

const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8000;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * Shape of `connectDashboardSocket` — the one dependency `useLogStore`
 * (see store/useLogStore.ts) has on an actual network connection. Kept as a
 * named type so the store can take it as an injectable parameter (defaulting
 * to the real WebSocket-backed implementation below) rather than importing
 * and calling it directly, so tests can supply a fake connection instead of
 * standing up a real WebSocket.
 */
export type DashboardConnector = (handlers: DashboardSocketHandlers) => DashboardSocketHandle;

/**
 * Connects to the dashboard server's live feed, reconnecting with
 * exponential backoff if the connection drops (the proxy process restarting,
 * a laptop waking from sleep, etc). Returns a handle to tear the connection
 * down and to send messages back (e.g. resuming a paused breakpoint).
 */
export const connectDashboardSocket: DashboardConnector = (handlers) => {
  let socket: WebSocket | undefined;
  let retryDelay = INITIAL_RETRY_DELAY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    handlers.onStatusChange('connecting');
    socket = new WebSocket(wsUrl());

    socket.onopen = () => {
      retryDelay = INITIAL_RETRY_DELAY_MS;
      handlers.onStatusChange('open');
    };

    socket.onmessage = (event) => {
      try {
        handlers.onMessage(JSON.parse(event.data as string) as DashboardServerMessage);
      } catch {
        // Ignore malformed frames rather than crashing the dashboard.
      }
    };

    socket.onclose = () => {
      handlers.onStatusChange('closed');
      if (stopped) return;
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    };

    socket.onerror = () => {
      socket?.close();
    };
  };

  connect();

  return {
    close: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    },
    send: (message) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
  };
};
