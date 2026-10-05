import { getDashboardConnection } from '@/shared/api';
import { createProxyInfoStore } from './createProxyInfoStore';

/** The app's real proxy-info store, wired to the real dashboard connection. Lives in its own module (rather than only in the entity's `index.ts`) so this entity's own UI can read it without a circular import. */
export const useProxyInfoStore = createProxyInfoStore(getDashboardConnection());
