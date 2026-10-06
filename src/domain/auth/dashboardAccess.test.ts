import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_SESSION_COOKIE,
  generateDashboardToken,
  isValidDashboardToken,
  readCookie,
  requestHasValidToken,
  sessionCookieValue,
  tokenFromUrl,
  tokensEqual,
  urlWithoutToken,
} from './dashboardAccess';

const TOKEN = 'abcdefghijklmnop0123456789';

describe('generateDashboardToken', () => {
  it('makes a long, URL-safe, different token every time', () => {
    const a = generateDashboardToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidDashboardToken(a)).toBe(true);
    expect(generateDashboardToken()).not.toBe(a);
  });
});

describe('isValidDashboardToken', () => {
  it.each(['short', '', 'has space in it 0123456789', 'quote"0123456789abcdef', 'semi;colon0123456789a'])(
    'rejects %j',
    (token) => expect(isValidDashboardToken(token)).toBe(false),
  );
  it('accepts a long enough URL-safe string', () => {
    expect(isValidDashboardToken(TOKEN)).toBe(true);
    expect(isValidDashboardToken('A_b-c.d~E0123456789')).toBe(true);
  });
});

describe('tokensEqual', () => {
  it('is true only for the same string, whatever the lengths', () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
    expect(tokensEqual(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokensEqual('', TOKEN)).toBe(false);
  });
});

describe('sessionCookieValue', () => {
  it('is stable for a token, differs between tokens, and is not the token', () => {
    expect(sessionCookieValue(TOKEN)).toBe(sessionCookieValue(TOKEN));
    expect(sessionCookieValue(TOKEN)).not.toBe(sessionCookieValue(`${TOKEN}2`));
    expect(sessionCookieValue(TOKEN)).not.toContain(TOKEN);
    expect(sessionCookieValue(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('readCookie', () => {
  it('finds a cookie among several, ignoring spacing', () => {
    expect(readCookie('a=1; detour_dashboard_session=xyz;b=2', 'detour_dashboard_session')).toBe('xyz');
  });
  it('is undefined when absent or when there is no header', () => {
    expect(readCookie('a=1', 'b')).toBeUndefined();
    expect(readCookie(undefined, 'b')).toBeUndefined();
    expect(readCookie('novalue', 'novalue')).toBeUndefined();
  });
});

describe('tokenFromUrl / urlWithoutToken', () => {
  it('reads and strips the token query parameter, keeping the rest', () => {
    expect(tokenFromUrl('/ws?token=abc&x=1')).toBe('abc');
    expect(urlWithoutToken('/p?token=abc&x=1#h')).toBe('/p?x=1#h');
    expect(urlWithoutToken('/?token=abc')).toBe('/');
  });
  it('is undefined without a token or without a URL', () => {
    expect(tokenFromUrl('/ws')).toBeUndefined();
    expect(tokenFromUrl(undefined)).toBeUndefined();
  });
});

describe('requestHasValidToken', () => {
  const cookieHeader = `${DASHBOARD_SESSION_COOKIE}=${sessionCookieValue(TOKEN)}`;

  it('accepts the session cookie or the token in the URL', () => {
    expect(requestHasValidToken(TOKEN, { cookieHeader })).toBe(true);
    expect(requestHasValidToken(TOKEN, { url: `/ws?token=${TOKEN}` })).toBe(true);
  });

  it('rejects everything else', () => {
    expect(requestHasValidToken(TOKEN, {})).toBe(false);
    expect(requestHasValidToken(TOKEN, { url: '/ws?token=wrong' })).toBe(false);
    expect(requestHasValidToken(TOKEN, { cookieHeader: `${DASHBOARD_SESSION_COOKIE}=${TOKEN}` })).toBe(false);
    expect(requestHasValidToken(`${TOKEN}other`, { cookieHeader })).toBe(false);
  });
});
