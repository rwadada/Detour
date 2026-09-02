import { getDashboardConnection } from '@/shared/api';
import { createBlockHostsStore } from './createBlockHostsStore';

/** The app's real Block Hosts store, wired to the real dashboard connection. */
export const useBlockHostsStore = createBlockHostsStore(getDashboardConnection());
