import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '@/shared/api';
import { compileFilterQuery } from './filterExpression';

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'e',
    method: 'GET',
    url: 'https://api.example.com/v1/users?id=7',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: { accept: 'application/json', authorization: 'Bearer abc' },
    requestBodySize: 0,
    startedAt: 0,
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json; charset=utf-8' },
    responseBodySize: 2048,
    durationMs: 120,
    ...overrides,
  };
}

const matches = (query: string, e: CapturedExchange = exchange()) => compileFilterQuery(query)(e);

describe('compileFilterQuery', () => {
  describe('plain text (backwards compatible URL search)', () => {
    it('matches everything for an empty or blank query', () => {
      expect(matches('')).toBe(true);
      expect(matches('   ')).toBe(true);
    });

    it('is a case-insensitive URL substring match', () => {
      expect(matches('API.example')).toBe(true);
      expect(matches('nope')).toBe(false);
    });

    it('keeps spaces inside a plain query as part of the substring, as before', () => {
      const e = exchange({ url: 'http://x.test/a b' });
      expect(matches('a b', e)).toBe(true);
      expect(matches('a c', e)).toBe(false);
    });

    it('does not mistake a URL or host:port for an expression', () => {
      expect(matches('https://api.example.com/v1')).toBe(true);
      expect(matches('localhost:3000', exchange({ url: 'http://localhost:3000/x' }))).toBe(true);
    });
  });

  describe('keys', () => {
    it('status: exact code, class, and comparison', () => {
      const e = exchange({ statusCode: 404 });
      expect(matches('status:404', e)).toBe(true);
      expect(matches('status:4xx', e)).toBe(true);
      expect(matches('status:5xx', e)).toBe(false);
      expect(matches('status:>=400', e)).toBe(true);
      expect(matches('status:<400', e)).toBe(false);
    });

    it('status: never matches a pending exchange', () => {
      const pending = exchange({ statusCode: undefined });
      expect(matches('status:4xx', pending)).toBe(false);
      expect(matches('-status:4xx', pending)).toBe(true);
    });

    it('host: and method: and url:', () => {
      expect(matches('host:example.com')).toBe(true);
      expect(matches('host:other.com')).toBe(false);
      expect(matches('method:get')).toBe(true);
      expect(matches('method:GE')).toBe(false); // exact, unlike host/url
      expect(matches('url:/v1/users')).toBe(true);
    });

    it('type: matches the response Content-Type', () => {
      expect(matches('type:json')).toBe(true);
      expect(matches('type:html')).toBe(false);
    });

    it('header: presence, value, and the request/response variants', () => {
      expect(matches('header:authorization')).toBe(true);
      expect(matches('header:Authorization=bearer')).toBe(true);
      expect(matches('header:authorization=basic')).toBe(false);
      expect(matches('header:x-missing')).toBe(false);
      expect(matches('reqheader:content-type')).toBe(false);
      expect(matches('resheader:content-type=utf-8')).toBe(true);
      expect(matches('header:set-cookie', exchange({ responseHeaders: { 'set-cookie': ['a=1', 'b=2'] } }))).toBe(true);
    });

    it('body: searches decoded request and response bodies, UTF-8 aware', () => {
      const e = exchange({ requestBody: b64('{"q":"検索"}'), responseBody: b64('{"error_code":42}') });
      expect(matches('body:error_code', e)).toBe(true);
      expect(matches('resbody:error_code', e)).toBe(true);
      expect(matches('reqbody:error_code', e)).toBe(false);
      expect(matches('reqbody:検索', e)).toBe(true);
      expect(matches('body:error_code', exchange())).toBe(false); // no captured body
    });

    it('duration: and size: comparisons, size with units', () => {
      expect(matches('duration:>100')).toBe(true);
      expect(matches('duration:>1000')).toBe(false);
      expect(matches('duration:>1000', exchange({ durationMs: undefined }))).toBe(false);
      expect(matches('size:>=2kb')).toBe(true);
      expect(matches('size:<1k')).toBe(false);
      expect(matches('size:2048')).toBe(true);
    });

    it('process:, rule: and proto:', () => {
      const e = exchange({ clientProcess: { pid: 1, name: 'Safari' }, ruleName: 'mock-users', protocol: 'HTTP/2' });
      expect(matches('process:safari', e)).toBe(true);
      expect(matches('rule:mock', e)).toBe(true);
      expect(matches('proto:http2', e)).toBe(true);
      expect(matches('proto:2', e)).toBe(true);
      expect(matches('proto:http1', e)).toBe(false);
    });
  });

  describe('combining terms', () => {
    it('ANDs terms, and mixes them with plain words', () => {
      expect(matches('status:2xx host:example users')).toBe(true);
      expect(matches('status:2xx host:example orders')).toBe(false);
    });

    it('negates a term with a leading -', () => {
      expect(matches('-method:OPTIONS')).toBe(true);
      expect(matches('-method:GET')).toBe(false);
      expect(matches('status:2xx -header:x-missing')).toBe(true);
    });

    it('keeps a quoted value together', () => {
      const e = exchange({ responseBody: b64('hello big world') });
      expect(matches('body:"big world"', e)).toBe(true);
      expect(matches('body:"big  world"', e)).toBe(false);
    });
  });

  describe('forgiving input', () => {
    it('ignores a key with no value yet (still typing)', () => {
      expect(matches('status:')).toBe(true);
      expect(matches('status: host:example')).toBe(true);
    });

    it('falls back to literal URL text for an unusable value', () => {
      expect(matches('duration:abc')).toBe(false);
      expect(matches('duration:abc', exchange({ url: 'http://x/duration:abc' }))).toBe(true);
    });

    it('treats unknown keys as plain text', () => {
      expect(matches('foo:bar', exchange({ url: 'http://x/?foo:bar' }))).toBe(true);
      expect(matches('foo:bar')).toBe(false);
    });
  });
});
