import type { Rule } from '../domain/rules/types';

export type RewriteBodyPhase = 'request' | 'response';

/**
 * Of every matching `rewrite` rule with a body rewrite for `phase`, picks
 * the one that actually replaces the body — the *last* one in file order,
 * matching how every other conflicting field (a response status, a header
 * set to the same key) resolves when more than one rule matches (see
 * `RewriteAction`'s doc comment: "the one later in the file wins").
 *
 * Body rewriting can't just apply every matching rule like path/query/
 * headers do: buffering and rewriting the whole body more than once would
 * double-write it to the socket (`applyRequestRewrite`'s
 * `installRequestBodyRewrite` writes directly to the upstream request once
 * the client's body ends, and `installResponseBodyRewrite` does the
 * equivalent on the response side — neither is safe to run twice on the
 * same stream). So exactly one rule's body rewrite applies; this decides
 * which, and nothing else — actually applying it is the caller's job.
 *
 * Pulled out of three near-identical inline loops in `proxyServer.ts`
 * (request-phase, response-phase, and a mock response's own response-phase
 * rewrite) so the selection is unit-tested once instead of copy-pasted —
 * PR #150's review caught a real bug in one of those three copies.
 */
export function selectLastMatchingBodyRewriteRule(rules: readonly Rule[], phase: RewriteBodyPhase): Rule | undefined {
  let selected: Rule | undefined;
  for (const rule of rules) {
    if (rule.action.type !== 'rewrite') continue;
    const target = phase === 'request' ? rule.action.request : rule.action.response;
    if (target?.body) selected = rule;
  }
  return selected;
}
