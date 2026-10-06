import { create } from 'zustand';
import type { DashboardConnection } from '@/shared/api';

export interface AuthGateState {
  /**
   * `'unknown'` until the very first server message arrives (indistinguishable
   * from "unlocked" for rendering purposes — see `AuthGate`'s doc comment).
   * `'locked'` once an `authRequired`/`authFailed` message arrives — no other
   * message is ever sent to a socket in that state (see `dashboardServer.ts`'s
   * `authenticatedSockets` gating), so anything else flips this to
   * `'unlocked'` for good.
   */
  status: 'unknown' | 'locked' | 'unlocked';
  /** Set alongside `authFailed`; cleared on every other transition. */
  error: string | undefined;
  /**
   * What the server asked for (issue #205): a typed `password`, or the access
   * `token` that arrives in the URL of the first visit and cannot be typed
   * here. An older server's `authRequired` carries no method — it was always
   * the password.
   */
  method: 'password' | 'token';
  /** Submits a password in answer to `authRequired`/`authFailed` (issue #66). */
  login: (password: string) => void;
}

/**
 * Builds the optional dashboard-password gate's store (issue #66): mirrors
 * whether *this* connection needs (and has supplied) a password, entirely
 * from the message stream — there's no dedicated request/response round
 * trip, just watching for `authRequired`/`authFailed` versus literally any
 * other message type (which the server only ever sends once authenticated).
 *
 * `connection` is a required parameter (no default) for the same reason as
 * `createProxyInfoStore`'s — importing this module must never have the side
 * effect of opening a real WebSocket. The real singleton is wired in
 * `ui/AuthGate.tsx`, its only consumer.
 */
export function createAuthGateStore(connection: DashboardConnection) {
  return create<AuthGateState>((set) => {
    connection.onMessage((message) => {
      if (message.type === 'authRequired') {
        set({ status: 'locked', error: undefined, method: message.method ?? 'password' });
      } else if (message.type === 'authFailed') set({ status: 'locked', error: 'Incorrect password' });
      else set({ status: 'unlocked', error: undefined });
    });

    return {
      status: 'unknown',
      error: undefined,
      method: 'password',
      login: (password) => connection.send({ type: 'login', password }),
    };
  });
}
