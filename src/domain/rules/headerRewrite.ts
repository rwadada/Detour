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
    headers[name] = value;
  }
}
