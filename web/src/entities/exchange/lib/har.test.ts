import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '@/shared/api';
import { exchangesToHar, harToExchanges, parseImportedLog } from './har';

function makeExchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'ex-1',
    method: 'POST',
    url: 'https://api.example.com/widgets?limit=5',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: { 'content-type': 'application/json', 'x-trace': ['a', 'b'] },
    requestBodySize: 13,
    requestBody: btoa('{"name":"x"}'),
    startedAt: 1_700_000_000_000,
    statusCode: 201,
    statusMessage: 'Created',
    responseHeaders: { 'content-type': 'application/json' },
    responseBodySize: 15,
    responseBody: btoa('{"id":"widget"}'),
    finishedAt: 1_700_000_000_120,
    durationMs: 120,
    ruleName: 'mock-widgets',
    ...overrides,
  };
}

describe('exchangesToHar / harToExchanges', () => {
  it('round-trips a full exchange losslessly via the _detour extension', () => {
    const original = makeExchange();
    const har = exchangesToHar([original]);
    const [restored] = harToExchanges(har);

    expect(restored).toEqual(original);
  });

  it('produces standard HAR fields readable without the _detour extension', () => {
    const har = exchangesToHar([makeExchange()]);
    const entry = har.log.entries[0];

    expect(har.log.version).toBe('1.2');
    expect(entry?.request.method).toBe('POST');
    expect(entry?.request.queryString).toEqual([{ name: 'limit', value: '5' }]);
    expect(entry?.request.postData?.text).toBe('{"name":"x"}');
    expect(entry?.response.status).toBe(201);
    expect(entry?.response.content.text).toBe('{"id":"widget"}');
    expect(entry?.response.content.encoding).toBeUndefined();
  });

  it('marks a binary response body as base64-encoded instead of garbling it as text', () => {
    const binary = Uint8Array.from([0x00, 0x01, 0xff, 0xfe, 0x10]);
    const base64 = btoa(String.fromCharCode(...binary));
    const har = exchangesToHar([makeExchange({ responseBody: base64, responseBodySize: binary.length })]);
    const entry = har.log.entries[0];

    expect(entry?.response.content.encoding).toBe('base64');
    expect(entry?.response.content.text).toBe(base64);
  });

  it('reconstructs exchanges from a foreign HAR file with no _detour extension', () => {
    const har = {
      log: {
        version: '1.2' as const,
        creator: { name: 'Chrome DevTools', version: '1' },
        entries: [
          {
            startedDateTime: '2024-01-01T00:00:00.000Z',
            time: 42,
            request: {
              method: 'GET',
              url: 'https://example.com/foo',
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: [{ name: 'accept', value: '*/*' }],
              queryString: [],
              headersSize: -1 as const,
              bodySize: 0,
            },
            response: {
              status: 200,
              statusText: 'OK',
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: [{ name: 'content-type', value: 'text/plain' }],
              content: { size: 2, mimeType: 'text/plain', text: 'ok' },
              redirectURL: '',
              headersSize: -1 as const,
              bodySize: 2,
            },
            cache: {},
            timings: { send: 0, wait: 42, receive: 0 },
          },
        ],
      },
    };

    const exchange = harToExchanges(har)[0];
    expect(exchange?.method).toBe('GET');
    expect(exchange?.url).toBe('https://example.com/foo');
    expect(exchange?.host).toBe('example.com');
    expect(exchange?.statusCode).toBe(200);
    expect(atob(exchange?.responseBody ?? '')).toBe('ok');
    expect(exchange?.id).toBeTruthy();
  });
});

describe('parseImportedLog', () => {
  it('parses a native Detour JSON export (array of exchanges)', () => {
    const original = [makeExchange()];
    const result = parseImportedLog(JSON.stringify(original));
    expect(result).toEqual(original);
  });

  it('parses a HAR 1.2 document', () => {
    const har = exchangesToHar([makeExchange()]);
    const result = parseImportedLog(JSON.stringify(har));
    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe('https://api.example.com/widgets?limit=5');
  });

  it('throws a friendly error on invalid JSON', () => {
    expect(() => parseImportedLog('not json')).toThrow(/parse/i);
  });

  it('throws a friendly error on unrecognized JSON shapes', () => {
    expect(() => parseImportedLog(JSON.stringify({ hello: 'world' }))).toThrow(/unrecognized/i);
  });
});
