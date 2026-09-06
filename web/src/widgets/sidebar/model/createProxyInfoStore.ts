import { create } from 'zustand';
import type { DashboardConnection } from '@/shared/api';

export interface ProxyInfoState {
  /** The proxy's port, or null until the `proxyInfo` message arrives (issue #24's sidebar Proxy URL / QR code). Null on an older server build that predates this message, too — the sidebar falls back to hiding the Proxy URL rather than guessing. */
  proxyPort: number | null;
  /** Every LAN address this machine has, from the `lanInfo` message (issue #66's sidebar LAN Access section) — empty until that message arrives, and empty for good when the server is bound to `localhost` only. */
  lanAddresses: string[];
}

/**
 * Builds a store holding the proxy's port and this machine's LAN addresses,
 * sent once by the dashboard server right after connecting (issues #24 and
 * #66). Lives under `widgets/sidebar` rather than as its own `entities`
 * slice — Sidebar is currently its only consumer, and FSD's steiger linter
 * (`fsd/insignificant-slice`) flags a one-consumer entity as better merged
 * into that consumer.
 *
 * `connection` is a required parameter (no default) precisely so importing
 * this module never has the side effect of opening a real WebSocket — see
 * `ui/Sidebar.tsx`, which wires the app's real singleton.
 */
export function createProxyInfoStore(connection: DashboardConnection) {
  return create<ProxyInfoState>((set) => {
    connection.onMessage((message) => {
      if (message.type === 'proxyInfo') set({ proxyPort: message.proxyPort });
      else if (message.type === 'lanInfo') set({ lanAddresses: message.addresses });
    });

    return { proxyPort: null, lanAddresses: [] };
  });
}
