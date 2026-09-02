import type { QueryRewrite } from './types';

/**
 * Rewrites a request's outgoing query string in place, on `opts.path`
 * (which http-mitm-proxy populates with the path *and* query together,
 * e.g. `/users/1?x=2`). `remove` runs before `set`, matching
 * `applyHeaderRewrite`'s ordering. Pure — takes a plain `{path}` holder
 * rather than an `IContext`, so it has no transport dependency.
 */
export function applyQueryRewrite(opts: { path?: string }, rewrite?: QueryRewrite): void {
  if (!rewrite) return;
  const path = opts.path ?? '/';
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : path.slice(queryIndex + 1));
  for (const name of rewrite.remove ?? []) {
    params.delete(name);
  }
  for (const [name, value] of Object.entries(rewrite.set ?? {})) {
    params.set(name, value);
  }
  const search = params.toString();
  opts.path = search ? `${pathname}?${search}` : pathname;
}
