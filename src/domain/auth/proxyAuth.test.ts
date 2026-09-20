import { describe, expect, it } from 'vitest';
import { hashPassword } from './passwordHash';
import {
  isValidProxyAuthCredentials,
  parseBasicProxyAuthorization,
  parseProxyAuthFlag,
  verifyProxyCredentials,
  type ProxyAuthCredentials,
} from './proxyAuth';

/** Builds the stored form of `user:pass` the same way `detour start --proxy-auth`/`detour config --proxy-auth` do. */
async function credentialsFor(username: string, password: string): Promise<ProxyAuthCredentials> {
  return { username, passwordHash: await hashPassword(password) };
}

/** Encodes `user:pass` into the header value a client would actually send. */
function basicHeader(value: string): string {
  return `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;
}

describe('parseProxyAuthFlag (issue #158)', () => {
  it('splits a <user>:<pass> value into its two halves', () => {
    expect(parseProxyAuthFlag('alice:s3cret')).toEqual({ username: 'alice', password: 's3cret' });
  });

  // RFC 7617: a username may not contain a colon, a password may — so the
  // *first* colon is the separator, not the last one.
  it('splits on the first colon, so a password may contain colons of its own', () => {
    expect(parseProxyAuthFlag('alice:a:b:c')).toEqual({ username: 'alice', password: 'a:b:c' });
  });

  it('rejects a value with no colon at all', () => {
    expect(() => parseProxyAuthFlag('alice')).toThrow('--proxy-auth must be in the form <user>:<pass>');
  });

  // An accidentally-empty half would otherwise configure real but
  // trivially-guessable credentials while still reporting auth as "required".
  it.each([
    [':s3cret', 'empty user'],
    ['alice:', 'empty password'],
    [':', 'both empty'],
  ])('rejects %s (%s)', (value) => {
    expect(() => parseProxyAuthFlag(value)).toThrow('neither the user nor the password may be empty');
  });

  it('names the flag it was given, so `detour config` reports its own flag', () => {
    expect(() => parseProxyAuthFlag('nope', '--proxy-auth (config)')).toThrow('--proxy-auth (config)');
  });
});

describe('parseBasicProxyAuthorization (issue #158)', () => {
  it('decodes a well-formed Basic header', () => {
    expect(parseBasicProxyAuthorization(basicHeader('alice:s3cret'))).toEqual({
      username: 'alice',
      password: 's3cret',
    });
  });

  it('accepts the scheme case-insensitively, as RFC 7235 requires', () => {
    expect(parseBasicProxyAuthorization(basicHeader('alice:s3cret').replace('Basic', 'bAsIc'))).toEqual({
      username: 'alice',
      password: 's3cret',
    });
  });

  it('keeps colons in the password', () => {
    expect(parseBasicProxyAuthorization(basicHeader('alice:a:b'))).toEqual({ username: 'alice', password: 'a:b' });
  });

  it.each([
    ['an absent header', undefined],
    ['an empty header', ''],
    ['another scheme', 'Bearer abcdef'],
    ['a scheme with no credentials', 'Basic'],
    ['non-base64 payload', 'Basic not base64!'],
    ['a decoded value with no colon', `Basic ${Buffer.from('alice', 'utf8').toString('base64')}`],
  ])('returns null for %s', (_label, header) => {
    expect(parseBasicProxyAuthorization(header)).toBeNull();
  });
});

describe('verifyProxyCredentials (issue #158)', () => {
  it('accepts the configured credentials', async () => {
    const credentials = await credentialsFor('alice', 's3cret');
    expect(await verifyProxyCredentials(credentials, basicHeader('alice:s3cret'))).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const credentials = await credentialsFor('alice', 's3cret');
    expect(await verifyProxyCredentials(credentials, basicHeader('alice:wrong'))).toBe(false);
  });

  it('rejects a wrong username even with the right password', async () => {
    const credentials = await credentialsFor('alice', 's3cret');
    expect(await verifyProxyCredentials(credentials, basicHeader('mallory:s3cret'))).toBe(false);
  });

  // A prefix/suffix of the real username must not be accepted — the
  // HMAC-digest comparison that makes the check timing-safe would still be
  // wrong if it compared only as far as the shorter of the two.
  it.each(['ali', 'alicia', 'alice ', ' alice'])('rejects the near-miss username %p', async (username) => {
    const credentials = await credentialsFor('alice', 's3cret');
    expect(await verifyProxyCredentials(credentials, basicHeader(`${username}:s3cret`))).toBe(false);
  });

  it('rejects a request with no credentials at all', async () => {
    const credentials = await credentialsFor('alice', 's3cret');
    expect(await verifyProxyCredentials(credentials, undefined)).toBe(false);
  });

  // The whole point of not returning early on a bad username: a wrong
  // username must cost the same ~20ms of scrypt as a wrong password, or
  // response time becomes an oracle for which usernames exist. Asserted as
  // "both do real KDF work", not as a wall-clock comparison — the latter is
  // inherently flaky on a shared CI runner.
  it('runs the KDF even when the username is already known to be wrong', async () => {
    const credentials = await credentialsFor('alice', 's3cret');
    const elapsed = async (header: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await verifyProxyCredentials(credentials, header);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const wrongUsername = await elapsed(basicHeader('mallory:s3cret'));
    const noCredentials = await elapsed('Bearer nope');
    expect(wrongUsername).toBeGreaterThan(noCredentials);
  });

  it('rejects rather than throws when the stored hash is malformed', async () => {
    const credentials: ProxyAuthCredentials = { username: 'alice', passwordHash: 'not-a-hash' };
    expect(await verifyProxyCredentials(credentials, basicHeader('alice:s3cret'))).toBe(false);
  });
});

describe('isValidProxyAuthCredentials (issue #158)', () => {
  it('accepts what hashPassword actually produces', async () => {
    expect(isValidProxyAuthCredentials(await credentialsFor('alice', 's3cret'))).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'alice:s3cret'],
    ['a missing username', { passwordHash: `${'a'.repeat(32)}:${'b'.repeat(128)}` }],
    ['an empty username', { username: '', passwordHash: `${'a'.repeat(32)}:${'b'.repeat(128)}` }],
    ['a missing hash', { username: 'alice' }],
    ['a plaintext password in place of the hash', { username: 'alice', passwordHash: 's3cret' }],
  ])('rejects %s', (_label, value) => {
    expect(isValidProxyAuthCredentials(value)).toBe(false);
  });
});
