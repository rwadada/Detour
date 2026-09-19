import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '../exchange/types';
import { buildFixtureFromExchange } from './buildFixture';

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'ex-1',
    method: 'GET',
    url: 'https://api.example.com/orders/1?expand=items',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    startedAt: 0,
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json' },
    responseBodySize: 0,
    ...overrides,
  };
}

describe('buildFixtureFromExchange', () => {
  it('extracts the path (with query string) and status from the exchange URL', () => {
    const { fixture } = buildFixtureFromExchange(exchange(), 1);
    expect(fixture.method).toBe('GET');
    expect(fixture.path).toBe('/orders/1?expand=items');
    expect(fixture.status).toBe(200);
  });

  it('carries statusMessage through when present', () => {
    const { fixture } = buildFixtureFromExchange(exchange({ statusMessage: 'OK' }), 1);
    expect(fixture.statusMessage).toBe('OK');
  });

  it('drops hop-by-hop response headers that would be wrong once served by a different server', () => {
    const { fixture } = buildFixtureFromExchange(
      exchange({
        responseHeaders: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'transfer-encoding': 'chunked',
          'content-length': '123',
        },
      }),
      1,
    );
    expect(fixture.responseHeaders).toEqual({ 'content-type': 'application/json' });
  });

  it('drops proxy- and connection-specific headers the proxy engine itself already treats as unsafe to forward', () => {
    const { fixture } = buildFixtureFromExchange(
      exchange({
        responseHeaders: {
          'content-type': 'application/json',
          'proxy-connection': 'keep-alive',
          upgrade: 'websocket',
          'proxy-authenticate': 'Basic',
          'proxy-authorization': 'Basic abc',
          te: 'trailers',
          trailer: 'X-Checksum',
        },
      }),
      1,
    );
    expect(fixture.responseHeaders).toEqual({ 'content-type': 'application/json' });
  });

  it('preserves a multi-value header (e.g. more than one Set-Cookie) as an array instead of comma-joining it', () => {
    const { fixture } = buildFixtureFromExchange(exchange({ responseHeaders: { 'set-cookie': ['a=1', 'b=2'] } }), 1);
    expect(fixture.responseHeaders).toEqual({ 'set-cookie': ['a=1', 'b=2'] });
  });

  it('stores a UTF-8 body as plain text, not base64', () => {
    const body = Buffer.from('{"id":1}').toString('base64');
    const { fixture } = buildFixtureFromExchange(exchange({ responseBody: body }), 1);
    expect(fixture.responseBody).toBe('{"id":1}');
    expect(fixture.responseBodyEncoding).toBeUndefined();
  });

  it('keeps a non-UTF-8 body as base64, flagging the encoding', () => {
    const binary = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10]); // not valid UTF-8
    const body = binary.toString('base64');
    const { fixture } = buildFixtureFromExchange(exchange({ responseBody: body }), 1);
    expect(fixture.responseBody).toBe(body);
    expect(fixture.responseBodyEncoding).toBe('base64');
  });

  it('omits responseBody entirely when the exchange had no body', () => {
    const { fixture } = buildFixtureFromExchange(exchange({ responseBody: undefined }), 1);
    expect(fixture.responseBody).toBeUndefined();
  });

  it('names the file with a zero-padded sequence prefix, method, and a slug of the pathname', () => {
    const { filename } = buildFixtureFromExchange(exchange(), 7);
    expect(filename).toBe('00007-get-orders-1.json');
  });

  it('falls back to statusCode 200 when the exchange never got a response (e.g. mocked/short-circuited oddly)', () => {
    const { fixture } = buildFixtureFromExchange(exchange({ statusCode: undefined }), 1);
    expect(fixture.status).toBe(200);
  });

  it('still produces a "/"-prefixed path for a relative exchange URL that new URL() alone would reject', () => {
    const { fixture } = buildFixtureFromExchange(exchange({ url: 'orders/1?expand=items' }), 1);
    expect(fixture.path).toBe('/orders/1?expand=items');
  });

  it('falls back to a "/"-prefixed raw path for a URL unparseable even against a throwaway base', () => {
    const { fixture } = buildFixtureFromExchange(exchange({ url: 'https://[::1' }), 1);
    expect(fixture.path.startsWith('/')).toBe(true);
  });
});
