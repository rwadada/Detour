import { create } from 'zustand';
import type { DashboardConnection } from '@/shared/api';

export interface ProxyInfoState {
  /** The proxy's port, or null until the `proxyInfo` message arrives (issue #24's sidebar Proxy URL / QR code). Null on an older server build that predates this message, too — the sidebar falls back to hiding the Proxy URL rather than guessing. */
  proxyPort: number | null;
  /** Every LAN address this machine has, from the `lanInfo` message (issue #66's sidebar LAN Access section) — empty until that message arrives, or when this machine genuinely has none. The proxy always binds to every interface, so (unlike before) this is populated regardless of whether the dashboard itself is LAN-reachable. */
  lanAddresses: string[];
  /** Whether the *dashboard* (not just the proxy, which is covered by `lanAddresses` alone) is also bound to every network interface right now — from `lanInfo`'s own field, or `resolveDashboardOnLan`'s fallback for an older server that predates it. Gates whether the sidebar's LAN Access section shows a Dashboard URL alongside each address's Proxy URL, since a Dashboard URL would be a dead link on any address but this one otherwise. Defaults to `false` until `lanInfo` arrives — the safer guess, since showing a dead Dashboard link is worse than briefly not showing a live one. */
  dashboardOnLan: boolean;
  /** Whether this session was started with `--insecure-upstream` (issue #160), from `proxyInfo`'s own field — `false` (verification on) until that message arrives, or on an older server that predates the field. Powers the persistent "upstream verification off" indicator (`ContextBar`) and the log table's per-row unverified badge. */
  insecureUpstream: boolean;
}

/** How an older server's `lanInfo` (one predating the `dashboardOnLan` field) is read: back then `addresses` was only ever sent non-empty when the dashboard itself was LAN-bound (there was no proxy-always-on-LAN split yet), so "field missing" safely means "yes" under that older server's own semantics, not "no". Exported for the test below; not meant as a general-purpose default. */
export function resolveDashboardOnLan(message: { addresses: string[]; dashboardOnLan?: boolean }): boolean {
  return message.dashboardOnLan ?? message.addresses.length > 0;
}

/**
 * Builds a store holding the proxy's port, this machine's LAN addresses,
 * and whether upstream TLS verification is disabled — each sent once by
 * the dashboard server right after connecting (issues #24, #66, #160).
 * Lives under `entities/proxy-config` (not `widgets/sidebar`, where this
 * originated) since it's now read by more than one widget (`Sidebar` and
 * `ContextBar`) — FSD forbids widget→widget imports, and entities are the
 * layer everything above is allowed to share (mirrors this same directory's
 * `createInterceptStore`/etc., whose own doc comment explains the same
 * move for the same reason).
 *
 * `connection` is a required parameter (no default) precisely so importing
 * this module never has the side effect of opening a real WebSocket — see
 * this package's `index.ts`, which wires the app's real singleton.
 */
export function createProxyInfoStore(connection: DashboardConnection) {
  return create<ProxyInfoState>((set) => {
    connection.onMessage((message) => {
      if (message.type === 'proxyInfo') {
        set({ proxyPort: message.proxyPort, insecureUpstream: message.insecureUpstream ?? false });
      } else if (message.type === 'lanInfo') {
        set({ lanAddresses: message.addresses, dashboardOnLan: resolveDashboardOnLan(message) });
      }
    });

    return { proxyPort: null, lanAddresses: [], dashboardOnLan: false, insecureUpstream: false };
  });
}
