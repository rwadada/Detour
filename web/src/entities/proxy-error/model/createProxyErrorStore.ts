import { create } from 'zustand';
import type { DashboardConnection, ProxyErrorEvent } from '@/shared/api';

/** Bounds memory: with `MAX_ERRORS` and a small average event size, this store's array never grows meaningfully. */
const MAX_ERRORS = 200;

export interface ProxyErrorState {
  errors: ProxyErrorEvent[];
}

/**
 * Builds the proxy-error entity's store: proxy-level errors (connection
 * resets, TLS failures, rules.json reload failures, etc), newest first.
 *
 * `connection` is a required parameter (no default) precisely so importing
 * this module never has the side effect of opening a real WebSocket — see
 * `entities/proxy-error/index.ts`, which wires the app's real singleton.
 */
export function createProxyErrorStore(connection: DashboardConnection) {
  return create<ProxyErrorState>((set) => {
    connection.onMessage((message) => {
      if (message.type !== 'error') return;
      set((state) => ({ errors: [message.event, ...state.errors].slice(0, MAX_ERRORS) }));
    });

    return { errors: [] };
  });
}
