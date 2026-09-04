import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ProxyEngine } from './proxyEngine';

/** Builds just enough of an `IncomingMessage` for `parseHostAndPort` — it only ever reads `.url`/`.headers`. */
function fakeRequest(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}

describe('ProxyEngine.parseHost', () => {
  it('splits host:port on the last colon', () => {
    expect(ProxyEngine.parseHost('example.com:8080')).toEqual({ host: 'example.com', port: 8080 });
  });

  it('falls back to defaultPort when no port is given', () => {
    expect(ProxyEngine.parseHost('example.com', 443)).toEqual({ host: 'example.com', port: 443 });
  });

  it('unwraps a bracketed IPv6 literal with a port', () => {
    expect(ProxyEngine.parseHost('[::1]:8443')).toEqual({ host: '::1', port: 8443 });
  });

  it('unwraps a bracketed IPv6 literal with no port, falling back to defaultPort', () => {
    expect(ProxyEngine.parseHost('[::1]', 443)).toEqual({ host: '::1', port: 443 });
  });

  it('treats an unbracketed IPv6 literal (multiple colons, no port) as the whole host rather than mis-splitting on the last colon', () => {
    // No brackets here — matches how a bare `Host: ::1` would arrive. Per RFC
    // 3986 a client pairing an IPv6 literal with an explicit port must
    // bracket it, so a bracket-less multi-colon value is never split.
    expect(ProxyEngine.parseHost('::1', 443)).toEqual({ host: '::1', port: 443 });
  });
});

describe('ProxyEngine.parseHostAndPort', () => {
  it('parses an absolute-form URL (plain HTTP forward-proxy request) and rewrites req.url down to the bare path', () => {
    const req = fakeRequest('http://api.example.com:8080/users/1?x=2');
    const result = ProxyEngine.parseHostAndPort(req, 80);
    expect(result).toEqual({ host: 'api.example.com', port: 8080 });
    expect(req.url).toBe('/users/1?x=2');
  });

  it('defaults an absolute-form URL with no path to "/"', () => {
    const req = fakeRequest('http://api.example.com');
    ProxyEngine.parseHostAndPort(req, 80);
    expect(req.url).toBe('/');
  });

  it('falls back to the Host header for an origin-form URL (MITM-decrypted HTTPS, HTTP/1.1)', () => {
    const req = fakeRequest('/users/1', { host: 'api.example.com:8443' });
    expect(ProxyEngine.parseHostAndPort(req, 443)).toEqual({ host: 'api.example.com', port: 8443 });
  });

  it('falls back to the :authority pseudo-header when Host is absent (HTTP/2 has no Host header)', () => {
    const req = fakeRequest('/users/1', { ':authority': 'api.example.com:8443' });
    expect(ProxyEngine.parseHostAndPort(req, 443)).toEqual({ host: 'api.example.com', port: 8443 });
  });

  it('returns null when neither an absolute-form URL nor a Host/:authority is present', () => {
    const req = fakeRequest('/users/1');
    expect(ProxyEngine.parseHostAndPort(req, 443)).toBeNull();
  });

  it('parses a bracketed IPv6 Host header', () => {
    const req = fakeRequest('/users/1', { host: '[::1]:8443' });
    expect(ProxyEngine.parseHostAndPort(req, 443)).toEqual({ host: '::1', port: 8443 });
  });
});

/** A minimal `WebSocket`-shaped double: just `readyState`/`close`, which is all `closeStillOpenLeg`/`wsError` touch. */
function fakeSocket(readyState: number) {
  const closeCalls: unknown[][] = [];
  return { readyState, close: (...args: unknown[]) => closeCalls.push(args), closeCalls };
}

/** Exposes `ProxyEngine`'s private WebSocket cross-signaling methods for direct testing, without needing a real socket pair. */
function engineInternals() {
  return new ProxyEngine() as unknown as {
    closeStillOpenLeg(ctx: { clientWs?: unknown; serverWs?: unknown }, code?: number, message?: Buffer): void;
    wsError(ctx: { clientWs?: unknown; serverWs?: unknown }, err: Error): void;
  };
}

describe('ProxyEngine WebSocket close/error cross-signaling', () => {
  it('closes the still-open client leg once the server leg has already closed', () => {
    const client = fakeSocket(WebSocket.OPEN);
    const server = fakeSocket(WebSocket.CLOSED);
    engineInternals().closeStillOpenLeg({ clientWs: client, serverWs: server });
    expect(client.closeCalls).toHaveLength(1);
  });

  it('closes the still-open server leg once the client leg has already closed, forwarding code/message', () => {
    const client = fakeSocket(WebSocket.CLOSED);
    const server = fakeSocket(WebSocket.OPEN);
    engineInternals().closeStillOpenLeg({ clientWs: client, serverWs: server }, 1000, Buffer.from('done'));
    expect(server.closeCalls).toEqual([[1000, Buffer.from('done')]]);
  });

  it('closes with no arguments for code 1005 ("no status received"), which close() rejects as an explicit argument', () => {
    const client = fakeSocket(WebSocket.CLOSED);
    const server = fakeSocket(WebSocket.OPEN);
    engineInternals().closeStillOpenLeg({ clientWs: client, serverWs: server }, 1005, Buffer.alloc(0));
    expect(server.closeCalls).toEqual([[]]);
  });

  it('does nothing when both legs are already in the same state', () => {
    const client = fakeSocket(WebSocket.CLOSED);
    const server = fakeSocket(WebSocket.CLOSED);
    engineInternals().closeStillOpenLeg({ clientWs: client, serverWs: server });
    expect(client.closeCalls).toHaveLength(0);
    expect(server.closeCalls).toHaveLength(0);
  });

  it('does nothing when the server leg does not exist yet (e.g. an error before connectUpstreamWebSocket ran)', () => {
    const client = fakeSocket(WebSocket.OPEN);
    engineInternals().closeStillOpenLeg({ clientWs: client, serverWs: undefined });
    expect(client.closeCalls).toHaveLength(0);
  });

  it('wsError cross-signals just like wsClose, closing the still-open leg', () => {
    const client = fakeSocket(WebSocket.OPEN);
    const server = fakeSocket(WebSocket.CLOSED);
    engineInternals().wsError({ clientWs: client, serverWs: server }, new Error('boom'));
    expect(client.closeCalls).toHaveLength(1);
  });
});
