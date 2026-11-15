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

/** The eight 16-bit groups of an IPv6 address `net.isIPv6` has already accepted (zone ID removed), expanding `::` and a dotted-quad tail. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (net.isIPv4(tail)) {
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  if (rest === undefined) return headGroups.map((g) => Number.parseInt(g, 16));
  const restGroups = rest === '' ? [] : rest.split(':');
  const zeros = Array.from({ length: 8 - headGroups.length - restGroups.length }, () => '0');
  return [...headGroups, ...zeros, ...restGroups].map((g) => Number.parseInt(g, 16));
}

/** RFC 5952 text for eight IPv6 groups: lowercase hex, no leading zeros, the longest (first, on a tie) run of two or more zero groups as `::`. */
function formatIPv6(groups: number[]): string {
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

/**
 * One spelling per address, so comparing two of them as strings means
 * comparing the addresses. An IPv6 literal has many spellings — `::1`,
 * `0:0:0:0:0:0:0:1` and `0000::0001` are all loopback, `::ffff:7f00:1` is
 * `::ffff:127.0.0.1` (and the form WHATWG `URL` serializes it to) — and every
 * one of them connects to the same socket, so a guard that only knew the
 * short form could be walked past by writing the address out differently.
 * IPv6 becomes its RFC 5952 form, an IPv4-mapped address the IPv4 address it
 * is (`::ffff:127.0.0.1` → `127.0.0.1`), and a zone ID (`fe80::1%en0`) is
 * dropped, since interface addresses are listed without one. Anything that
 * isn't an IP literal is returned lowercased.
 */
export function canonicalIp(address: string): string {
  const lower = stripBrackets(address).toLowerCase();
  const zoneless = lower.includes('%') ? lower.slice(0, lower.indexOf('%')) : lower;
  if (!net.isIPv6(zoneless)) return lower;
  const groups = ipv6Groups(zoneless);
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return formatIPv6(groups);
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
      listeners.push({ port, address: address === undefined ? undefined : canonicalIp(address) });
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
      const own = new Set(localAddresses().map(canonicalIp));
      const targets = addresses.map(canonicalIp);
      return onPort.some((l) => targets.some((target) => reachesListener(target, l.address, own)));
    },
  };
}
