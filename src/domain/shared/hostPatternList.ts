import { compileGlob } from '../rules/matcher';

/**
 * Shared building blocks for a `*`/`?` glob host-pattern list — the shape
 * both Focus's allowlist (`domain/focus/focusPolicy.ts`) and Block Hosts'
 * denylist (`domain/blockHosts/blockHostsPolicy.ts`) keep, normalize, and
 * match against a request's host the same way. Each policy wraps these with
 * its own empty-list default (Focus: unrestricted; Block Hosts: nothing
 * blocked).
 */

/** Trims/lowercases/dedupes a raw host pattern list, dropping empty entries. */
export function normalizeHostPatterns(hosts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hosts) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Whether `host` (a bare hostname, or `host:port` when the port isn't the
 * scheme's default) matches any of `patterns` (`*`/`?` globs), case-insensitively.
 */
export function matchesAnyHostPattern(patterns: readonly string[], host: string): boolean {
  const target = host.toLowerCase();
  return patterns.some((pattern) => compileGlob(pattern).test(target));
}
