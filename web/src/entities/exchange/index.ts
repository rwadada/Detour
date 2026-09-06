import { getDashboardConnection } from '@/shared/api';
import { createExchangeStore } from './model/createExchangeStore';

export {
  DEFAULT_FILTERS,
  createExchangeStore,
  isPassthroughDone,
  matchesFilters,
  type Filters,
  type ExchangeState,
} from './model/createExchangeStore';
export { BreakpointBadge, MethodBadge, ProtocolBadge, StatusBadge } from './ui/StatusBadge';
export { exchangesToHar, harToExchanges, parseImportedLog, type HarLog } from './lib/har';

/** The app's real exchange store, wired to the real dashboard connection (see shared/api/dashboardConnection.ts). */
export const useExchangeStore = createExchangeStore(getDashboardConnection());
