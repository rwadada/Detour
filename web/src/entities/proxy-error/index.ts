import { getDashboardConnection } from '@/shared/api';
import { createProxyErrorStore } from './model/createProxyErrorStore';

export { createProxyErrorStore, type ProxyErrorState } from './model/createProxyErrorStore';

/** The app's real proxy-error store, wired to the real dashboard connection. */
export const useProxyErrorStore = createProxyErrorStore(getDashboardConnection());
