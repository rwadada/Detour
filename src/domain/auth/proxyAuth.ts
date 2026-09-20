import crypto from 'node:crypto';
import { isValidPasswordHash, verifyPassword } from './passwordHash';

/**
 * Optional proxy authentication (issue #158): the credentials a client must
 * present — as an ordinary `Proxy-Authorization: Basic <base64>` header, the
 * scheme every HTTP client, browser and mobile OS proxy setting already
 * knows how to send — before Detour will proxy anything for it at all.
 *
 * Without this, `detour start` is an open forward proxy the moment it's
 * reachable from a network (which it always is — see `PROXY_HOST`'s doc
 * comment in `cli.ts`): anyone who points their device at it gets their
 * HTTPS traffic MITM'd with Detour's CA, decrypted, and recorded into
 * `~/.detour/` and the dashboard, and can use the machine as an egress hop.
 *
 * The password is never stored in plaintext — only the scrypt hash
 * `passwordHash.ts` produces, both in `~/.detour/config.json` (via
 * `detour config --proxy-auth`) and in memory for the life of the process
 * (via `detour start --proxy-auth`).
 */
export interface ProxyAuthCredentials {
  username: string;
  /** The scrypt hash of the password, as produced by `hashPassword` — never the password itself. */
  passwordHash: string;
}

/** The plaintext pair a `<user>:<pass>` CLI value or a `Proxy-Authorization` header decodes to. Deliberately *not* what gets persisted — see `ProxyAuthCredentials`. */
export interface ProxyAuthInput {
  username: string;
  password: string;
}

/** The request header a client sends credentials in. Node lowercases every header name it parses off the wire, so this doubles as the lookup key. */
export const PROXY_AUTHORIZATION_HEADER = 'proxy-authorization';

/** The `Proxy-Authenticate` value sent with every `407`, naming the scheme and realm a client should prompt for. */
export const PROXY_AUTHENTICATE_CHALLENGE = 'Basic realm="Detour"';

/**
 * Parses a `--proxy-auth <user:pass>` CLI value. Splits on the *first*
 * colon, which is also exactly what RFC 7617 requires of Basic
 * credentials — a username may not contain a colon, a password may.
 *
 * Both halves must be non-empty: an accidentally-empty one (a script that
 * forgot to interpolate a variable, say) would otherwise silently configure
 * real, trivially-guessable credentials while the banner cheerfully reports
 * authentication as "required" — worse than not setting any at all. Same
 * reasoning as `parseDashboardPasswordFlag`'s in `cli.ts`.
 */
export function parseProxyAuthFlag(value: string, flag = '--proxy-auth'): ProxyAuthInput {
  const separator = value.indexOf(':');
  if (separator === -1) throw new Error(`${flag} must be in the form <user>:<pass>`);
  const username = value.slice(0, separator);
  const password = value.slice(separator + 1);
  if (!username || !password) {
    throw new Error(`${flag} must be in the form <user>:<pass> — neither the user nor the password may be empty`);
  }
  return { username, password };
}

/**
 * Decodes a `Proxy-Authorization: Basic <base64>` header value, returning
 * `null` for anything that isn't well-formed Basic credentials (absent,
 * another scheme, undecodable, no colon in the decoded pair). A `null` here
 * is always a `407`, never an error — an unauthenticated client asking for
 * the challenge is the normal first half of the handshake, not a fault.
 */
export function parseBasicProxyAuthorization(header: string | undefined): ProxyAuthInput | null {
  if (!header) return null;
  // Split the scheme off case-insensitively (RFC 7235's auth-scheme token
  // is case-insensitive) rather than matching the whole thing under `/i` —
  // that flag applied to the base64 payload too would make `[A-Za-z0-9+/]`
  // match every letter twice over, which is exactly the redundant-character-
  // class shape a linter (rightly) flags.
  const match = /^Basic[ \t]+(\S+)[ \t]*$/i.exec(header.trim());
  if (!match) return null;
  const encoded = match[1]!;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/**
 * Compares two strings in constant time with respect to their *contents*.
 *
 * `crypto.timingSafeEqual` throws outright on differently-sized buffers, so
 * it can't take a username straight off the wire; comparing HMACs of the two
 * under a per-call random key gives fixed-length (32-byte) digests to feed
 * it instead, which is the standard way around that. A random key per call
 * (rather than a module-level one) means an attacker can't precompute
 * anything against it, and the digests never leave this function.
 *
 * Length itself still leaks, in the sense that HMAC's own runtime grows with
 * input size — irrelevant here, where the secret is the password (handled by
 * scrypt + `timingSafeEqual` in `verifyPassword`) and this only guards the
 * username.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const key = crypto.randomBytes(32);
  const digestA = crypto.createHmac('sha256', key).update(a, 'utf8').digest();
  const digestB = crypto.createHmac('sha256', key).update(b, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Whether `header` (a raw `Proxy-Authorization` value) presents `credentials`.
 *
 * Deliberately verifies the password even when the username already didn't
 * match, `&&`-ing the two results only at the end: returning early on a bad
 * username would answer in microseconds instead of scrypt's ~20ms, turning
 * response time into an oracle for "is this a real username?". Both checks
 * are themselves timing-safe (`timingSafeStringEqual` above,
 * `crypto.timingSafeEqual` inside `verifyPassword`).
 *
 * A missing or malformed header short-circuits to `false` before any of
 * that: there are no credentials to compare, so there's nothing to leak, and
 * running the KDF anyway would hand anyone who can reach the port a ~20ms
 * unit of work per connection.
 */
export async function verifyProxyCredentials(
  credentials: ProxyAuthCredentials,
  header: string | undefined,
): Promise<boolean> {
  const presented = parseBasicProxyAuthorization(header);
  if (!presented) return false;
  const usernameMatches = timingSafeStringEqual(presented.username, credentials.username);
  const passwordMatches = await verifyPassword(presented.password, credentials.passwordHash);
  return usernameMatches && passwordMatches;
}

/**
 * Whether `value` is a well-formed `ProxyAuthCredentials` object. Used by
 * `userConfigStore.ts` to validate `~/.detour/config.json`'s `proxyAuth` on
 * both read and write — an unrecognizable value there would otherwise make
 * every request `407` with no way for the user to tell why (see
 * `isValidPasswordHash`'s own doc comment on that failure mode).
 */
export function isValidProxyAuthCredentials(value: unknown): value is ProxyAuthCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { username, passwordHash } = value as Partial<ProxyAuthCredentials>;
  if (typeof username !== 'string' || username === '') return false;
  return typeof passwordHash === 'string' && isValidPasswordHash(passwordHash);
}
