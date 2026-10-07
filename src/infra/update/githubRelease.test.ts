import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeFetchFailure, fetchLatestReleaseVersion } from './githubRelease';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('describeFetchFailure', () => {
  it('reads the reason off `cause` — Node\'s own message for a failed fetch is just "fetch failed"', () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }),
    });
    expect(describeFetchFailure(err)).toBe('ENOTFOUND: getaddrinfo ENOTFOUND api.github.com');
  });

  it('uses a cause that has no code as it is, and the error itself when there is no cause', () => {
    expect(
      describeFetchFailure(
        new TypeError('fetch failed', { cause: new Error('unable to verify the first certificate') }),
      ),
    ).toBe('unable to verify the first certificate');
    expect(describeFetchFailure(new Error('boom'))).toBe('boom');
    expect(describeFetchFailure('plain string')).toBe('plain string');
  });

  it('names a timeout as one', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(describeFetchFailure(timeout)).toBe('no answer within 10s');
  });
});

describe('fetchLatestReleaseVersion — what the user is told when it fails', () => {
  it('says the connection was refused, not just "fetch failed" (a real failed connection, no mocks)', async () => {
    // A port nothing listens on: the real fetch rejects with a TypeError whose `cause` is ECONNREFUSED.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (_url: unknown, init?: RequestInit) => realFetch(`http://127.0.0.1:${port}/`, init));

    const failure = await fetchLatestReleaseVersion().catch((err: Error) => err.message);

    expect(failure).toMatch(/^could not reach GitHub to check for updates \(ECONNREFUSED/);
    expect(failure).not.toContain('(fetch failed)');
  });

  it('names the HTTP status when GitHub answers with an error (a rate limit is a 403)', async () => {
    vi.stubGlobal('fetch', async () => new Response('rate limited', { status: 403 }));
    await expect(fetchLatestReleaseVersion()).rejects.toThrow('GitHub returned HTTP 403 when checking for updates');
  });

  it('returns the version without the leading v', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ tag_name: 'v2.0.1' }), { status: 200 }));
    await expect(fetchLatestReleaseVersion()).resolves.toBe('2.0.1');
  });
});
