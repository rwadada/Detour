import { getDashboardConnection } from '@/shared/api';
import { createInterceptStore } from './createInterceptStore';

/** The app's real Intercept store, wired to the real dashboard connection. */
export const useInterceptStore = createInterceptStore(getDashboardConnection());
