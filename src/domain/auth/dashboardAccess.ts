import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The dashboard's access token (issue #205).
 *
 * The proxy listens on every network interface while the dashboard defaults
 * to localhost, so "it only listens on localhost" is not a boundary worth
 * relying on (mitmweb's CVE-2025-23217 was exactly that). The dashboard
 * therefore requires a secret by default: a random token the user opens once
 * (`http://localhost:4040/?token=…`, printed at startup), which the server
 * trades for an HttpOnly cookie. Same shape as Jupyter's token and
 * mitmproxy's fix.
 */

/** Cookie the server hands back once a valid `?token=` has been presented. */
export const DASHBOARD_SESSION_COOKIE = 'detour_dashboard_session';

/** Shortest token accepted from `DETOUR_DASHBOARD_TOKEN` — generated ones are 64 hex characters. */
export const MIN_DASHBOARD_TOKEN_LENGTH = 16;

export function generateDashboardToken(): string {
  return randomBytes(32).toString('hex');
}

/** Whether `token` is acceptable as a dashboard token (long enough to resist guessing, no whitespace/quotes that would need escaping in a URL or cookie). */
export function isValidDashboardToken(token: string): boolean {
  return token.length >= MIN_DASHBOARD_TOKEN_LENGTH && /^[A-Za-z0-9._~-]+$/.test(token);
}

/** Constant-time comparison. Both sides are hashed first so a different length can't be told apart by timing. */
export function tokensEqual(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The cookie value that proves the holder presented the token. Derived from
 * the token rather than being the token itself, so the long-lived secret is
 * not what sits in the browser's cookie jar (or shows up in a copied
 * `Cookie` header), while the server can still recognise it without keeping
 * any session state.
 */
export function sessionCookieValue(token: string): string {
  return createHmac('sha256', token).update('detour-dashboard-session').digest('hex');
}

/** Reads one cookie out of a `Cookie` request header. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The `token` query parameter of a request URL (`/ws?token=…`), if any. */
export function tokenFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, 'http://localhost').searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a request carries valid proof of the token: the session cookie
 * (what a browser has after its first visit) or a `?token=` query parameter
 * (the first visit itself, and scripted/WebSocket clients).
 */
export function requestHasValidToken(token: string, request: { url?: string; cookieHeader?: string }): boolean {
  const cookie = readCookie(request.cookieHeader, DASHBOARD_SESSION_COOKIE);
  if (cookie !== undefined && tokensEqual(cookie, sessionCookieValue(token))) return true;
  const presented = tokenFromUrl(request.url);
  return presented !== undefined && tokensEqual(presented, token);
}

/** `url` with its `token` query parameter removed — where the browser is sent after the token has been traded for a cookie, so it never lingers in the address bar, history or a `Referer`. */
export function urlWithoutToken(url: string): string {
  const parsed = new URL(url, 'http://localhost');
  parsed.searchParams.delete('token');
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** The path-and-query that signs a browser in — `/?token=…` — or `''` when there is no token (a password is the secret instead). Appended to the dashboard's origin wherever Detour prints or opens its URL. */
export function tokenLandingPath(token: string | undefined): string {
  return token ? `/?token=${token}` : '';
}
