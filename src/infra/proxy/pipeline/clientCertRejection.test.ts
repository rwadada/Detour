import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { createAutoPassthroughHosts } from '../../../domain/autoPassthrough/clientCertRejection';
import type { CapturedExchange, ProxyErrorEvent } from '../../../domain/exchange/types';
import { ProxyRuntimeState } from '../../../usecase/proxyRuntimeState';
import { DetourEventBus } from '../../eventBus';
import { ProxyEngine } from '../engine/proxyEngine';
import { createClientCertRejectionHandler } from './clientCertRejection';
import { createConnectHandler } from './connectHandler';
import { createInterceptOffConnectHandler } from './interceptOffConnect';

/** What an Android app that doesn't trust user CAs makes OpenSSL report (seen on a Pixel, Android 17). */
const CERTIFICATE_UNKNOWN = new Error(
  'C0DE5BF401000000:error:0A000416:SSL routines:ssl3_read_bytes:tls alert certificate unknown:ssl/record/rec_layer_s3.c:923:SSL alert number 46',
);

function recordEvents(eventBus: DetourEventBus) {
  const responses: CapturedExchange[] = [];
  const errors: ProxyErrorEvent[] = [];
  eventBus.on('response', (exchange) => responses.push(exchange));
  eventBus.on('error', (event) => errors.push(event));
  return { responses, errors };
}

describe('createClientCertRejectionHandler', () => {
  it('logs a refusal as a CONNECT row for the SNI host and records the host for passthrough', () => {
    const eventBus = new DetourEventBus();
    const { responses, errors } = recordEvents(eventBus);
    const hosts = createAutoPassthroughHosts();
    createClientCertRejectionHandler({ eventBus, autoPassthroughHosts: hosts })(CERTIFICATE_UNKNOWN, 'API.example.com');

    expect(hosts.has('api.example.com')).toBe(true);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ method: 'CONNECT', host: 'api.example.com', url: 'https://api.example.com' });
    expect(responses[0]?.error).toMatch(
      /refused Detour's certificate for api\.example\.com \(TLS alert: certificate unknown\)/,
    );
    expect(responses[0]?.error).toMatch(/relayed untouched \(auto TLS passthrough\)/);
    expect(errors).toEqual([expect.objectContaining({ errorKind: 'CLIENT_REJECTED_CERTIFICATE' })]);
  });

  it('logs only the first refusal per host while passthrough is on', () => {
    const eventBus = new DetourEventBus();
    const { responses } = recordEvents(eventBus);
    const handler = createClientCertRejectionHandler({ eventBus, autoPassthroughHosts: createAutoPassthroughHosts() });
    handler(CERTIFICATE_UNKNOWN, 'api.example.com');
    handler(CERTIFICATE_UNKNOWN, 'api.example.com');
    handler(CERTIFICATE_UNKNOWN, 'cdn.example.com');
    expect(responses.map((r) => r.host)).toEqual(['api.example.com', 'cdn.example.com']);
  });

  it('still logs a refusal, without passthrough, once the remembered hosts are at their limit', () => {
    const eventBus = new DetourEventBus();
    const { responses } = recordEvents(eventBus);
    const hosts = createAutoPassthroughHosts(1);
    const handler = createClientCertRejectionHandler({ eventBus, autoPassthroughHosts: hosts });
    handler(CERTIFICATE_UNKNOWN, 'api.example.com');
    handler(CERTIFICATE_UNKNOWN, 'cdn.example.com');
    expect(hosts.has('cdn.example.com')).toBe(false);
    expect(responses.map((r) => r.host)).toEqual(['api.example.com', 'cdn.example.com']);
    expect(responses[1]?.error).toMatch(/maximum number of hosts, so cdn\.example\.com stays MITM'd/);
  });

  it('logs every refusal, and suggests the fix, while passthrough is off', () => {
    const eventBus = new DetourEventBus();
    const { responses } = recordEvents(eventBus);
    const handler = createClientCertRejectionHandler({ eventBus });
    handler(CERTIFICATE_UNKNOWN, 'api.example.com');
    handler(CERTIFICATE_UNKNOWN, 'api.example.com');
    expect(responses).toHaveLength(2);
    expect(responses[0]?.error).toMatch(/--no-auto-passthrough/);
  });

  it('ignores handshake failures that are not a certificate refusal, and refusals without an SNI', () => {
    const eventBus = new DetourEventBus();
    const { responses, errors } = recordEvents(eventBus);
    const hosts = createAutoPassthroughHosts();
    const handler = createClientCertRejectionHandler({ eventBus, autoPassthroughHosts: hosts });
    handler(new Error('socket hang up'), 'api.example.com');
    handler(new Error('…:tlsv1 alert protocol version:…:SSL alert number 70'), 'api.example.com');
    handler(CERTIFICATE_UNKNOWN, undefined);
    expect(responses).toEqual([]);
    expect(errors).toEqual([]);
    expect(hosts.has('api.example.com')).toBe(false);
  });
});

