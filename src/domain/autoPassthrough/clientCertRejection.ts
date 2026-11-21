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
 * Keyed by client address, host and port — exactly what the CONNECT named,
 * so the lookup in `connectHandler.ts` matches whatever the client wrote (an
 * IP literal, a trailing dot), and a refusal never turns off decryption of
 * the same host for another device, nor for another port. A "client" is an
 * address, not an app: everything on one device (or every local process on
 * this machine, all 127.0.0.1) shares it, so one app refusing a host relays
 * that host for the others there too — nothing on the wire tells two apps
 * on the same address apart. `clear()` (toggling Intercept or changing
 * Focus) takes it back sooner.
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
  /** Forgets every target at once — the way to MITM them again before they expire (say, right after installing the CA). */
  clear(): void;
  /** The targets still recorded, oldest (soonest to expire) first, at most `limit` of them, with how long each has left (issue #302: shown in the dashboard). */
  list(limit?: number): AutoPassthroughRecord[];
  /** How many targets are still recorded. */
  size(): number;
}

/** One recorded target and the time it has left. */
export interface AutoPassthroughRecord extends AutoPassthroughTarget {
  remainingMs: number;
}

/** How long a refusal is remembered. */
export const AUTO_PASSTHROUGH_TTL_MINUTES = 10;
const AUTO_PASSTHROUGH_TTL_MS = AUTO_PASSTHROUGH_TTL_MINUTES * 60_000;

/**
 * How many targets are remembered at most. Anything on the network can use
 * the proxy without `--proxy-auth`, and every refusal names a host of the
 * client's choosing, so without a bound a client could grow this set for as
 * long as the process runs. A real device session touches tens of hosts;
 * past the cap, a refusing target is simply MITM'd (and refused) again,
 * which is how Detour behaved before auto passthrough.
 */
const MAX_AUTO_PASSTHROUGH_TARGETS = 10_000;

/**
 * How many of those one client address may hold, so a single client (all of
 * them without `--proxy-auth`) can't fill the shared set with made-up hosts
 * and leave none for the devices actually being debugged.
 */
const MAX_AUTO_PASSTHROUGH_TARGETS_PER_CLIENT = 1_000;

function keyOf(target: AutoPassthroughTarget): string {
  return `${target.clientAddress ?? ''} ${target.host.toLowerCase()}:${target.port}`;
}

/** The first `limit` of `entries` (oldest first) as records, without copying the rest. */
function firstRecords(
  entries: Iterable<{ expiry: number; target: AutoPassthroughTarget }>,
  limit: number,
  time: number,
): AutoPassthroughRecord[] {
  const records: AutoPassthroughRecord[] = [];
  for (const { expiry, target } of entries) {
    if (records.length >= limit) break;
    records.push({ ...target, remainingMs: expiry - time });
  }
  return records;
}

/** `hosts`, calling `onAdded` after every target it newly records (issue #302: so the dashboard hears of it). */
export function notifyingOnAdd(hosts: AutoPassthroughHosts, onAdded: () => void): AutoPassthroughHosts {
  return {
    add: (target) => {
      const added = hosts.add(target);
      if (added) onAdded();
      return added;
    },
    has: (target) => hosts.has(target),
    clear: () => hosts.clear(),
    list: (limit) => hosts.list(limit),
    size: () => hosts.size(),
  };
}

export function createAutoPassthroughHosts(
  options: { limit?: number; perClientLimit?: number; ttlMs?: number; now?: () => number } = {},
): AutoPassthroughHosts {
  // A monotonic clock: a wall-clock step (NTP, sleep/resume) would otherwise
  // stretch or cut every entry's lifetime and break pruneExpired's ordering.
  const {
    limit = MAX_AUTO_PASSTHROUGH_TARGETS,
    perClientLimit = MAX_AUTO_PASSTHROUGH_TARGETS_PER_CLIENT,
    ttlMs = AUTO_PASSTHROUGH_TTL_MS,
    now = () => performance.now(),
  } = options;
  const entries = new Map<string, { expiry: number; client: string; target: AutoPassthroughTarget }>();
  const perClient = new Map<string, number>();
  const remove = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    const count = (perClient.get(entry.client) ?? 1) - 1;
    if (count > 0) perClient.set(entry.client, count);
    else perClient.delete(entry.client);
  };
  const live = (key: string): boolean => {
    const entry = entries.get(key);
    if (entry === undefined) return false;
    if (entry.expiry > now()) return true;
    remove(key);
    return false;
  };
  // Every entry gets the same TTL and a Map iterates in insertion order, so
  // the expired ones are always at the front: stop at the first live one
  // rather than scanning a full set on every refused add.
  const pruneExpired = (): void => {
    const time = now();
    for (const [key, entry] of entries) {
      if (entry.expiry > time) break;
      remove(key);
    }
  };
  return {
    add(target) {
      const key = keyOf(target);
      if (live(key)) return false;
      const client = target.clientAddress ?? '';
      if (entries.size >= limit || (perClient.get(client) ?? 0) >= perClientLimit) pruneExpired();
      if (entries.size >= limit || (perClient.get(client) ?? 0) >= perClientLimit) return false;
      const { clientAddress, host, port } = target;
      entries.set(key, { expiry: now() + ttlMs, client, target: { clientAddress, host, port } });
      perClient.set(client, (perClient.get(client) ?? 0) + 1);
      return true;
    },
    has: (target) => live(keyOf(target)),
    clear: () => {
      entries.clear();
      perClient.clear();
    },
    list: (limit = Number.POSITIVE_INFINITY) => {
      pruneExpired();
      return firstRecords(entries.values(), limit, now());
    },
    size: () => {
      pruneExpired();
      return entries.size;
    },
  };
}
