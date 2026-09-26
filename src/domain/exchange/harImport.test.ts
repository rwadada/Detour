import { describe, expect, it } from 'vitest';
import { parseHarLog } from './harImport';

function harLog(entries: unknown[]): string {
  return JSON.stringify({ log: { version: '1.2', creator: { name: 'x', version: '1' }, entries } });
}

function foreignEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startedDateTime: '2024-01-01T00:00:00.000Z',
    time: 42,
    request: {
      method: 'GET',
      url: 'https://api.example.com/orders/1?x=1',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Accept', value: '*/*' }],
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      content: { text: '{"id":1}', mimeType: 'application/json' },
      bodySize: 8,
    },
    ...overrides,
  };
}

describe('parseHarLog', () => {
  it('parses a foreign (non-Detour) HAR entry into a CapturedExchange', () => {
    const [exchange] = parseHarLog(harLog([foreignEntry()]));
    expect(exchange).toMatchObject({
      method: 'GET',
      url: 'https://api.example.com/orders/1?x=1',
      host: 'api.example.com',
      isSSL: true,
      protocol: 'HTTP/1.1',
      statusCode: 200,
      statusMessage: 'OK',
    });
    expect(exchange?.requestHeaders.accept).toBe('*/*');
    expect(exchange?.responseHeaders?.['content-type']).toBe('application/json');
    expect(Buffer.from(exchange?.responseBody ?? '', 'base64').toString('utf8')).toBe('{"id":1}');
  });

  it('merges repeated header names (e.g. multiple Set-Cookie) into a string[] instead of overwriting', () => {
    const [exchange] = parseHarLog(
      harLog([
        foreignEntry({
          response: {
            status: 200,
            headers: [
              { name: 'Set-Cookie', value: 'a=1' },
              { name: 'Set-Cookie', value: 'b=2' },
              { name: 'Set-Cookie', value: 'c=3' },
            ],
          },
        }),
      ]),
    );
    expect(exchange?.responseHeaders?.['set-cookie']).toEqual(['a=1', 'b=2', 'c=3']);
  });

  it('decodes a plain-text request body from postData', () => {
    const [exchange] = parseHarLog(
      harLog([
        foreignEntry({
          request: {
            method: 'POST',
            url: 'https://api.example.com/orders',
            postData: { text: '{"name":"widget"}' },
          },
        }),
      ]),
    );
    expect(Buffer.from(exchange?.requestBody ?? '', 'base64').toString('utf8')).toBe('{"name":"widget"}');
  });

  it('falls back to an empty host for a URL too malformed to parse', () => {
    const [exchange] = parseHarLog(harLog([foreignEntry({ request: { method: 'GET', url: 'not a url' } })]));
    expect(exchange?.host).toBe('');
  });

  it('decodes a base64-marked response body without re-encoding it', () => {
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    const [exchange] = parseHarLog(
      harLog([
        foreignEntry({
          response: {
            status: 200,
            content: { text: binary.toString('base64'), encoding: 'base64', mimeType: 'application/octet-stream' },
          },
        }),
      ]),
    );
    expect(Buffer.from(exchange?.responseBody ?? '', 'base64')).toEqual(binary);
  });

  it('prefers the _detour extension over the standard fields, when present', () => {
    const [exchange] = parseHarLog(
      harLog([
        foreignEntry({
          _detour: {
            id: 'ex-42',
            host: 'internal.example.com',
            isSSL: false,
            protocol: 'HTTP/2',
            statusMessage: 'Created',
            responseBodyBase64: Buffer.from('exact bytes').toString('base64'),
          },
        }),
      ]),
    );
    expect(exchange?.id).toBe('ex-42');
    expect(exchange?.host).toBe('internal.example.com');
    expect(exchange?.isSSL).toBe(false);
    expect(exchange?.protocol).toBe('HTTP/2');
    expect(exchange?.statusMessage).toBe('Created');
    expect(Buffer.from(exchange?.responseBody ?? '', 'base64').toString('utf8')).toBe('exact bytes');
  });

  it('generates unique ids for entries without a _detour extension', () => {
    const exchanges = parseHarLog(harLog([foreignEntry(), foreignEntry()]));
    expect(exchanges[0]?.id).not.toBe(exchanges[1]?.id);
  });

  it('parses multiple entries in order', () => {
    const exchanges = parseHarLog(
      harLog([
        foreignEntry({ request: { method: 'GET', url: 'https://api.example.com/a' } }),
        foreignEntry({ request: { method: 'POST', url: 'https://api.example.com/b' } }),
      ]),
    );
    expect(exchanges.map((e) => e.url)).toEqual(['https://api.example.com/a', 'https://api.example.com/b']);
  });

  it('throws a descriptive error on invalid JSON', () => {
    expect(() => parseHarLog('not json')).toThrow(/Couldn't parse as JSON/);
  });

  it('throws a descriptive error on a document that is not HAR-shaped', () => {
    expect(() => parseHarLog(JSON.stringify({ hello: 'world' }))).toThrow(/Not a HAR 1\.2 document/);
  });

  it('throws a descriptive error (not a bare TypeError) on an entry missing request.method', () => {
    expect(() => parseHarLog(harLog([foreignEntry({ request: { url: 'https://api.example.com/x' } })]))).toThrow(
      /HAR entry #0.*request\.method/,
    );
  });

  it('throws a descriptive error on an entry with an empty request.url', () => {
    expect(() => parseHarLog(harLog([foreignEntry({ request: { method: 'GET', url: '' } })]))).toThrow(
      /HAR entry #0.*request\.url/,
    );
  });

  it('throws a descriptive error on an entry missing response.status', () => {
    expect(() => parseHarLog(harLog([foreignEntry({ response: {} })]))).toThrow(/HAR entry #0.*response\.status/);
  });

  it('returns an empty array for a HAR with no entries', () => {
    expect(parseHarLog(harLog([]))).toEqual([]);
  });
});
