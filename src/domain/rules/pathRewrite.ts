import type { PathRewrite } from './types';

/**
 * Rewrites a request's outgoing path — not its query string — in place, on
 * `opts.path` (which ProxyEngine populates with the path *and* query
 * together, e.g. `/users/1?x=2`). `set` (if present) replaces the pathname
 * outright and skips `replace`; otherwise each `replace` step runs in
 * sequence, same find/replace semantics as `applyBodyRewrite`'s `replace`
 * step (regex supported via `regex`/`flags`, so capture groups like `$1`
 * work in `replacement`). Whatever query string is already on `opts.path`
 * is preserved untouched. Pure — takes a plain `{path}` holder rather than
 * an `IContext`, so it has no transport dependency.
 */
export function applyPathRewrite(opts: { path?: string }, rewrite?: PathRewrite): void {
  if (!rewrite) return;
  const path = opts.path ?? '/';
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const search = queryIndex === -1 ? '' : path.slice(queryIndex);
  let rewritten = pathname;
  if (rewrite.set !== undefined) {
    rewritten = rewrite.set;
  } else {
    for (const step of rewrite.replace ?? []) {
      rewritten = step.regex
        ? rewritten.replace(new RegExp(step.find, step.flags ?? 'g'), step.replacement)
        : rewritten.split(step.find).join(step.replacement);
    }
  }
  opts.path = `${rewritten}${search}`;
}
