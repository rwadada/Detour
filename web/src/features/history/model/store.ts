import { getDashboardConnection } from '@/shared/api';
import { createHistoryStore } from './createHistoryStore';

/** The app's real History feature store (issue #144), wired to the real dashboard connection (see shared/api/dashboardConnection.ts). */
export const useHistoryStore = createHistoryStore(getDashboardConnection());
