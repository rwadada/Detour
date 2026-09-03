import { create } from 'zustand';
import { getDashboardConnection, type DashboardConnection } from '@/shared/api';

export interface ProxyInfoState {
  /** The proxy's port, or null until the `proxyInfo` message arrives (issue #24's sidebar Proxy URL / QR code). Null on an older server build that predates this message, too — the sidebar falls back to hiding the Proxy URL rather than guessing. */
  proxyPort: number | null;
}

/**
 * Builds a store holding just the proxy's port, sent once by the dashboard
 * server right after connecting (issue #24). Lives under `widgets/sidebar`
 * rather than as its own `entities` slice — Sidebar is currently its only
 * consumer, and FSD's steiger linter (`fsd/insignificant-slice`) flags a
 * one-consumer entity as better merged into that consumer.
 *
 * `connection` is a required parameter (no default) precisely so importing
 * this module never has the side effect of opening a real WebSocket — see
 * `ui/Sidebar.tsx`, which wires the app's real singleton.
 */
export function createProxyInfoStore(connection: DashboardConnection) {
  return create<ProxyInfoState>((set) => {
    connection.onMessage((message) => {
      if (message.type !== 'proxyInfo') return;
      set({ proxyPort: message.proxyPort });
    });

    return { proxyPort: null };
  });
}

/** The app's real proxy-info store, wired to the real dashboard connection. */
export const useProxyInfoStore = createProxyInfoStore(getDashboardConnection());
