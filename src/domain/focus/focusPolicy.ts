import { matchesAnyHostPattern, normalizeHostPatterns } from '../shared/hostPatternList';

/** Formats a host/port pair the same way throughout: `host:port`, unless `port` is the scheme's default, in which case it's omitted. */
export function formatHostPort(host: string, port: number, defaultPort: number): string {
  return port !== defaultPort ? `${host}:${port}` : host;
}

/**
 * Builds the origin-only URL a route rule is matched against for a CONNECT
 * tunnel while intercept is off. There's no path to match on — the tunnel is
 * never decrypted — so this mirrors `resolveUrl`'s hostname formatting
 * (default port omitted) applied to just the host.
 */
export function connectMatchUrl(host: string, port: number): string {
  return `https://${formatHostPort(host, port, 443)}`;
}

/** What a host glob can contain: hostname/IP characters, `:` for a port (or IPv6), `[]` for a bracketed IPv6 literal, and the `*`/`?` wildcards. */
const HOST_PATTERN_CHARS = /^[a-z0-9.\-_*?:[\]]+$/i;

/**
 * Why `pattern` could never match a host (`host` or `host:port`, see
 * `isHostFocused`), or `undefined` when it could. A URL, a path, or two
 * patterns joined by a space or `;` instead of a comma would otherwise be
 * accepted and silently match nothing — so a saved or startup Focus would
 * leave every host undecrypted (issue #301).
 */
export function invalidHostPatternReason(pattern: string): string | undefined {
  const trimmed = pattern.trim();
  if (trimmed === '') return 'it is empty';
  if (trimmed.includes('/')) return 'it is a URL or a path, not a host';
  if (!HOST_PATTERN_CHARS.test(trimmed)) {
    return 'it contains characters a host never has (separate patterns with commas)';
  }
  return undefined;
}

/** Trims/lowercases/dedupes a raw Focus host list (see `FocusState`), dropping empty entries. */
export function normalizeFocusHosts(hosts: readonly string[]): string[] {
  return normalizeHostPatterns(hosts);
}

/**
 * Whether `host` (formatted like `formatHostPort`/`connectMatchUrl` — a bare
 * hostname, or `host:port` when the port isn't the scheme's default) should
 * be MITM-intercepted under the current Focus allowlist. An empty list means
 * Focus is off — every host qualifies, so this feature is a no-op until the
 * user opts in. A pattern with no `:port` (the common case — most sites are
 * reached on their scheme's default port, which is omitted from `host`)
 * matches only that same default-port form; targeting a non-default port
 * needs the pattern to include it (or a trailing `*`).
 */
export function isHostFocused(focusHosts: readonly string[], host: string): boolean {
  if (focusHosts.length === 0) return true;
  return matchesAnyHostPattern(focusHosts, host);
}

/**
 * Whether the user put `host` in Focus on purpose — unlike `isHostFocused`,
 * an empty Focus list ("no restriction") doesn't count. Auto TLS passthrough
 * never overrides this: a host the user asked to intercept stays MITM'd.
 */
export function isHostExplicitlyFocused(focusHosts: readonly string[], host: string): boolean {
  return focusHosts.length > 0 && matchesAnyHostPattern(focusHosts, host);
}
