import { getDashboardConnection } from '@/shared/api';
import { createBlockHostsStore } from './model/createBlockHostsStore';
import { createFocusStore } from './model/createFocusStore';
import { createInterceptStore } from './model/createInterceptStore';
import { createThrottleStore } from './model/createThrottleStore';

export {
  createBlockHostsStore,
  DEFAULT_BLOCK_HOSTS_STATE,
  type BlockHostsStoreState,
} from './model/createBlockHostsStore';
export { createFocusStore, type FocusStoreState } from './model/createFocusStore';
export { createInterceptStore, type InterceptState } from './model/createInterceptStore';
export { createThrottleStore, DEFAULT_THROTTLE_STATE, type ThrottleStoreState } from './model/createThrottleStore';
export { PRESETS, presetFor, type PresetKey } from './model/presets';
export { ThrottleFields } from './ui/ThrottleFields';

/**
 * The live proxy configuration entity (issue #24): Intercept/Focus/
 * Throttle/Block Hosts state, each mirroring the same-named `Dashboard-
 * ServerMessage` from the server. Consolidated here — rather than living
 * inside `features/intercept-toggle` etc. as before — because it's genuine
 * domain state read by more than one feature (each toggle's own toolbar
 * control, plus `features/session` and `features/settings-panel`), and FSD
 * forbids feature→feature imports; entities are the layer every feature
 * above is allowed to share.
 */
export const useInterceptStore = createInterceptStore(getDashboardConnection());
export const useFocusStore = createFocusStore(getDashboardConnection());
export const useThrottleStore = createThrottleStore(getDashboardConnection());
export const useBlockHostsStore = createBlockHostsStore(getDashboardConnection());
