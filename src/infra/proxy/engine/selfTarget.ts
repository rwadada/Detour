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

export interface SelfTargetGuard {
  /** Marks a port this process listens on (the proxy itself, the dashboard, …) as one the proxy must never relay to. */
  protectPort(port: number): void;
  /**
   * Whether `host:port` is one of this process's own listeners — a port in
   * `protectPort`'s set whose host resolves to this machine (loopback, the
   * unspecified address, or any of its interface addresses).
   *
   * Judged on the *resolved* addresses rather than the literal name, so a
   * hostname that only points at `127.0.0.1` (`localtest.me`, a DNS-rebinding
   * record, …) is caught too. If any one answer is local the target counts
   * as self. A name that doesn't resolve is `false` — the relay itself fails
   * for it anyway.
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
  const ports = new Set<number>();
  return {
    protectPort: (port) => {
      ports.add(port);
    },
    async isSelfTarget(host, port) {
      if (!ports.has(port)) return false;
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
      return addresses.map(unmapIPv4).some((address) => isLoopbackOrUnspecified(address) || own.has(address));
    },
  };
}
