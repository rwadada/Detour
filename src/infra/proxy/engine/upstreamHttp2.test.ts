import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { adaptHttp2Response, buildHttp2RequestHeaders } from './upstreamHttp2';
import type { ProxyToServerRequestOptions } from './types';

function opts(overrides: Partial<ProxyToServerRequestOptions> = {}): ProxyToServerRequestOptions {
  return {
    method: 'GET',
    path: '/hello',
    host: 'example.com',
    port: 443,
    headers: {},
    agent: new http.Agent(),
    ...overrides,
  };
}

describe('buildHttp2RequestHeaders', () => {
  it('synthesizes :method/:path/:scheme/:authority from the same options an HTTP/1.1 upstream request would use', () => {
    const headers = buildHttp2RequestHeaders(opts({ method: 'POST', path: '/a/b?x=1' }), true);
    expect(headers[':method']).toBe('POST');
    expect(headers[':path']).toBe('/a/b?x=1');
    expect(headers[':scheme']).toBe('https');
    expect(headers[':authority']).toBe('example.com');
  });

  it('includes a non-default port in :authority, omits it for the scheme default', () => {
    expect(buildHttp2RequestHeaders(opts({ port: 8443 }), true)[':authority']).toBe('example.com:8443');
    expect(buildHttp2RequestHeaders(opts({ port: 443 }), true)[':authority']).toBe('example.com');
    expect(buildHttp2RequestHeaders(opts({ port: 80 }), false)[':scheme']).toBe('http');
    expect(buildHttp2RequestHeaders(opts({ port: 80 }), false)[':authority']).toBe('example.com');
  });

  it("prefers an explicit host header over host:port (e.g. a route rule's hostHeader override)", () => {
    const headers = buildHttp2RequestHeaders(opts({ headers: { host: 'virtual-host.example' } }), true);
    expect(headers[':authority']).toBe('virtual-host.example');
  });

  it('finds an explicit host header override case-insensitively (e.g. a script rule authored it as "Host")', () => {
    const headers = buildHttp2RequestHeaders(opts({ headers: { Host: 'virtual-host.example' } }), true);
    expect(headers[':authority']).toBe('virtual-host.example');
  });

  it('re-brackets an IPv6 literal host in :authority when no host header survives', () => {
    expect(buildHttp2RequestHeaders(opts({ host: '::1', port: 8443 }), true)[':authority']).toBe('[::1]:8443');
    expect(buildHttp2RequestHeaders(opts({ host: '::1', port: 443 }), true)[':authority']).toBe('[::1]');
  });

  it('drops the host header itself and every other RFC 9113 §8.2.2 connection-specific header', () => {
    const headers = buildHttp2RequestHeaders(
      opts({
        headers: {
          host: 'example.com',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
          upgrade: 'websocket',
          'x-custom': 'kept',
        },
      }),
      true,
    );
    expect(headers.host).toBeUndefined();
    expect(headers.connection).toBeUndefined();
    expect(headers['keep-alive']).toBeUndefined();
    expect(headers['transfer-encoding']).toBeUndefined();
    expect(headers.upgrade).toBeUndefined();
    expect(headers['x-custom']).toBe('kept');
  });

  it('passes a gRPC-style "te: trailers" header through unchanged', () => {
    const headers = buildHttp2RequestHeaders(opts({ headers: { te: 'trailers' } }), true);
    expect(headers.te).toBe('trailers');
  });

  it('lowercases a header name a rewrite rule authored with mixed case (HTTP/2 field names must be lowercase)', () => {
    const headers = buildHttp2RequestHeaders(opts({ headers: { 'Content-Type': 'application/json' } }), true);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('merges (rather than silently drops one of) a header name a script rule authored in two different casings', () => {
    const headers = buildHttp2RequestHeaders(opts({ headers: { 'x-debug-id': 'a', 'X-Debug-Id': 'b' } }), true);
    expect(headers['x-debug-id']).toBe('a, b');
  });
});

describe('adaptHttp2Response', () => {
  function fakeStream() {
    return {
      on: vi.fn(),
      once: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as import('node:http2').ClientHttp2Stream;
  }

  // A plain object literal's `:status` (typed `number`) collides with
  // `IncomingHttpHeaders`'s general index signature (`string | string[] |
  // undefined`) for a strict function-call argument, even though Node's own
  // `'response'` event listener (which combines the two the same way
  // `adaptHttp2Response` itself does) accepts exactly this shape at
  // runtime — a cast, once, here rather than at every call site below.
  function fakeResponseHeaders(
    headers: Record<string, string | number>,
  ): import('node:http2').IncomingHttpHeaders & import('node:http2').IncomingHttpStatusHeader {
    return headers as unknown as import('node:http2').IncomingHttpHeaders &
      import('node:http2').IncomingHttpStatusHeader;
  }

  it('copies :status onto statusCode and maps it to the standard reason phrase', () => {
    const adapted = adaptHttp2Response(fakeStream(), fakeResponseHeaders({ ':status': 404 }));
    expect(adapted.statusCode).toBe(404);
    expect(adapted.statusMessage).toBe('Not Found');
  });

  it('defaults to 200 when the upstream response somehow omits :status', () => {
    const adapted = adaptHttp2Response(fakeStream(), fakeResponseHeaders({}));
    expect(adapted.statusCode).toBe(200);
  });

  it('strips pseudo-headers and keeps every real one', () => {
    const adapted = adaptHttp2Response(
      fakeStream(),
      fakeResponseHeaders({ ':status': 200, 'content-type': 'application/json', 'x-custom': 'value' }),
    );
    expect(adapted.headers).toEqual({ 'content-type': 'application/json', 'x-custom': 'value' });
  });

  it('returns the same stream instance (an adapter, not a copy) so it stays usable as the readable response body', () => {
    const stream = fakeStream();
    expect(adaptHttp2Response(stream, fakeResponseHeaders({ ':status': 200 }))).toBe(stream);
  });
});
