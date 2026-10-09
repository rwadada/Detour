import { getDashboardConnection } from '@/shared/api';
import { createAdbReverseStore } from './createAdbReverseStore';

/** The app's real adb-reverse store, wired to the real dashboard connection (see shared/api/dashboardConnection.ts). */
export const useAdbReverseStore = createAdbReverseStore(getDashboardConnection());
