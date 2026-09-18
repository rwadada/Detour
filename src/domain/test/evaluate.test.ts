import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '../exchange/types';
import { evaluateAssertions } from './evaluate';
import type { HeaderPresentAssertion, LatencyP95Assertion, NoPiiLeakAssertion } from './types';

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: overrides.id ?? 'ex-1',
    method: 'GET',
    url: 'https://api.example.com/orders',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    startedAt: 0,
    responseBodySize: 0,
    ...overrides,
  };
}

describe('evaluateAssertions — headerPresent', () => {
  const assertion: HeaderPresentAssertion = {
    type: 'headerPresent',
    name: 'requires auth',
    match: { url: 'https://api.example.com/*' },
    header: 'Authorization',
  };

  it('passes when every matching exchange carries the header', () => {
    const [result] = evaluateAssertions([assertion], [exchange({ requestHeaders: { authorization: 'Bearer x' } })]);
    expect(result).toMatchObject({ passed: true, matchedCount: 1, failures: [] });
  });

  it('fails, naming the offending exchange, when a matching exchange lacks the header', () => {
    const [result] = evaluateAssertions([assertion], [exchange({ requestHeaders: {} })]);
    expect(result!.passed).toBe(false);
    expect(result!.failures).toEqual([
      {
        exchangeId: 'ex-1',
        method: 'GET',
        url: 'https://api.example.com/orders',
        reason: 'missing "Authorization" request header',
      },
    ]);
  });

  it('checks response headers instead when phase is "response"', () => {
    const responseAssertion: HeaderPresentAssertion = { ...assertion, phase: 'response' };
    const [result] = evaluateAssertions(
      [responseAssertion],
      [exchange({ responseHeaders: { 'x-request-id': 'abc' } })],
    );
    expect(result!.passed).toBe(false);
    expect(result!.failures[0]!.reason).toBe('missing "Authorization" response header');
  });

  it('reports no response was captured at all, distinctly from a present-but-missing header', () => {
    const responseAssertion: HeaderPresentAssertion = { ...assertion, phase: 'response' };
    const [result] = evaluateAssertions([responseAssertion], [exchange({ responseHeaders: undefined })]);
    expect(result!.failures[0]!.reason).toBe('no response was captured for this exchange');
  });

  it('fails with zero matches by default — a typo in `match` should not silently pass', () => {
    const [result] = evaluateAssertions([assertion], [exchange({ url: 'https://other.example.com/x' })]);
    expect(result).toMatchObject({ passed: false, matchedCount: 0 });
  });

  it('passes with zero matches when allowNoMatches is set', () => {
    const lenient: HeaderPresentAssertion = { ...assertion, allowNoMatches: true };
    const [result] = evaluateAssertions([lenient], [exchange({ url: 'https://other.example.com/x' })]);
    expect(result).toMatchObject({ passed: true, matchedCount: 0 });
  });

  it('excludes passthrough exchanges from matching', () => {
    const [result] = evaluateAssertions([assertion], [exchange({ passthrough: true })]);
    expect(result).toMatchObject({ matchedCount: 0 });
  });

  it('filters by method when match.method is set', () => {
    const postOnly: HeaderPresentAssertion = { ...assertion, match: { ...assertion.match, method: 'POST' } };
    const [result] = evaluateAssertions([postOnly], [exchange({ method: 'GET' })]);
    expect(result).toMatchObject({ matchedCount: 0 });
  });
});

describe('evaluateAssertions — latencyP95', () => {
  const assertion: LatencyP95Assertion = {
    type: 'latencyP95',
    name: 'orders API is fast',
    match: { url: 'https://api.example.com/*' },
    maxMs: 200,
  };

  it('passes when the computed p95 is at or under maxMs', () => {
    const exchanges = [10, 20, 30, 40, 190].map((durationMs) => exchange({ durationMs }));
    const [result] = evaluateAssertions([assertion], exchanges);
    expect(result).toMatchObject({ passed: true, matchedCount: 5, p95Ms: 190 });
  });

  it('fails when the computed p95 exceeds maxMs, reporting the value', () => {
    const exchanges = [10, 20, 30, 40, 500].map((durationMs) => exchange({ durationMs }));
    const [result] = evaluateAssertions([assertion], exchanges);
    expect(result!.passed).toBe(false);
    expect(result!.p95Ms).toBe(500);
    expect(result!.failures[0]!.reason).toContain('p95 latency 500ms exceeds 200ms');
  });

  it('fails with zero matches by default', () => {
    const [result] = evaluateAssertions([assertion], []);
    expect(result).toMatchObject({ passed: false, matchedCount: 0 });
  });

  it('ignores exchanges with no recorded durationMs', () => {
    const [result] = evaluateAssertions([assertion], [exchange({ durationMs: undefined })]);
    expect(result).toMatchObject({ passed: true, matchedCount: 1 });
    expect(result!.p95Ms).toBeUndefined();
  });
});