function hasOpenssl(): boolean {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test-only probe for the developer's/CI's own openssl; skipped when absent.
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A self-signed TLS server standing in for the real upstream, so a passthrough tunnel can be told apart from a MITM'd one by the certificate the client sees. */
function startFakeUpstream(): Promise<{ server: tls.Server; port: number }> {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: 'fake-upstream' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const server = tls.createServer(
    { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) },
    (socket) => socket.end(),
  );
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port })),
  );
}

/** Opens a CONNECT tunnel through the proxy and returns the CN of the certificate presented inside it. */
function certificateThroughTunnel(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    socket.once('data', (head) => {
      if (!/^HTTP\/1\.1 200/.test(head.toString())) return reject(new Error(head.toString()));
      const secure = tls.connect({ socket, servername: 'localhost', rejectUnauthorized: false }, () => {
        const cn = secure.getPeerCertificate().subject?.CN;
        secure.destroy();
        resolve(Array.isArray(cn) ? cn.join(',') : (cn ?? ''));
      });
      secure.on('error', reject);
    });
    socket.on('error', reject);
  });
}

describe('auto TLS passthrough, end to end', () => {
  it.skipIf(!hasOpenssl())(
    "relays a host as raw TLS once a client refused Detour's certificate for it",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-auto-passthrough-test-'));
      const eventBus = new DetourEventBus();
      const { responses } = recordEvents(eventBus);
      const runtimeState = new ProxyRuntimeState({ ruleEngine: undefined });
      const autoPassthroughHosts = createAutoPassthroughHosts();
      const engine = new ProxyEngine();
      engine.onTlsClientError(createClientCertRejectionHandler({ eventBus, autoPassthroughHosts }));
      engine.onConnect(
        createConnectHandler({
          eventBus,
          runtimeState,
          handleInterceptOffConnect: createInterceptOffConnectHandler({ eventBus, runtimeState }),
          autoPassthroughHosts,
        }),
      );
      const upstream = await startFakeUpstream();
      try {
        await new Promise<void>((resolve, reject) =>
          engine.listen({ port: 0, host: '127.0.0.1', sslCaDir: dir }, (e) => (e ? reject(e) : resolve())),
        );
        const target = `localhost:${upstream.port}`;

        // Before any refusal the tunnel is MITM'd: the client sees Detour's per-host certificate.
        expect(await certificateThroughTunnel(engine.httpPort, target)).toBe('localhost');

        // A client that doesn't trust the Detour CA refuses it with a TLS alert (unknown CA).
        await new Promise<void>((resolve) => {
          const child = execFile(
            // eslint-disable-next-line sonarjs/no-os-command-from-path -- test-only: the developer's/CI's own openssl, the one client at hand that refuses a cert with a real TLS alert (Node's tls just hangs up).
            'openssl',
            [
              's_client',
              '-proxy',
              `127.0.0.1:${engine.httpPort}`,
              '-connect',
              target,
              '-servername',
              'localhost',
              '-verify_return_error',
            ],
            { timeout: 10_000 },
            () => resolve(),
          );
          child.stdin?.end();
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(autoPassthroughHosts.has('localhost')).toBe(true);
        expect(
          responses.some((r) => r.method === 'CONNECT' && r.host === 'localhost' && /refused/.test(r.error ?? '')),
        ).toBe(true);

        // From then on the tunnel reaches the real upstream untouched.
        expect(await certificateThroughTunnel(engine.httpPort, target)).toBe('fake-upstream');
      } finally {
        engine.close();
        upstream.server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
