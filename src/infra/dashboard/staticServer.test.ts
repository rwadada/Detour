import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveStatic } from './staticServer';

let root: string;
let server: http.Server;

/**
 * Issues a request with `rawPath` sent verbatim on the wire (via `path` on
 * `http.request`'s options, not a `url.parse`d string) — a malformed
 * percent-encoding like `/%` would otherwise get rejected or silently
 * normalized before ever reaching `serveStatic`, defeating the point of
 * these regression tests (issue #94).
 */
function requestRaw(rawPath: string): Promise<{ status: number; body: string }> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port: address.port, path: rawPath, method: 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', reject)
      .end();
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-static-server-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>ok</html>');
  server = http.createServer((req, res) => serveStatic(root, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('serveStatic', () => {
  // Regression test for issue #94: `decodeURIComponent` throws a `URIError`
  // (synchronously, uncaught) on a malformed percent-encoding — before this
  // fix, a bare `GET /%` to the dashboard port crashed the whole detour
  // process (proxy included), reachable with no authentication since static
  // serving sits ahead of the dashboard password gate.
  it.each(['/%', '/%z', '/%zz', '/foo%', '/%gg'])(
    'returns 400 Bad Request instead of throwing for a malformed percent-encoded path (%s)',
    async (malformedPath) => {
      const response = await requestRaw(malformedPath);
      expect(response.status).toBe(400);
      expect(response.body).toBe('Bad Request');
    },
  );

  it('still serves a well-formed request normally (sanity check)', async () => {
    const response = await requestRaw('/');
    expect(response.status).toBe(200);
    expect(response.body).toBe('<html>ok</html>');
  });

  it('still 400s a valid-encoding traversal attempt the same way (existing guard, unaffected by the try/catch)', async () => {
    const response = await requestRaw('/..%2F..%2Fetc%2Fpasswd');
    expect(response.status).toBe(400);
    expect(response.body).toBe('Bad Request');
  });
});
