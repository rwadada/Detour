import { createDashboardConnection, type DashboardConnection } from './createDashboardConnection';

let instance: DashboardConnection | undefined;

/**
 * The app's one real connection to the dashboard server, constructed
 * lazily on first call rather than eagerly at module scope — so merely
 * *importing* this module, or the `shared/api` barrel that re-exports it
 * (as every entity/feature's public API does, transitively, per FSD's
 * public-API rule), never has the side effect of opening a real WebSocket.
 * Every entity/feature store's `model/store.ts` calls this (not
 * `createDashboardConnection` — that's for tests) to get the real
 * connection; repeated calls return the same instance.
 */
export function getDashboardConnection(): DashboardConnection {
  if (!instance) instance = createDashboardConnection();
  return instance;
}
