import { getDashboardConnection } from '@/shared/api';
import { createThrottleStore } from './createThrottleStore';

/** The app's real Throttle store, wired to the real dashboard connection. */
export const useThrottleStore = createThrottleStore(getDashboardConnection());
