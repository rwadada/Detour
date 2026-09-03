import { getDashboardConnection } from '@/shared/api';
import { createReplayStore } from './createReplayStore';

/** The app's real replay store, wired to the real dashboard connection (see shared/api/dashboardConnection.ts). */
export const useReplayStore = createReplayStore(getDashboardConnection());
