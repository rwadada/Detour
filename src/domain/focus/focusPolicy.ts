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
