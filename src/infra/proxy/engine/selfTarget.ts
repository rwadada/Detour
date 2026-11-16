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

/**
 * WHATWG `URL`'s spelling of an IPv6 address that embeds an IPv4 one as its
 * last two hex groups: IPv4-mapped (`::ffff:7f00:1`) and the deprecated
 * IPv4-compatible form (`::7f00:1`, written `::127.0.0.1`). Treating the
 * latter as IPv4 too fails closed on a stack that would route it there — but
 * only for an embedded address whose first octet isn't 0, since that is all an
 * IPv4-compatible address ever carried; `::1:2` is an ordinary IPv6 address,
 * not 0.1.0.2.
 */
const IPV4_EMBEDDED = /^::(ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * One spelling per address, so comparing two of them as strings means
 * comparing the addresses. An IPv6 literal has many spellings — `::1`,
 * `0:0:0:0:0:0:0:1`, `0000::0001` and `::1%lo0` are all loopback,
 * `::ffff:7f00:1` is `::ffff:127.0.0.1` — and every one of them connects to
 * the same socket, so a guard that only knew the short form could be walked
 * past by writing the address out differently. IPv6 becomes the RFC 5952
 * form WHATWG `URL` serializes it to, and an address embedding IPv4 the IPv4
 * address it is (`::ffff:127.0.0.1` → `127.0.0.1`).
 *
 * The zone ID is always dropped. On a link-local address it does pick an
 * interface, but the stack is lenient about how it is written — macOS
 * delivers `fe80::1%lo0x`, `%01`, `%0x1` or a zone naming no interface at
 * all to lo0 — so no list of "this machine's spellings" can be complete.
 * Dropping it fails closed: the cost is that a link-local peer on another
 * interface that happens to share one of this machine's link-local
 * addresses is also refused, and only on one of Detour's own port numbers.
 *
 * Anything that isn't an IP literal is returned lowercased. An IPv6 literal
 * `net.isIPv6` accepts but `URL` won't parse becomes `::`, the unspecified
 * address, which counts as local — refusing it rather than throwing, since a
 * throw would surface as a rejected `isSelfTarget`, which callers treat as
 * "not self" and relay, and rather than returning it unnormalized, which
 * would compare as some other address and be relayed too.
 */
export function canonicalIp(address: string): string {
  const lower = stripBrackets(address).toLowerCase();
  const zoneAt = lower.indexOf('%');
  const ip = zoneAt === -1 ? lower : lower.slice(0, zoneAt);
  if (!net.isIPv6(ip)) return lower;
  let serialized: string;
  try {
    serialized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return '::';
  }
  const embedded = IPV4_EMBEDDED.exec(serialized);
  if (embedded) {
    const mapped = embedded[1] !== undefined;
    const hi = Number.parseInt(embedded[2]!, 16);
    const lo = Number.parseInt(embedded[3]!, 16);
    if (mapped || hi >> 8 !== 0) return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return serialized;
}

/**
 * `0.0.0.0/8` ("this network") as a destination: Linux delivers any of it to
 * this host the way it does `0.0.0.0`, so `0.0.0.1` counts too (failing
 * closed on stacks that refuse it instead).
 */
function isThisNetworkIPv4(address: string): boolean {
  return address.startsWith('0.') && net.isIPv4(address);
}

function isLoopbackOrUnspecified(address: string): boolean {
  return address.startsWith('127.') || isThisNetworkIPv4(address) || address === '::1' || address === '::';
}

/** Where a connection to an unspecified address (`0.0.0.0/8`, `::`: "any address") actually goes — that family's loopback. Any other address is itself. */
function loopbackEquivalent(address: string): string {
  if (isThisNetworkIPv4(address)) return '127.0.0.1';
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
