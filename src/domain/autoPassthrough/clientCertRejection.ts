/**
 * The TLS alerts (RFC 8446 §6.2) a client sends when it refuses the
 * certificate Detour presented for a MITM'd host. Each one means "I don't
 * accept this certificate": this client doesn't trust the Detour CA (an
 * Android 7+ app that doesn't opt in to user CAs, a client with its own trust
 * store) or it pins a different certificate. Nothing on the proxy side can
 * make such a client accept the MITM, so the useful thing left is to stop
 * MITM-ing that host.
 *
 * Matched on the alert number OpenSSL appends to the error message
 * (`… SSL alert number 46`) rather than on `err.code`, whose spelling
 * follows OpenSSL's reason strings and differs between versions
 * (`ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN` vs `…_TLS_ALERT_…`).
 *
 * A client that simply hangs up mid-handshake (Node's own `tls` does this
 * instead of sending an alert) is deliberately *not* treated as a refusal:
 * a network drop looks the same, and switching a host to passthrough on a
 * flaky connection would silently stop decrypting it for the session.
 */
const REJECTION_ALERTS: ReadonlyMap<number, string> = new Map([
  [42, 'bad certificate'],
  [43, 'unsupported certificate'],
  [44, 'certificate revoked'],
  [45, 'certificate expired'],
  [46, 'certificate unknown'],
  [48, 'unknown CA'],
]);

const ALERT_NUMBER = /SSL alert number (\d+)/;

/** The alert a client refused Detour's certificate with (`'certificate unknown'`, `'unknown CA'`, …), or `undefined` for any other TLS failure. */
export function clientCertRejectionAlert(error: { message?: unknown } | undefined): string | undefined {
  const message = error?.message;
  if (typeof message !== 'string') return undefined;
  const match = ALERT_NUMBER.exec(message);
  return match ? REJECTION_ALERTS.get(Number(match[1])) : undefined;
}

/** One CONNECT target, as seen from one client: what a refusal is remembered for. */
export interface AutoPassthroughTarget {
  /** The client's address, when known — a refusal only ever speaks for the client that made it. */
  clientAddress: string | undefined;
  host: string;
  port: number;
}

/**
 * CONNECT targets whose client refused Detour's certificate, and so are
 * relayed as raw TLS for a while instead of MITM'd (auto TLS passthrough).
 *
 * Keyed by client, host and port — exactly what the CONNECT named, so the
 * lookup in `connectHandler.ts` matches whatever the client wrote (an IP
 * literal, a trailing dot), and one client's refusal never turns off
 * decryption of the same host for another client that does trust the CA,
 * nor for another port.
 *
 * Each entry expires `AUTO_PASSTHROUGH_TTL_MS` after it was recorded, not
 * after its last use: a client that refused only because the CA wasn't
 * installed yet gets MITM'd again within minutes, while one that never will
 * trust it just loses one connection per period before being recorded again.
 */
export interface AutoPassthroughHosts {
  /** Records `target`; `true` if it wasn't already recorded (and there was room for it). */
  add(target: AutoPassthroughTarget): boolean;
  has(target: AutoPassthroughTarget): boolean;
}

/** How long a refusal is remembered. */
export const AUTO_PASSTHROUGH_TTL_MS = 10 * 60_000;

/**
 * How many targets are remembered at most. Anything on the network can use
 * the proxy without `--proxy-auth`, and every refusal names a host of the
 * client's choosing, so without a bound a client could grow this set for as
 * long as the process runs. A real device session touches tens of hosts;
 * past the cap, a refusing target is simply MITM'd (and refused) again,
 * which is how Detour behaved before auto passthrough.
 */
const MAX_AUTO_PASSTHROUGH_TARGETS = 10_000;

function keyOf(target: AutoPassthroughTarget): string {
  return `${target.clientAddress ?? ''} ${target.host.toLowerCase()}:${target.port}`;
}

export function createAutoPassthroughHosts(
  options: { limit?: number; ttlMs?: number; now?: () => number } = {},
): AutoPassthroughHosts {
  const { limit = MAX_AUTO_PASSTHROUGH_TARGETS, ttlMs = AUTO_PASSTHROUGH_TTL_MS, now = Date.now } = options;
  const expiresAt = new Map<string, number>();
  const live = (key: string): boolean => {
    const expiry = expiresAt.get(key);
    if (expiry === undefined) return false;
    if (expiry > now()) return true;
    expiresAt.delete(key);
    return false;
  };
  // Every entry gets the same TTL and a Map iterates in insertion order, so
  // the expired ones are always at the front: stop at the first live one
  // rather than scanning a full set on every refused add.
  const pruneExpired = (): void => {
    const time = now();
    for (const [key, expiry] of expiresAt) {
      if (expiry > time) break;
      expiresAt.delete(key);
    }
  };
  return {
    add(target) {
      const key = keyOf(target);
      if (live(key)) return false;
      if (expiresAt.size >= limit) pruneExpired();
      if (expiresAt.size >= limit) return false;
      expiresAt.set(key, now() + ttlMs);
      return true;
    },
    has: (target) => live(keyOf(target)),
  };
}
