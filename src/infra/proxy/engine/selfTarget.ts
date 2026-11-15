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

/**
 * A link-local address (`fe80::1` on macOS's `lo0`) is only this machine's on
 * the interface that carries it — the same text on another interface is
 * someone else (often the LAN router). So one is listed both bare, as
 * `os.networkInterfaces` reports it, and with its zone ID in the two ways a
 * client can write it (`fe80::1%lo0`, `fe80::1%1`), while a zone naming a
 * different interface matches neither.
 */
const defaultLocalAddresses: LocalAddressSource = () =>
  Object.entries(os.networkInterfaces()).flatMap(([name, infos]) =>
    (infos ?? []).flatMap((info) =>
      info.family === 'IPv6' && info.scopeid
        ? [info.address, `${info.address}%${name}`, `${info.address}%${info.scopeid}`]
        : [info.address],
    ),
  );

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * WHATWG `URL`'s spelling of an IPv6 address that embeds an IPv4 one as its
 * last two hex groups: IPv4-mapped (`::ffff:7f00:1`) and the deprecated
 * IPv4-compatible form (`::7f00:1`, written `::127.0.0.1`). Treating the
 * latter as IPv4 too fails closed on a stack that would route it there.
 */
const IPV4_EMBEDDED = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/** `fe80::/10` — the only addresses whose zone ID picks which host they mean. */
const LINK_LOCAL = /^fe[89ab][0-9a-f]:/;

/**
 * One spelling per address, so comparing two of them as strings means
 * comparing the addresses. An IPv6 literal has many spellings — `::1`,
 * `0:0:0:0:0:0:0:1`, `0000::0001` and `::1%lo0` are all loopback,
 * `::ffff:7f00:1` is `::ffff:127.0.0.1` — and every one of them connects to
 * the same socket, so a guard that only knew the short form could be walked
 * past by writing the address out differently. IPv6 becomes the RFC 5952
 * form WHATWG `URL` serializes it to, and an address embedding IPv4 the IPv4
 * address it is (`::ffff:127.0.0.1` → `127.0.0.1`). A zone ID is kept only on
 * a link-local address (`fe80::1%en0`), where it picks the interface and so
 * the host — the same link-local address on two interfaces is two different
 * hosts. On any other address the stack ignores it, so it is dropped.
 * Anything that isn't an IP literal is returned lowercased.
 */
export function canonicalIp(address: string): string {
  const lower = stripBrackets(address).toLowerCase();
  const zoneAt = lower.indexOf('%');
  const ip = zoneAt === -1 ? lower : lower.slice(0, zoneAt);
  if (!net.isIPv6(ip)) return lower;
  const serialized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const embedded = IPV4_EMBEDDED.exec(serialized);
  if (embedded) {
    const hi = Number.parseInt(embedded[1]!, 16);
    const lo = Number.parseInt(embedded[2]!, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return zoneAt !== -1 && LINK_LOCAL.test(serialized) ? `${serialized}${lower.slice(zoneAt)}` : serialized;
}

/** A canonical address without its zone ID, if it has one. */
function withoutZone(address: string): string {
  const zoneAt = address.indexOf('%');
  return zoneAt === -1 ? address : address.slice(0, zoneAt);
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
 *   Compared without zone IDs: a listener's bound address (from
 *   `server.address()`) carries none, so a zone on either side must not keep
 *   two spellings of the same socket apart. That can over-match a link-local
 *   listener (the same address on another interface), which fails closed.
 */
function reachesListener(target: string, listener: string | undefined, own: Set<string>): boolean {
  const local = isLoopbackOrUnspecified(target) || own.has(target);
  if (listener === undefined || listener === '::') return local;
  if (listener === '0.0.0.0') return local && net.isIPv4(target);
  return loopbackEquivalent(withoutZone(target)) === withoutZone(listener);
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
  // This machine's interface addresses rarely change, but are re-read on
  // every check of a protected port; remember each one's canonical form.
  const canonicalLocals = new Map<string, string>();
  const canonicalLocal = (address: string): string => {
    let canonical = canonicalLocals.get(address);
    if (canonical === undefined) {
      canonical = canonicalIp(address);
      canonicalLocals.set(address, canonical);
    }
    return canonical;
  };
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
      const own = new Set(localAddresses().map(canonicalLocal));
      const targets = addresses.map(canonicalIp);
      return onPort.some((l) => targets.some((target) => reachesListener(target, l.address, own)));
    },
  };
}
