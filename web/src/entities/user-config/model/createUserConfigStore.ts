import { create } from 'zustand';
import type { DashboardConnection, UserConfigState } from '@/shared/api';

export interface UserConfigStoreState {
  /** Mirrors the server's `userConfig` message — `undefined` until the first one arrives right after connecting. */
  userConfig: UserConfigState | undefined;
  setUserConfig: (patch: Partial<UserConfigState>) => void;
  /** Sets (or, with `null`, clears) the dashboard password (issue #66) — a dedicated message rather than `setUserConfig`, since the server (not this store) is the one that hashes the plaintext before persisting it. */
  setDashboardPassword: (password: string | null) => void;
}

/**
 * Builds the persistent `detour start` defaults store (`defaultDetach`/
 * `lanAccess`, editable from the Settings panel's "Startup defaults"
 * section) — mirrors `~/.detour/config.json` via the `userConfig`/
 * `setUserConfig` messages (see `dashboardServer.ts`).
 *
 * Unlike `createInterceptStore`'s `InterceptState` etc. in `entities/
 * proxy-config`, this isn't live proxy behavior, which is why it's a
 * separate entity rather than folded in there: both fields only take
 * effect on the *next* `detour start`, never this running instance — see
 * `UserConfigState`'s doc comment on the backend for why (a process's
 * foreground/detached mode and a bound TCP server's address are both fixed
 * at spawn time).
 *
 * `connection` is a required parameter (no default) for the same reason as
 * `createInterceptStore`'s — importing this module must never have the side
 * effect of opening a real WebSocket.
 */
export function createUserConfigStore(connection: DashboardConnection) {
  return create<UserConfigStoreState>((set) => {
    connection.onMessage((message) => {
      if (message.type !== 'userConfig') return;
      set({ userConfig: message.state });
    });

    return {
      userConfig: undefined,
      setUserConfig: (patch) => connection.send({ type: 'setUserConfig', state: patch }),
      setDashboardPassword: (password) => connection.send({ type: 'setDashboardPassword', password }),
    };
  });
}
