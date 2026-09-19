import { deleteHeader } from '../domain/exchange/headers';
import { applyBodyRewrite } from '../domain/rules/bodyRewrite';
import { applyHeaderRewrite } from '../domain/rules/headerRewrite';
import type { MockResponse } from '../domain/rules/mockResponse';
import type { Rule } from '../domain/rules/types';
import { selectLastMatchingBodyRewriteRule } from './selectBodyRewriteRule';

/**
 * Applies every matching `rewrite` rule's `response` changes to a `mock`
 * action's already-built response — status, headers (every matching rule
 * stacks), and body (only the last matching rule, like the real upstream
 * response path — see `selectLastMatchingBodyRewriteRule`'s doc comment).
 *
 * A mock's response never streams through `onResponseHeaders`/`onResponse`
 * (it's synthesized directly, not fetched from upstream), so without this a
 * matching `rewrite` rule's response-side changes would silently never take
 * effect on a mocked exchange even though the dashboard's joined rule-name
 * badge implies they did (this was a real bug — PR #150's review). Unlike
 * threading a body rewrite into a breakpoint/script hook (deliberately not
 * done, per `proxyServer.ts`'s `onResponse`), there's no double-consumption
 * risk here: `mock` is a plain, fully-resolved buffer, not a live stream.
 *
 * Mutates and returns the same `mock` object (matching `applyHeaderRewrite`'s
 * own in-place convention) rather than cloning — call sites hold onto the
 * same reference throughout, and rewriting is one-shot per mocked exchange.
 */
export function applyResponseRewritesToMock(mock: MockResponse, rewrites: readonly Rule[]): MockResponse {
  for (const rule of rewrites) {
    if (rule.action.type !== 'rewrite' || !rule.action.response) continue;
    if (rule.action.response.status !== undefined) mock.status = rule.action.response.status;
    applyHeaderRewrite(mock.headers, rule.action.response.headers);
  }

  const responseBodyRewriteRule = selectLastMatchingBodyRewriteRule(rewrites, 'response');
  if (responseBodyRewriteRule && responseBodyRewriteRule.action.type === 'rewrite') {
    mock.body = applyBodyRewrite(mock.body, responseBodyRewriteRule.action.response!.body!);
    // The mock was built with Content-Length set from its *original* body —
    // stale now, and left in place would frame the response wrong (the
    // client parses exactly that many bytes as this response, corrupting
    // whatever follows on a kept-alive connection). The caller's own
    // writeHead/end recomputes it (or goes chunked).
    deleteHeader(mock.headers, 'content-length');
  }

  return mock;
}
