import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
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

  it('treats an IPv6 literal (multiple colons, no port) as the whole host rather than splitting on the first colon', () => {
    // No brackets/port here — matches how a bare `Host: ::1` would arrive.
    // `lastIndexOf` still finds *a* colon, so this documents the existing
    // (bracket-less IPv6 is out of scope, see certAuthority.ts's identical
    // caveat) behavior rather than asserting an ideal one.
    expect(ProxyEngine.parseHost('::1')).toEqual({ host: ':', port: 1 });
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
});
