import { getDashboardConnection } from '@/shared/api';
import { createFocusStore } from './createFocusStore';

/** The app's real Focus store, wired to the real dashboard connection. */
export const useFocusStore = createFocusStore(getDashboardConnection());
