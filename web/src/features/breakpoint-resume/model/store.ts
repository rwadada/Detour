import { getDashboardConnection } from '@/shared/api';
import { createBreakpointResumeStore } from './createBreakpointResumeStore';

/** The app's real breakpoint-resume store, wired to the real dashboard connection. */
export const useBreakpointResumeStore = createBreakpointResumeStore(getDashboardConnection());
