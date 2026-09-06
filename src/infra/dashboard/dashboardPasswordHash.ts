import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Optional dashboard password (issue #66): a lightweight gate on the `/ws`
 * connection, not a hardened auth system — same posture as the rest of
 * `detour start`'s security surface (see `LAN_ACCESS_WARNING` in `cli.ts`).
 * scrypt is deliberately slow (basic brute-force resistance), and comparison
 * is timing-safe, but there's no rate limiting, account lockout, or TLS —
 * this protects against casual snooping on a shared network, not a
 * determined attacker. Never store or log the plaintext password.
 */
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// The async form, not `crypto.scryptSync`: this runs inside `dashboardServer.ts`'s
// `login`/`setDashboardPassword` WebSocket message handlers, on the same
// event loop the proxy itself runs on. `scryptSync` blocks that loop for the
// full ~20ms+ of the KDF — with `--lan` on, anything on the network can hit
// `login` repeatedly, so a sync call here turns "verify a password" into a
// trivial way to stall every other connection (dashboard tabs *and*
// proxied traffic) for as long as the flood continues. `crypto.scrypt`'s
// actual work still runs off the main thread (libuv's threadpool), which is
// what actually avoids the stall — `promisify` just gives it a `Promise`
// shape to `await`.
const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
) => Promise<Buffer>;

/**
 * Hashes `password` into the `<saltHex>:<hashHex>` string persisted as
 * `UserConfig.dashboardPasswordHash`. A fresh random salt every call, so
 * hashing the same password twice produces different output (as it should).
 */
export async function hashDashboardPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Checks `password` against a `stored` hash produced by
 * `hashDashboardPassword`. Returns `false` (rather than throwing) for a
 * malformed `stored` value — a hand-edited config shouldn't be able to crash
 * a login attempt, only fail it.
 */
export async function verifyDashboardPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const actual = await scryptAsync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
