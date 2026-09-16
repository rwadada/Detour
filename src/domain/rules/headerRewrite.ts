import type { HeaderRewrite } from './types';

/**
 * Adds/removes headers on a plain header map. `set` is applied after
 * `remove`, matching `HeaderRewrite`'s doc comment. Pure — the caller is
 * responsible for applying the mutated map to whatever transport object
 * (a `ProxyEngine` `IContext`, etc.) actually holds it.
 */
export function applyHeaderRewrite(
  headers: Record<string, string | string[] | undefined>,
  rewrite?: HeaderRewrite,
): void {
  if (!rewrite) return;
  for (const name of rewrite.remove ?? []) {
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    }
  }
  for (const [name, value] of Object.entries(rewrite.set ?? {})) {
    // Case-insensitive, matching `remove` above and real HTTP semantics
    // (header names aren't case-sensitive). Without this, `set: { 'user-agent': ... }`
    // against a request that already carries `User-Agent` left BOTH keys in the
    // map side by side instead of replacing it — the exchange snapshot (a plain
    // object spread) then showed the rule as a no-op on the dashboard, since the
    // original `User-Agent` entry was still sitting there unchanged next to the
    // new lowercase one a user scanning the header list would easily miss.
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase() && existing !== name) delete headers[existing];
    }
    headers[name] = value;
  }
}
