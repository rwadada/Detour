import { useSyncExternalStore } from 'react';
import type { ConnectionStatus } from './createDashboardConnection';
import { getDashboardConnection } from './dashboardConnection';

/** The current WebSocket connection status to the dashboard server, kept in sync via `DashboardConnection.onStatusChange`. */
export function useConnectionStatus(): ConnectionStatus {
  const connection = getDashboardConnection();
  return useSyncExternalStore(
    (onChange) => connection.onStatusChange(() => onChange()),
    () => connection.getStatus(),
  );
}
