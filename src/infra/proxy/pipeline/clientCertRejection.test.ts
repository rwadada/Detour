/* eslint-disable sonarjs/no-hardcoded-ip -- address fixtures */
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

/** A refusal arriving over a MITM tunnel the engine still knows about. */
function viaTunnel(host: string, port = 443, clientAddress = '127.0.0.1', servername: string | undefined = host) {
  return { servername, tunnel: { host, port, clientAddress } };
}

function setup(
  options: { passthrough?: boolean; focus?: string[]; hosts?: ReturnType<typeof createAutoPassthroughHosts> } = {},
) {
  const eventBus = new DetourEventBus();
  const events = recordEvents(eventBus);
  const runtimeState = new ProxyRuntimeState({ ruleEngine: undefined });
  if (options.focus) runtimeState.update({ focusHosts: options.focus });
  const hosts = options.passthrough === false ? undefined : (options.hosts ?? createAutoPassthroughHosts());
  const handler = createClientCertRejectionHandler({ eventBus, runtimeState, autoPassthroughHosts: hosts });
  return { ...events, hosts, handler };
}

describe('createClientCertRejectionHandler', () => {
  it('logs a refusal as a CONNECT row for the tunnel target and records it for passthrough', () => {
    const { responses, errors, hosts, handler } = setup();
    handler(CERTIFICATE_UNKNOWN, viaTunnel('API.example.com'));

    expect(hosts?.has({ clientAddress: '127.0.0.1', host: 'api.example.com', port: 443 })).toBe(true);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ method: 'CONNECT', host: 'api.example.com', url: 'https://api.example.com' });
    expect(responses[0]?.error).toMatch(
      /refused Detour's certificate for api\.example\.com \(TLS alert: certificate unknown\)/,
    );
    expect(responses[0]?.error).toMatch(/for the next 10 minutes, connections from this client .* relayed untouched/);
    expect(errors).toEqual([expect.objectContaining({ errorKind: 'CLIENT_REJECTED_CERTIFICATE' })]);
  });

  it('keys on what the CONNECT named — port, and an IP literal with the SNI noted', () => {
    const { responses, hosts, handler } = setup();
    handler(CERTIFICATE_UNKNOWN, viaTunnel('203.0.113.7', 8443, '127.0.0.1', 'api.example.com'));
    expect(hosts?.has({ clientAddress: '127.0.0.1', host: '203.0.113.7', port: 8443 })).toBe(true);
    expect(hosts?.has({ clientAddress: '127.0.0.1', host: 'api.example.com', port: 443 })).toBe(false);
    expect(responses[0]).toMatchObject({ host: '203.0.113.7:8443', url: 'https://203.0.113.7:8443' });
    expect(responses[0]?.error).toMatch(/203\.0\.113\.7:8443 \(SNI api\.example\.com\)/);
  });

  it('logs only the first refusal per target while passthrough is on', () => {
    const { responses, handler } = setup();
    handler(CERTIFICATE_UNKNOWN, viaTunnel('api.example.com'));
    handler(CERTIFICATE_UNKNOWN, viaTunnel('api.example.com'));
    handler(CERTIFICATE_UNKNOWN, viaTunnel('api.example.com', 443, '192.168.1.20'));
    handler(CERTIFICATE_UNKNOWN, viaTunnel('cdn.example.com'));
    expect(responses.map((r) => r.host)).toEqual(['api.example.com', 'api.example.com', 'cdn.example.com']);
  });

  it('leaves a host the user put in Focus MITM-ed, and says so', () => {
    const { responses, hosts, handler } = setup({ focus: ['api.example.com'] });
    handler(CERTIFICATE_UNKNOWN, viaTunnel('api.example.com'));
    expect(hosts?.has({ clientAddress: '127.0.0.1', host: 'api.example.com', port: 443 })).toBe(false);
    expect(responses[0]?.error).toMatch(/is in Focus, so it stays MITM'd/);
  });

  it('keeps logging refusals for a recorded target once the user puts it in Focus (it is MITM-ed again)', () => {
    const eventBus = new DetourEventBus();
    const { responses } = recordEvents(eventBus);
    const runtimeState = new ProxyRuntimeState({ ruleEngine: undefined });
    const hosts = createAutoPassthroughHosts();
    const handler = createClientCertRejectionHandler({ eventBus, runtimeState, autoPassthroughHosts: hosts });
    handler(CERTIFICATE_UNKNOWN, viaTunnel('api.example.com'));
    runtimeState.update({ focusHosts: ['api.example.com'] });
    handler(CERTIFICATE_UNKNOWN, viaTunnel('api.example.com'));
    expect(responses).toHaveLength(2);
    expect(responses[1]?.error).toMatch(/is in Focus, so it stays MITM'd/);
  });

  it('marks the row as never parsed as HTTP, so the dashboard offers no Replay/Edit & Send for it', () => {
    const { responses, handler } = setup();
    handler(CERTIFICATE_UNKNOWN, viaTunnel('api.example.com'));
    expect(responses[0]?.passthrough).toBe(true);
  });

  it('still logs a refusal, without passthrough, once the remembered targets are at their limit', () => {
    const { responses, hosts, handler } = setup({ hosts: createAutoPassthroughHosts({ limit: 1 }) });
    handler(CERTIFICATE_UNKNOWN, viaTunnel('api.example.com'));
    handler(CERTIFICATE_UNKNOWN, viaTunnel('cdn.example.com'));
    expect(hosts?.has({ clientAddress: '127.0.0.1', host: 'cdn.example.com', port: 443 })).toBe(false);
    expect(responses.map((r) => r.host)).toEqual(['api.example.com', 'cdn.example.com']);
    expect(responses[1]?.error).toMatch(/maximum number of hosts, so cdn\.example\.com stays MITM'd/);
  });

  it('logs a refusal whose tunnel is no longer known by its SNI, without passthrough', () => {
    const { responses, handler } = setup();
    handler(CERTIFICATE_UNKNOWN, { servername: 'api.example.com', tunnel: undefined });
    expect(responses[0]).toMatchObject({ host: 'api.example.com' });
    expect(responses[0]?.error).toMatch(/could no longer be told, so it stays MITM'd/);
  });

  it('logs every refusal, and suggests the fix, while passthrough is off', () => {
    const { responses, handler } = setup({ passthrough: false });
    handler(CERTIFICATE_UNKNOWN, viaTunnel('api.example.com'));
    handler(CERTIFICATE_UNKNOWN, viaTunnel('api.example.com'));
    expect(responses).toHaveLength(2);
    expect(responses[0]?.error).toMatch(
      /auto TLS passthrough is off \(--auto-passthrough, or `detour config --auto-passthrough on`/,
    );
  });

  it('ignores handshake failures that are not a certificate refusal, and refusals naming no host at all', () => {
    const { responses, errors, hosts, handler } = setup();
    handler(new Error('socket hang up'), viaTunnel('api.example.com'));
    handler(new Error('…:tlsv1 alert protocol version:…:SSL alert number 70'), viaTunnel('api.example.com'));
    handler(CERTIFICATE_UNKNOWN, { servername: undefined, tunnel: undefined });
    expect(responses).toEqual([]);
    expect(errors).toEqual([]);
    expect(hosts?.has({ clientAddress: '127.0.0.1', host: 'api.example.com', port: 443 })).toBe(false);
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
function certificateThroughTunnel(proxyPort: number, target: string, hostHeader = target): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\n\r\n`),
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
      engine.onTlsClientError(createClientCertRejectionHandler({ eventBus, runtimeState, autoPassthroughHosts }));
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
        // The refusal is logged for the CONNECT's own target (found through the
        // bridge port), and promises passthrough rather than "could no longer be told".
        const refusal = responses.find((r) => r.method === 'CONNECT' && /refused/.test(r.error ?? ''));
        expect(refusal?.host).toBe(target);
        expect(refusal?.error).toMatch(/relayed untouched \(auto TLS passthrough\)/);

        // From then on the tunnel reaches the real upstream untouched — the
        // lookup in connectHandler keys the same client/host/port as the record.
        expect(await certificateThroughTunnel(engine.httpPort, target)).toBe('fake-upstream');
        // A CONNECT whose Host header names something else is never passed
        // through: the passthrough relay follows the Host header, which isn't
        // the target that was refused.
        expect(await certificateThroughTunnel(engine.httpPort, target, `127.0.0.1:${upstream.port}`)).toBe('localhost');
        // …and only on that port: the same host on another port is still MITM'd.
        const other = await startFakeUpstream();
        try {
          expect(await certificateThroughTunnel(engine.httpPort, `localhost:${other.port}`)).toBe('localhost');
        } finally {
          other.server.close();
        }
      } finally {
        engine.close();
        upstream.server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
