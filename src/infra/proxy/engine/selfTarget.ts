import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';

/** Resolves a hostname to every address it currently maps to (`dns.lookup`'s `all` form). */
export type HostResolver = (host: string) => Promise<string[]>;

/** Every address this machine's own network interfaces carry right now. */
export type LocalAddressSource = () => string[];

const defaultResolver: HostResolver = async (host) => {
  const results = await dns.promises.lookup(host, { all: true });
  return results.map((r) => r.address);
};

const defaultLocalAddresses: LocalAddressSource = () =>
  Object.values(os.networkInterfaces())
    .flatMap((infos) => infos ?? [])
    .map((info) => info.address);

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** `::ffff:127.0.0.1` → `127.0.0.1`, so an IPv4-mapped address is judged as the IPv4 address it is. */
function unmapIPv4(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith('::ffff:') && net.isIPv4(lower.slice(7)) ? lower.slice(7) : lower;
}

function isLoopbackOrUnspecified(address: string): boolean {
  return address.startsWith('127.') || address === '0.0.0.0' || address === '::1' || address === '::';
}

/** Where a connection to an unspecified address (`0.0.0.0`, `::`: "any address") actually goes — that family's loopback. Any other address is itself. */
function loopbackEquivalent(address: string): string {
  if (address === '0.0.0.0') return '127.0.0.1';
  if (address === '::') return '::1';
  return address;
}

/**
 * Whether a connection to `target` (an IP) lands on a socket bound to
 * `listener`.
 *
 * - No known address, or the wildcard `::` (which Node binds dual-stack): any
 *   local address of either family reaches it — this machine's loopback, its
 *   unspecified address, or one of its interface addresses.
 * - The wildcard `0.0.0.0`: the same, but IPv4 only.
 * - A specific address (`::1`, `127.0.0.1`, a LAN IP): only that exact address.
 *   An IPv4 server on `127.0.0.1:P` is not what `[::1]:P` reaches, and vice
 *   versa — they are different sockets that happen to share a port number.
 */
function reachesListener(target: string, listener: string | undefined, own: Set<string>): boolean {
  const local = isLoopbackOrUnspecified(target) || own.has(target);
  if (listener === undefined || listener === '::') return local;
  if (listener === '0.0.0.0') return local && net.isIPv4(target);
  return loopbackEquivalent(target) === listener;
}

export interface SelfTargetGuard {
  /**
   * Marks a port this process listens on (the proxy itself, the dashboard, …)
   * as one the proxy must never relay to. `address` is what that listener is
   * actually bound to (`server.address().address`); give it whenever it is
   * known, so that an unrelated server sharing the port number on the *other*
   * address family is not mistaken for it. Omitted, any local address matches.
   */
  protectPort(port: number, address?: string): void;
  /**
   * Whether `host:port` is one of this process's own listeners — a protected
   * listener whose port matches and whose address the host resolves to (see
   * `reachesListener`).
   *
   * Judged on the *resolved* addresses rather than the literal name, so a
   * hostname that only points at `127.0.0.1` (`localtest.me`, a DNS-rebinding
   * record, …) is caught too. If any one answer reaches a listener the target
   * counts as self. A name that doesn't resolve is `false` — the relay itself
   * fails for it anyway.
   *
   * Only the target's own listeners are refused: loopback in general stays
   * reachable (a phone using the proxy to hit a dev server on
   * `localhost:3000`, a `route` rule pointing at localhost are legitimate).
   */
  isSelfTarget(host: string, port: number): Promise<boolean>;
}

export function createSelfTargetGuard(
  resolve: HostResolver = defaultResolver,
  localAddresses: LocalAddressSource = defaultLocalAddresses,
): SelfTargetGuard {
  const listeners: Array<{ port: number; address: string | undefined }> = [];
  return {
    protectPort: (port, address) => {
      listeners.push({ port, address: address === undefined ? undefined : unmapIPv4(stripBrackets(address)) });
    },
    async isSelfTarget(host, port) {
      const onPort = listeners.filter((l) => l.port === port);
      if (onPort.length === 0) return false;
      const bare = stripBrackets(host);
      let addresses: string[];
      if (net.isIP(bare)) {
        addresses = [bare];
      } else {
        try {
          addresses = await resolve(bare);
        } catch {
          return false;
        }
      }
      const own = new Set(localAddresses().map(unmapIPv4));
      const targets = addresses.map(unmapIPv4);
      return onPort.some((l) => targets.some((target) => reachesListener(target, l.address, own)));
    },
  };
}
