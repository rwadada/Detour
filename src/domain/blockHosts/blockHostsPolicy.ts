import { matchesAnyHostPattern, normalizeHostPatterns } from '../shared/hostPatternList';

/**
 * How a blocked request is denied — see `BlockHostsState`'s doc comment in
 * `domain/exchange/types.ts`.
 */
export type BlockMode = 'forbidden' | 'reset';

/** Trims/lowercases/dedupes a raw Block Hosts list (see `BlockHostsState`), dropping empty entries. */
export function normalizeBlockHosts(hosts: readonly string[]): string[] {
  return normalizeHostPatterns(hosts);
}

/**
 * Whether `host` (formatted like `focusPolicy.ts`'s `formatHostPort` — a
 * bare hostname, or `host:port` when the port isn't the scheme's default)
 * is denied under the current Block Hosts list. An empty list means Block
 * Hosts is off — nothing is blocked, so this feature is a no-op until the
 * user opts in.
 */
export function isHostBlocked(blockHosts: readonly string[], host: string): boolean {
  if (blockHosts.length === 0) return false;
  return matchesAnyHostPattern(blockHosts, host);
}
