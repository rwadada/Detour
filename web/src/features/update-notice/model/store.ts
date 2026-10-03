import { getDashboardConnection } from '@/shared/api';
import { createUpdateStore } from './createUpdateStore';

/** The app's real update-notice store, wired to the real dashboard connection (see shared/api/dashboardConnection.ts). */
export const useUpdateStore = createUpdateStore(getDashboardConnection());