describe('evaluateAssertions — noPiiLeak', () => {
  const assertion: NoPiiLeakAssertion = {
    type: 'noPiiLeak',
    name: 'no PII leaves to third parties',
    match: { url: 'https://ads.example.net/*' },
    patterns: ['email'],
  };

  it('passes vacuously when nothing matched', () => {
    const [result] = evaluateAssertions([assertion], []);
    expect(result).toMatchObject({ passed: true, matchedCount: 0 });
  });

  it('passes when no PII-shaped value appears in headers or body', () => {
    const [result] = evaluateAssertions(
      [assertion],
      [exchange({ url: 'https://ads.example.net/track', requestHeaders: { 'x-id': 'abc123' } })],
    );
    expect(result).toMatchObject({ passed: true });
  });

  it('fails, naming the field but never the matched value, when an email appears in a request header', () => {
    const [result] = evaluateAssertions(
      [assertion],
      [exchange({ url: 'https://ads.example.net/track', requestHeaders: { 'x-user': 'person@example.com' } })],
    );
    expect(result!.passed).toBe(false);
    expect(result!.failures[0]!.reason).toBe('request header "x-user" looks like it contains a email');
    expect(result!.failures[0]!.reason).not.toContain('person@example.com');
  });

  it('scans the decoded request/response body too', () => {
    const body = Buffer.from('contact: person@example.com').toString('base64');
    const [result] = evaluateAssertions(
      [assertion],
      [exchange({ url: 'https://ads.example.net/track', requestBody: body })],
    );
    expect(result!.passed).toBe(false);
    expect(result!.failures[0]!.reason).toBe('request body looks like it contains a email');
  });

  it('detects a custom regex pattern', () => {
    const withCustom: NoPiiLeakAssertion = { ...assertion, patterns: undefined, customPatterns: ['internal-\\d+'] };
    const [result] = evaluateAssertions(
      [withCustom],
      [exchange({ url: 'https://ads.example.net/track', requestHeaders: { 'x-ref': 'internal-42' } })],
    );
    expect(result!.passed).toBe(false);
    expect(result!.failures[0]!.reason).toContain('custom pattern');
  });

  it('applies more than one custom pattern (regression: patterns must not be recompiled away between fields)', () => {
    const withCustom: NoPiiLeakAssertion = {
      ...assertion,
      patterns: undefined,
      customPatterns: ['internal-\\d+', 'external-\\d+'],
    };
    const [result] = evaluateAssertions(
      [withCustom],
      [
        exchange({
          id: 'ex-a',
          url: 'https://ads.example.net/track',
          requestHeaders: { 'x-ref': 'internal-1' },
        }),
        exchange({
          id: 'ex-b',
          url: 'https://ads.example.net/track',
          requestHeaders: { 'x-ref': 'external-2' },
        }),
      ],
    );
    expect(result!.failures).toHaveLength(2);
  });

  it("fails on a truncated request body even when the captured portion has no PII (can't confirm what was cut off)", () => {
    const [result] = evaluateAssertions(
      [assertion],
      [
        exchange({
          url: 'https://ads.example.net/track',
          requestBody: Buffer.from('no pii here').toString('base64'),
          requestBodyTruncated: true,
        }),
      ],
    );
    expect(result!.passed).toBe(false);
    expect(result!.failures).toEqual([
      {
        exchangeId: 'ex-1',
        method: 'GET',
        url: 'https://ads.example.net/track',
        reason: 'request body was truncated at the capture cap — cannot confirm it contains no PII beyond that point',
      },
    ]);
  });

  it('fails on a truncated response body the same way', () => {
    const [result] = evaluateAssertions(
      [assertion],
      [exchange({ url: 'https://ads.example.net/track', responseBodyTruncated: true })],
    );
    expect(result!.passed).toBe(false);
    expect(result!.failures[0]!.reason).toContain('response body was truncated');
  });

  it('does not flag truncation when the body was fully captured', () => {
    const [result] = evaluateAssertions(
      [assertion],
      [exchange({ url: 'https://ads.example.net/track', requestBodyTruncated: false, responseBodyTruncated: false })],
    );
    expect(result).toMatchObject({ passed: true });
  });
});
