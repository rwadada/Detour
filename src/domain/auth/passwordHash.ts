import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * scrypt password hashing/verification, shared by every optional credential
 * Detour stores in `~/.detour/config.json`: the dashboard password (issue
 * #66) and the proxy's own `--proxy-auth` credentials (issue #158). It
 * started life as `infra/dashboard/dashboardPasswordHash.ts` and moved here,
 * under names that don't claim either feature, once the proxy needed exactly
 * the same thing — there was never anything dashboard-specific in it.
 *
 * A lightweight gate, not a hardened auth system — same posture as the rest
 * of `detour start`'s security surface (see `LAN_ACCESS_WARNING` in
 * `presentation/banner.ts`). scrypt is deliberately slow (basic brute-force resistance), and
 * comparison is timing-safe, but there's no rate limiting, account lockout,
 * or TLS — this protects against casual snooping on a shared network, not a
 * determined attacker. Never store or log the plaintext password.
 */
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// The async form, not `crypto.scryptSync`: this runs inside
// `dashboardServer.ts`'s `login`/`setDashboardPassword` WebSocket message
// handlers, and (since issue #158) inside `ProxyEngine`'s CONNECT/request
// handlers — all on the same event loop the proxy itself runs on.
// `scryptSync` blocks that loop for the full ~20ms+ of the KDF, and both of
// those surfaces are reachable by anything on the network, so a sync call
// here would turn "verify a password" into a trivial way to stall every
// other connection (dashboard tabs *and* proxied traffic) for as long as the
// flood continues. `crypto.scrypt`'s actual work still runs off the main
// thread (libuv's threadpool), which is what actually avoids the stall —
// `promisify` just gives it a `Promise` shape to `await`.
const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
) => Promise<Buffer>;

/** Matches exactly the hex string `hashPassword` produces for a value of `byteLength` bytes — used to validate a `stored` hash's two halves *before* decoding either. */
function isHexOfLength(value: string, byteLength: number): boolean {
  return value.length === byteLength * 2 && /^[0-9a-f]+$/i.test(value);
}

/**
 * Whether `value` has exactly the `<saltHex>:<hashHex>` shape `hashPassword`
 * produces. Exported so `userConfigStore.ts`'s config validation can reject
 * a malformed `dashboardPasswordHash`/`proxyAuth.passwordHash` up front — a
 * non-empty string that isn't a well-formed hash would otherwise pass that
 * validation, get persisted, and then have `dashboardPasswordSet` report
 * `true` (or the proxy demand credentials) while `verifyPassword` (using the
 * same check below) rejects every password against it: a self-inflicted
 * lockout with no way out except editing the config file or CLI by hand.
 */
export function isValidPasswordHash(value: string): boolean {
  const [saltHex, hashHex] = value.split(':');
  if (!saltHex || !hashHex) return false;
  return isHexOfLength(saltHex, SALT_LENGTH) && isHexOfLength(hashHex, KEY_LENGTH);
}

/**
 * Hashes `password` into the `<saltHex>:<hashHex>` string persisted as
 * `UserConfig.dashboardPasswordHash`/`UserConfig.proxyAuth.passwordHash`. A
 * fresh random salt every call, so hashing the same password twice produces
 * different output (as it should).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Checks `password` against a `stored` hash produced by `hashPassword`.
 * Returns `false` (rather than throwing) for a malformed `stored` value — a
 * hand-edited config shouldn't be able to crash a login attempt, only fail
 * it.
 *
 * Validates the whole shape with `isValidPasswordHash` *before* decoding
 * either half — `Buffer.from(str, 'hex')` doesn't reliably throw on invalid
 * input, it just silently stops decoding at the first bad character, which
 * can still produce a shorter-than-expected but non-empty buffer. Checking
 * the exact expected length up front (rather than, say, just
 * `expected.length === 0` afterwards) also bounds the KDF's own cost:
 * without it, a maliciously oversized on-disk `hashHex` could force
 * `scrypt` to derive an equally oversized key.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!isValidPasswordHash(stored)) return false;
  // `isValidPasswordHash` just confirmed both halves exist and have
  // the right shape — this cast tells TypeScript what that check already
  // guarantees; `stored.split(':')` on its own is typed as `string[]`
  // (length unknown), not the 2-tuple it always actually is here.
  const [saltHex, hashHex] = stored.split(':') as [string, string];
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
