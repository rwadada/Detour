import { describe, expect, it } from 'vitest';
import type { Rule } from '../domain/rules/types';
import { selectLastMatchingBodyRewriteRule } from './selectBodyRewriteRule';

function rewriteRule(name: string, overrides: { request?: object; response?: object }): Rule {
  return {
    name,
    match: { url: '*' },
    action: { type: 'rewrite', ...overrides },
  };
}

function routeRule(name: string): Rule {
  return { name, match: { url: '*' }, action: { type: 'route', host: 'example.com' } };
}

describe('selectLastMatchingBodyRewriteRule', () => {
  it('returns undefined when nothing matches', () => {
    expect(selectLastMatchingBodyRewriteRule([], 'request')).toBeUndefined();
    expect(selectLastMatchingBodyRewriteRule([routeRule('r1')], 'request')).toBeUndefined();
  });

  it('picks the single matching rule', () => {
    const rule = rewriteRule('only', { request: { body: { set: 'x' } } });
    expect(selectLastMatchingBodyRewriteRule([rule], 'request')).toBe(rule);
  });

  it('picks the LAST matching rule when more than one has a body rewrite, matching "later wins"', () => {
    const first = rewriteRule('first', { request: { body: { set: 'a' } } });
    const second = rewriteRule('second', { request: { body: { set: 'b' } } });
    expect(selectLastMatchingBodyRewriteRule([first, second], 'request')).toBe(second);
  });

  it('ignores a rewrite rule with no body rewrite for the given phase, even if it has other fields', () => {
    const headersOnly = rewriteRule('headers-only', { request: { headers: { set: { 'x-a': '1' } } } });
    const withBody = rewriteRule('with-body', { request: { body: { set: 'x' } } });
    expect(selectLastMatchingBodyRewriteRule([headersOnly, withBody], 'request')).toBe(withBody);
    expect(selectLastMatchingBodyRewriteRule([withBody, headersOnly], 'request')).toBe(withBody);
  });

  it('keeps request and response phases independent', () => {
    const requestOnly = rewriteRule('request-only', { request: { body: { set: 'a' } } });
    const responseOnly = rewriteRule('response-only', { response: { body: { set: 'b' } } });
    expect(selectLastMatchingBodyRewriteRule([requestOnly, responseOnly], 'request')).toBe(requestOnly);
    expect(selectLastMatchingBodyRewriteRule([requestOnly, responseOnly], 'response')).toBe(responseOnly);
  });

  it('ignores non-rewrite rules mixed into the list', () => {
    const rewrite = rewriteRule('rw', { response: { body: { set: 'x' } } });
    expect(selectLastMatchingBodyRewriteRule([routeRule('r'), rewrite], 'response')).toBe(rewrite);
  });
});
