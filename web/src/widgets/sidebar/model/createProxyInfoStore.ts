import { create } from 'zustand';
import type { DashboardConnection } from '@/shared/api';

export interface ProxyInfoState {
  /** The proxy's port, or null until the `proxyInfo` message arrives (issue #24's sidebar Proxy URL / QR code). Null on an older server build that predates this message, too — the sidebar falls back to hiding the Proxy URL rather than guessing. */
  proxyPort: number | null;
  /** Every LAN address this machine has, from the `lanInfo` message (issue #66's sidebar LAN Access section) — empty until that message arrives, or when this machine genuinely has none. The proxy always binds to every interface, so (unlike before) this is populated regardless of whether the dashboard itself is LAN-reachable. */
  lanAddresses: string[];
  /** Whether the *dashboard* (not just the proxy, which is covered by `lanAddresses` alone) is also bound to every network interface right now — from `lanInfo`'s own field. Gates whether the sidebar's LAN Access section shows a Dashboard URL alongside each address's Proxy URL, since a Dashboard URL would be a dead link on any address but this one otherwise. Defaults to `false` until `lanInfo` arrives — the safer guess, since showing a dead Dashboard link is worse than briefly not showing a live one. */
  dashboardOnLan: boolean;
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
      else if (message.type === 'lanInfo') {
        set({ lanAddresses: message.addresses, dashboardOnLan: message.dashboardOnLan });
      }
    });

    return { proxyPort: null, lanAddresses: [], dashboardOnLan: false };
  });
}
