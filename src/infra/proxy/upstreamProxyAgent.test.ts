import type http from 'node:http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { describe, expect, it } from 'vitest';
import { createUpstreamProxyAgents, redactProxyUrlCredentials, validateUpstreamProxyUrl } from './upstreamProxyAgent';

describe('validateUpstreamProxyUrl', () => {
  it('accepts http/https/socks* schemes', () => {
    for (const url of [
      'http://proxy.example.com:8080',
      'https://proxy.example.com:8443',
      'socks://127.0.0.1:1080',
      'socks4://127.0.0.1:1080',
      'socks4a://127.0.0.1:1080',
      'socks5://127.0.0.1:1080',
      'socks5h://127.0.0.1:1080',
    ]) {
      expect(() => validateUpstreamProxyUrl(url)).not.toThrow();
    }
  });

  it('accepts credentials embedded in the URL', () => {
    expect(() => validateUpstreamProxyUrl('http://user:pass@proxy.example.com:8080')).not.toThrow();
  });

  it('rejects a malformed URL with a clear message', () => {
    expect(() => validateUpstreamProxyUrl('not a url')).toThrowError(/not a valid URL/);
  });

  it('rejects an unsupported scheme with a clear message', () => {
    expect(() => validateUpstreamProxyUrl('ftp://proxy.example.com')).toThrowError(/unsupported scheme "ftp:"/);
  });

  it('redacts embedded credentials from an unsupported-scheme error message', () => {
    expect(() => validateUpstreamProxyUrl('ftp://user:hunter2@proxy.example.com')).toThrowError(
      /ftp:\/\/\*\*\*@proxy\.example\.com/,
    );
    expect(() => validateUpstreamProxyUrl('ftp://user:hunter2@proxy.example.com')).not.toThrowError(/hunter2/);
  });

  it('redacts embedded credentials from a malformed-URL error message', () => {
    // An invalid port fails `new URL(...)` entirely (unlike the
    // unsupported-scheme case above, which still parses successfully) while
    // still carrying the same `scheme://user:pass@` shape.
    expect(() => validateUpstreamProxyUrl('http://user:hunter2@proxy.example.com:notaport')).toThrowError(
      /not a valid URL/,
    );
    expect(() => validateUpstreamProxyUrl('http://user:hunter2@proxy.example.com:notaport')).not.toThrowError(
      /hunter2/,
    );
  });
});

describe('createUpstreamProxyAgents', () => {
  it('builds an HttpProxyAgent/HttpsProxyAgent pair for an http: upstream proxy', () => {
    const { httpAgent, httpsAgent } = createUpstreamProxyAgents('http://proxy.example.com:8080');
    expect(httpAgent).toBeInstanceOf(HttpProxyAgent);
    expect(httpsAgent).toBeInstanceOf(HttpsProxyAgent);
  });

  it('builds an HttpProxyAgent/HttpsProxyAgent pair for an https: upstream proxy too', () => {
    const { httpAgent, httpsAgent } = createUpstreamProxyAgents('https://proxy.example.com:8443');
    expect(httpAgent).toBeInstanceOf(HttpProxyAgent);
    expect(httpsAgent).toBeInstanceOf(HttpsProxyAgent);
  });

  it('shares a single SocksProxyAgent instance for both http and https destinations', () => {
    const { httpAgent, httpsAgent } = createUpstreamProxyAgents('socks5://127.0.0.1:1080');
    expect(httpAgent).toBeInstanceOf(SocksProxyAgent);
    expect(httpAgent).toBe(httpsAgent);
  });

  it("propagates validateUpstreamProxyUrl's error for an unsupported scheme", () => {
    expect(() => createUpstreamProxyAgents('ftp://proxy.example.com')).toThrowError(/unsupported scheme/);
  });

  it("builds every agent kind with keepAlive: false, matching ProxyEngine's own default agents", () => {
    // `keepAlive` is a real runtime property on every `http.Agent` instance
    // (set from the constructor's `AgentOptions`), just not one `@types/node`
    // exposes on the class's public type.
    const keepAliveOf = (agent: http.Agent) => (agent as unknown as { keepAlive: boolean }).keepAlive;

    const httpUpstream = createUpstreamProxyAgents('http://proxy.example.com:8080');
    expect(keepAliveOf(httpUpstream.httpAgent)).toBe(false);
    expect(keepAliveOf(httpUpstream.httpsAgent)).toBe(false);

    const socksUpstream = createUpstreamProxyAgents('socks5://127.0.0.1:1080');
    expect(keepAliveOf(socksUpstream.httpAgent)).toBe(false);
  });
});

describe('redactProxyUrlCredentials', () => {
  it('replaces embedded credentials with a placeholder', () => {
    expect(redactProxyUrlCredentials('http://user:pass@proxy.example.com:8080')).toBe(
      'http://***@proxy.example.com:8080/',
    );
  });

  it('leaves a URL with no credentials unchanged', () => {
    expect(redactProxyUrlCredentials('http://proxy.example.com:8080')).toBe('http://proxy.example.com:8080');
  });

  it('redacts a username-only credential too', () => {
    expect(redactProxyUrlCredentials('socks5://user@127.0.0.1:1080')).toBe('socks5://***@127.0.0.1:1080');
  });

  it('returns the input unchanged if it does not parse as a URL', () => {
    expect(redactProxyUrlCredentials('not a url')).toBe('not a url');
  });
});
