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

  it('round-trips the upstream certificate (issue #160) via the _detour extension, which HAR has no standard field for', () => {
    const original = makeExchange({
      certificate: {
        subject: 'CN=example.com',
        issuer: 'CN=Example CA',
        validFrom: 'Jan 1 00:00:00 2024 GMT',
        validTo: 'Jan 1 00:00:00 2025 GMT',
        subjectAltName: 'DNS:example.com',
        fingerprint256: 'AA:BB:CC',
        authorized: false,
        authorizationError: 'self signed certificate',
      },
    });
    const har = exchangesToHar([original]);
    const [restored] = harToExchanges(har);

    expect(restored?.certificate).toEqual(original.certificate);
    expect(har.log.entries[0]?._detour?.certificate).toEqual(original.certificate);
  });

  it('round-trips upstreamProtocol (issue #166) via the _detour extension, independent of the client-facing protocol', () => {
    const original = makeExchange({ protocol: 'HTTP/1.1', upstreamProtocol: 'HTTP/2' });
    const har = exchangesToHar([original]);
    const [restored] = harToExchanges(har);

    expect(restored?.upstreamProtocol).toBe('HTTP/2');
    expect(restored?.protocol).toBe('HTTP/1.1');
    expect(har.log.entries[0]?._detour?.upstreamProtocol).toBe('HTTP/2');
  });

  it('round-trips the full DNS/TCP/TLS/TTFB/transfer breakdown (issue #140/#167) via the _detour extension', () => {
    const original = makeExchange({
      timing: { dnsMs: 12, tcpMs: 8, tlsMs: 40, ttfbMs: 150, transferMs: 25, connectionReused: false },
    });
    const har = exchangesToHar([original]);
    const [restored] = harToExchanges(har);

    expect(restored?.timing).toEqual(original.timing);
    expect(har.log.entries[0]?._detour?.timing).toEqual(original.timing);
  });

  it('does not fabricate a timing object for an exchange that genuinely had none', () => {
    // Regression: harEntryToExchange used to fall back to
    // deriveTimingFromHar's approximation whenever `_detour.timing` was
    // undefined, even for a Detour-authored HAR whose `_detour` extension
    // was otherwise present — reconstructing a fake `ttfbMs` from the
    // `wait: durationMs` fallback `harTimingsOf` still writes into the
    // standard `timings` field for other tools' benefit.
    const original = makeExchange({ timing: undefined });
    const har = exchangesToHar([original]);
    const [restored] = harToExchanges(har);

    expect(restored?.timing).toBeUndefined();
  });

  it("sets the standard HAR timings' dns/connect/ssl from a granular breakdown, folding TLS into connect", () => {
    const har = exchangesToHar([
      makeExchange({ timing: { dnsMs: 12, tcpMs: 8, tlsMs: 40, ttfbMs: 150, transferMs: 25 } }),
    ]);
    const { timings } = har.log.entries[0]!;

    expect(timings.dns).toBe(12);
    expect(timings.connect).toBe(48); // tcpMs + tlsMs, per HAR 1.2's "ssl is included in connect"
    expect(timings.ssl).toBe(40);
    expect(timings.wait).toBe(150);
    expect(timings.receive).toBe(25);
  });

  it("derives ExchangeTiming from a foreign HAR's standard timings, recovering tcpMs by subtracting ssl back out of connect", () => {
    const har = {
      log: {
        version: '1.2' as const,
        creator: { name: 'Chrome DevTools', version: '1' },
        entries: [
          {
            startedDateTime: '2024-01-01T00:00:00.000Z',
            time: 200,
            request: {
              method: 'GET',
              url: 'https://example.com/foo',
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: [],
              queryString: [],
              headersSize: -1 as const,
              bodySize: 0,
            },
            response: {
              status: 200,
              statusText: 'OK',
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: [],
              content: { size: 0, mimeType: 'text/plain' },
              redirectURL: '',
              headersSize: -1 as const,
              bodySize: 0,
            },
            cache: {},
            timings: { dns: 5, connect: 45, ssl: 40, send: 1, wait: 149, receive: 0 },
          },
        ],
      },
    };

    const exchange = harToExchanges(har)[0];
    expect(exchange?.timing).toEqual({ dnsMs: 5, tcpMs: 5, tlsMs: 40, ttfbMs: 150, transferMs: 0 });
  });

  it('treats -1 (HAR\'s "not measured" sentinel) the same as an absent timing field', () => {
    const har = {
      log: {
        version: '1.2' as const,
        creator: { name: 'Some Other Tool', version: '1' },
        entries: [
          {
            startedDateTime: '2024-01-01T00:00:00.000Z',
            time: -1,
            request: {
              method: 'GET',
              url: 'https://example.com/foo',
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: [],
              queryString: [],
              headersSize: -1 as const,
              bodySize: 0,
            },
            response: {
              status: 200,
              statusText: 'OK',
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: [],
              content: { size: 0, mimeType: 'text/plain' },
              redirectURL: '',
              headersSize: -1 as const,
              bodySize: 0,
            },
            cache: {},
            timings: { dns: -1, connect: -1, ssl: -1, send: -1, wait: -1, receive: -1 },
          },
        ],
      },
    };

    const exchange = harToExchanges(har)[0];
    expect(exchange?.timing).toBeUndefined();
    expect(exchange?.durationMs).toBeUndefined();
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
