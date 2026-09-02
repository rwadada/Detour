import { connectDashboardSocket, type ConnectionStatus, type DashboardConnector } from './ws';
import type { DashboardClientMessage, DashboardServerMessage } from './protocol';

export type { ConnectionStatus } from './ws';

type MessageListener = (message: DashboardServerMessage) => void;
type StatusListener = (status: ConnectionStatus) => void;

/**
 * A shared, fan-out connection to the dashboard server. Every entity/
 * feature that cares about a slice of the live feed (exchanges,
 * breakpoints, intercept/focus/throttle state, proxy errors — all
 * multiplexed over the one WebSocket, see `ws.ts`) subscribes here
 * independently instead of each opening its own socket.
 */
export interface DashboardConnection {
  /** Subscribes to every incoming server message. Returns an unsubscribe function. */
  onMessage(listener: MessageListener): () => void;
  /** Subscribes to connection status changes, called immediately with the current status. Returns an unsubscribe function. */
  onStatusChange(listener: StatusListener): () => void;
  getStatus(): ConnectionStatus;
  send(message: DashboardClientMessage): void;
}

/**
 * Builds a `DashboardConnection`, taking the raw socket connector as a
 * parameter (defaulting to the real WebSocket-backed `connectDashboardSocket`)
 * instead of calling it directly — so a test can supply a fake connector
 * instead of opening a real WebSocket.
 *
 * Deliberately not called eagerly at this module's top level: doing so would
 * make merely *importing* this file open a real WebSocket connection as a
 * side effect. The app's actual singleton lives in `dashboardConnection.ts`,
 * which imports this factory.
 */
export function createDashboardConnection(connect: DashboardConnector = connectDashboardSocket): DashboardConnection {
  const messageListeners = new Set<MessageListener>();
  const statusListeners = new Set<StatusListener>();
  let status: ConnectionStatus = 'connecting';

  const socket = connect({
    onMessage: (message) => {
      for (const listener of messageListeners) listener(message);
    },
    onStatusChange: (next) => {
      status = next;
      for (const listener of statusListeners) listener(next);
    },
  });

  return {
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onStatusChange(listener) {
      statusListeners.add(listener);
      listener(status);
      return () => statusListeners.delete(listener);
    },
    getStatus: () => status,
    send: socket.send,
  };
}
