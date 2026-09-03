import { getDashboardConnection } from '@/shared/api';
import { createRuleStore } from './createRuleStore';

/** The app's real rule store, wired to the real dashboard connection (see shared/api/dashboardConnection.ts). */
export const useRuleStore = createRuleStore(getDashboardConnection());
