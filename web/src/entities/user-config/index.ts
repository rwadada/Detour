import { getDashboardConnection } from '@/shared/api';
import { createUserConfigStore } from './model/createUserConfigStore';

export { createUserConfigStore, type UserConfigStoreState } from './model/createUserConfigStore';

/**
 * The persistent `detour start` defaults entity (`defaultDetach`/
 * `lanAccess`) — see `createUserConfigStore`'s doc comment for why this is
 * its own entity rather than living inside `entities/proxy-config`.
 */
export const useUserConfigStore = createUserConfigStore(getDashboardConnection());
