import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeCertPairingServer } from './nodeCertPairingServer';

let certPath: string;

function writeTempCert(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-cert-pairing-'));
  certPath = path.join(dir, 'ca.pem');
  fs.writeFileSync(certPath, contents);
  return certPath;
}

function get(url: string): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }),
        );
      })
      .on('error', reject);
  });
}

afterEach(() => {
  if (certPath) fs.rmSync(path.dirname(certPath), { recursive: true, force: true });
});

describe('nodeCertPairingServer', () => {
  it('serves the cert with a CA-cert content type at the URL it reports, then resolves downloaded:true', async () => {
    const cert = writeTempCert('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
    const session = await nodeCertPairingServer.start({ certPath: cert, host: '127.0.0.1', timeoutMs: 5_000 });

    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/detour-ca\.crt$/);

    const [response, result] = await Promise.all([get(session.url), session.waitForDownloadOrTimeout()]);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-x509-ca-cert');
    expect(response.body.toString('utf8')).toBe(fs.readFileSync(cert, 'utf8'));
    expect(result).toEqual({ downloaded: true });
  });

  it('resolves downloaded:false once timeoutMs elapses with nobody fetching it', async () => {
    const cert = writeTempCert('unused');
    const session = await nodeCertPairingServer.start({ certPath: cert, host: '127.0.0.1', timeoutMs: 50 });
    expect(await session.waitForDownloadOrTimeout()).toEqual({ downloaded: false });
  });

  it('404s a request to any path other than the cert route', async () => {
    const cert = writeTempCert('unused');
    // Short timeout: a 404 never sets `downloaded`, so the only way this
    // session's wait ends is the timeout — keep it brief so the test doesn't
    // block for a full ordinary pairing wait.
    const session = await nodeCertPairingServer.start({ certPath: cert, host: '127.0.0.1', timeoutMs: 100 });
    const base = session.url.slice(0, session.url.lastIndexOf('/'));
    const response = await get(`${base}/nope`);
    expect(response.status).toBe(404);
    expect(await session.waitForDownloadOrTimeout()).toEqual({ downloaded: false });
  });
});
