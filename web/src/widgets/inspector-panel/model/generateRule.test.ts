import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '@/shared/api';
import { generateRuleFromExchange } from './generateRule';

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'x1',
    method: 'GET',
    url: 'https://api.example.com/users/123',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 0,
    ...overrides,
  };
}

describe('generateRuleFromExchange', () => {
  it('matches the exact method and URL, never a generalized wildcard', () => {
    const rule = generateRuleFromExchange(
      exchange({ method: 'POST', url: 'https://api.example.com/users/123' }),
      'mock',
    );
    expect(rule.match).toEqual({ method: 'POST', url: 'https://api.example.com/users/123' });
  });

  it("names the rule from the type and the URL's hostname", () => {
    const rule = generateRuleFromExchange(exchange({ url: 'https://api.example.com/users/123' }), 'route');
    expect(rule.name).toBe('route-api-example-com');
  });

  it("falls back to the exchange's own host when the URL fails to parse", () => {
    // Not realistically reachable (CapturedExchange.url is always a real
    // fully-qualified URL in practice), but nameFor() guards against it
    // rather than throwing regardless.
    const rule = generateRuleFromExchange(exchange({ url: 'not a url', host: 'fallback.example.com' }), 'breakpoint');
    expect(rule.name).toBe('breakpoint-fallback-example-com');
  });

  it('is enabled by default', () => {
    const rule = generateRuleFromExchange(exchange(), 'mock');
    expect(rule.enabled).toBe(true);
  });

  describe('mock', () => {
    it('freezes the captured status, statusMessage, and JSON body', () => {
      const rule = generateRuleFromExchange(
        exchange({
          statusCode: 201,
          statusMessage: 'Created',
          responseBody: btoa(JSON.stringify({ id: 1, name: 'Ada' })),
        }),
        'mock',
      );
      expect(rule.action).toEqual({
        type: 'mock',
        status: 201,
        statusMessage: 'Created',
        headers: undefined,
        body: { id: 1, name: 'Ada' },
      });
    });

    it('keeps a non-JSON text body as a plain string', () => {
      const rule = generateRuleFromExchange(exchange({ responseBody: btoa('plain text') }), 'mock');
      expect((rule.action as { body?: unknown }).body).toBe('plain text');
    });

    it('leaves body unset when none was captured', () => {
      const rule = generateRuleFromExchange(exchange({ responseBody: undefined }), 'mock');
      expect((rule.action as { body?: unknown }).body).toBeUndefined();
    });

    it('defaults status to 200 when none was captured (still in flight, say)', () => {
      const rule = generateRuleFromExchange(exchange({ statusCode: undefined }), 'mock');
      expect((rule.action as { status: number }).status).toBe(200);
    });

    it('carries over response headers, dropping transport-only ones', () => {
      const rule = generateRuleFromExchange(
        exchange({
          responseHeaders: {
            'content-type': 'application/json',
            'x-custom': 'value',
            'content-length': '42',
            'set-cookie': 'session=abc',
            date: 'Mon, 01 Jan 2024 00:00:00 GMT',
          },
        }),
        'mock',
      );
      expect((rule.action as { headers?: Record<string, string> }).headers).toEqual({
        'content-type': 'application/json',
        'x-custom': 'value',
      });
    });

    it('joins a multi-value response header with a comma', () => {
      const rule = generateRuleFromExchange(exchange({ responseHeaders: { 'x-multi': ['a', 'b'] } }), 'mock');
      expect((rule.action as { headers?: Record<string, string> }).headers).toEqual({ 'x-multi': 'a, b' });
    });
  });

  it('route starts with a blank host to fill in', () => {
    const rule = generateRuleFromExchange(exchange(), 'route');
    expect(rule.action).toEqual({ type: 'route', host: '' });
  });

  it('rewrite starts blank — no default transform to guess', () => {
    const rule = generateRuleFromExchange(exchange(), 'rewrite');
    expect(rule.action).toEqual({ type: 'rewrite' });
  });

  it('breakpoint starts blank', () => {
    const rule = generateRuleFromExchange(exchange(), 'breakpoint');
    expect(rule.action).toEqual({ type: 'breakpoint' });
  });
});
