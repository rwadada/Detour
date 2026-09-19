import { describe, expect, it } from 'vitest';
import type { MockResponse } from '../domain/rules/mockResponse';
import type { Rule } from '../domain/rules/types';
import { applyResponseRewritesToMock } from './applyResponseRewritesToMock';

function mockResponse(overrides: Partial<MockResponse> = {}): MockResponse {
  return { status: 200, headers: {}, body: Buffer.from('original'), ...overrides };
}

function rewriteRule(name: string, response: object): Rule {
  return { name, match: { url: '*' }, action: { type: 'rewrite', response } };
}

describe('applyResponseRewritesToMock', () => {
  it('applies a matching rewrite rule to a mock response — the PR #150 bug: a mock never streams through onResponseHeaders/onResponse, so without this a matching rewrite silently never took effect', () => {
    const mock = mockResponse();
    const rule = rewriteRule('add-header', { headers: { set: { 'x-rewritten': 'yes' } } });
    applyResponseRewritesToMock(mock, [rule]);
    expect(mock.headers['x-rewritten']).toBe('yes');
  });

  it('overrides the mock status when a rewrite sets one', () => {
    const mock = mockResponse({ status: 200 });
    applyResponseRewritesToMock(mock, [rewriteRule('r', { status: 201 })]);
    expect(mock.status).toBe(201);
  });

  it('stacks every matching header rewrite, unlike body which only takes the last', () => {
    const mock = mockResponse();
    applyResponseRewritesToMock(mock, [
      rewriteRule('r1', { headers: { set: { 'x-a': '1' } } }),
      rewriteRule('r2', { headers: { set: { 'x-b': '2' } } }),
    ]);
    expect(mock.headers['x-a']).toBe('1');
    expect(mock.headers['x-b']).toBe('2');
  });

  it('applies only the LAST matching body rewrite and drops a now-stale content-length', () => {
    const mock = mockResponse({ body: Buffer.from('original'), headers: { 'content-length': '8' } });
    applyResponseRewritesToMock(mock, [
      rewriteRule('first', { body: { set: 'first-replacement' } }),
      rewriteRule('second', { body: { set: 'second-replacement' } }),
    ]);
    expect(mock.body.toString('utf8')).toBe('second-replacement');
    expect(mock.headers['content-length']).toBeUndefined();
  });

  it('leaves the mock untouched when nothing matches', () => {
    const mock = mockResponse({ status: 200, body: Buffer.from('x') });
    const routeRule: Rule = { name: 'r', match: { url: '*' }, action: { type: 'route', host: 'example.com' } };
    applyResponseRewritesToMock(mock, [routeRule]);
    expect(mock.status).toBe(200);
    expect(mock.body.toString('utf8')).toBe('x');
  });

  it('leaves content-length alone when no body rewrite applies, even with a header rewrite present', () => {
    const mock = mockResponse({ headers: { 'content-length': '8' } });
    applyResponseRewritesToMock(mock, [rewriteRule('r', { headers: { set: { 'x-a': '1' } } })]);
    expect(mock.headers['content-length']).toBe('8');
  });
});
