import { getDashboardConnection } from '@/shared/api';
import { createBlockHostsStore } from './model/createBlockHostsStore';
import { createFocusStore } from './model/createFocusStore';
import { createInterceptStore } from './model/createInterceptStore';
import { createProxyInfoStore } from './model/createProxyInfoStore';
import { createThrottleStore } from './model/createThrottleStore';

export {
  createBlockHostsStore,
  DEFAULT_BLOCK_HOSTS_STATE,
  type BlockHostsStoreState,
} from './model/createBlockHostsStore';
export { createFocusStore, type FocusStoreState } from './model/createFocusStore';
export { createInterceptStore, type InterceptState } from './model/createInterceptStore';
export { createProxyInfoStore, resolveDashboardOnLan, type ProxyInfoState } from './model/createProxyInfoStore';
export { createThrottleStore, DEFAULT_THROTTLE_STATE, type ThrottleStoreState } from './model/createThrottleStore';
export { PRESETS, presetFor, type PresetKey } from './model/presets';
export { ThrottleFields } from './ui/ThrottleFields';

/**
 * The live proxy configuration entity (issue #24): Intercept/Focus/
 * Throttle/Block Hosts/proxy-info state, each mirroring the same-named
 * `DashboardServerMessage` from the server. Consolidated here — rather
 * than living inside `features/intercept-toggle` etc. as before — because
 * it's genuine domain state read by more than one feature/widget (each
 * toggle's own toolbar control, plus `features/session`/`features/
 * settings-panel`, and — for `useProxyInfoStore` specifically — both
 * `widgets/sidebar` and `widgets/context-bar`), and FSD forbids feature→
 * feature and widget→widget imports; entities are the layer everything
 * above is allowed to share.
 */
export const useInterceptStore = createInterceptStore(getDashboardConnection());
export const useFocusStore = createFocusStore(getDashboardConnection());
export const useThrottleStore = createThrottleStore(getDashboardConnection());
export const useBlockHostsStore = createBlockHostsStore(getDashboardConnection());
export const useProxyInfoStore = createProxyInfoStore(getDashboardConnection());
