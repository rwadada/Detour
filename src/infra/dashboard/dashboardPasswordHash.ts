import crypto from 'node:crypto';

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

/**
 * Hashes `password` into the `<saltHex>:<hashHex>` string persisted as
 * `UserConfig.dashboardPasswordHash`. A fresh random salt every call, so
 * hashing the same password twice produces different output (as it should).
 */
export function hashDashboardPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Checks `password` against a `stored` hash produced by
 * `hashDashboardPassword`. Returns `false` (rather than throwing) for a
 * malformed `stored` value — a hand-edited config shouldn't be able to crash
 * a login attempt, only fail it.
 */
export function verifyDashboardPassword(password: string, stored: string): boolean {
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
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
