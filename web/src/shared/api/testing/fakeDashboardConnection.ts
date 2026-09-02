import type { DashboardConnection } from '../createDashboardConnection';
import type { DashboardServerMessage } from '../protocol';

/**
 * A fake `DashboardConnection` a test can drive by hand — no real socket.
 * Message delivery to subscribers is synchronous; if the code under test
 * schedules its own work off a message (e.g. via `requestAnimationFrame`),
 * flush that separately after `emit()`.
 */
export function fakeDashboardConnection() {
  const messageListeners = new Set<(message: DashboardServerMessage) => void>();
  const sent: unknown[] = [];
  const connection: DashboardConnection = {
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onStatusChange: () => () => {},
    getStatus: () => 'open',
    send: (message) => sent.push(message),
  };
  return {
    connection,
    sent,
    emit: (message: DashboardServerMessage) => {
      for (const listener of messageListeners) listener(message);
    },
  };
}
