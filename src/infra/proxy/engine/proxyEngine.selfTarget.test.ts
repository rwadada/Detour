import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ProxyEngine } from './proxyEngine';

/** Sends `raw` to the proxy over a bare TCP socket and returns everything it answers up to the end of the headers. */
function rawExchange(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(raw));
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (received.includes('\r\n\r\n')) socket.end();
    });
    socket.on('close', () => resolve(received));
    socket.on('error', reject);
  });
}

function listenOnFreePort(server: net.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
  );
}

function respondOk(socket: net.Socket): void {
  socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
}

async function withProxy(run: (proxyPort: number, protectedPort: number, openPort: number) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-proxy-engine-test-'));
  const protectedServer = net.createServer(respondOk);
  const openServer = net.createServer(respondOk);
  const engine = new ProxyEngine();
  try {
    const protectedPort = await listenOnFreePort(protectedServer);
    const openPort = await listenOnFreePort(openServer);
    await new Promise<void>((resolve, reject) =>
      engine.listen({ port: 0, host: '127.0.0.1', sslCaDir: dir }, (e) => (e ? reject(e) : resolve())),
    );
    engine.protectLocalPort(protectedPort);
    await run(engine.httpPort, protectedPort, openPort);
  } finally {
    engine.close();
    protectedServer.close();
    openServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('ProxyEngine refuses to relay to its own listeners (issue #205)', () => {
  it('answers a forwarded HTTP request to a protected local port with 403, but still relays to other localhost ports', async () => {
    await withProxy(async (proxyPort, protectedPort, openPort) => {
      const blocked = await rawExchange(
        proxyPort,
        `GET http://localhost:${protectedPort}/ HTTP/1.1\r\nHost: localhost:${protectedPort}\r\nConnection: close\r\n\r\n`,
      );
      expect(blocked).toMatch(/^HTTP\/1\.1 403/);

      const allowed = await rawExchange(
        proxyPort,
        `GET http://127.0.0.1:${openPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${openPort}\r\nConnection: close\r\n\r\n`,
      );
      expect(allowed).toMatch(/^HTTP\/1\.1 200/);
    });
  });

  it('refuses a CONNECT to a protected local port and to the proxy itself, without establishing a tunnel', async () => {
    await withProxy(async (proxyPort, protectedPort) => {
      for (const target of [`127.0.0.1:${protectedPort}`, `localhost:${proxyPort}`]) {
        const answer = await rawExchange(proxyPort, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
        expect(answer).toMatch(/^HTTP\/1\.1 403/);
      }
    });
  });

  it('refuses a ws:// upgrade to a protected local port before the handshake completes', async () => {
    await withProxy(async (proxyPort, protectedPort) => {
      const answer = await rawExchange(
        proxyPort,
        `GET http://localhost:${protectedPort}/ws HTTP/1.1\r\nHost: localhost:${protectedPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      expect(answer).toMatch(/^HTTP\/1\.1 403/);
    });
  });

  it('refuses a wss:// upgrade tunnelled through an allowed CONNECT when its own target is a protected port', async () => {
    await withProxy(async (_proxyPort, protectedPort, openPort) => {
      // Reaches into the private handler the internal TLS server's own
      // `connection` event calls, so no real TLS tunnel has to be built.
      const engine = new ProxyEngine();
      engine.protectLocalPort(protectedPort);
      const internals = engine as unknown as {
        handleWebSocketConnection(ws: unknown, req: IncomingMessage, isSSL: boolean): void;
      };
      const upgrade = (port: number) => ({ url: '/ws', headers: { host: `localhost:${port}` } }) as IncomingMessage;
      const fakeWs = () => ({
        close: vi.fn(),
        terminate: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        readyState: WebSocket.OPEN,
        _socket: undefined,
      });

      const blocked = fakeWs();
      internals.handleWebSocketConnection(blocked, upgrade(protectedPort), true);
      await vi.waitFor(() => expect(blocked.close).toHaveBeenCalledWith(1008, expect.any(String)));

      const allowed = fakeWs();
      internals.handleWebSocketConnection(allowed, upgrade(openPort), true);
      await new Promise((r) => setTimeout(r, 50));
      expect(allowed.close).not.toHaveBeenCalledWith(1008, expect.any(String));
    });
  });
});

/** Whether this machine has an IPv6 loopback address at all (some CI containers do not) — read synchronously so `describe.skipIf` can use it. */
const HAS_IPV6_LOOPBACK = Object.values(os.networkInterfaces())
  .flatMap((infos) => infos ?? [])
  .some((info) => info.family === 'IPv6' && info.address === '::1');

/**
 * The dashboard binds `localhost`, which is `::1` on most machines, while a
 * dev server is typically on `127.0.0.1`. The two can share a port *number*
 * without being the same socket, and the proxy used to treat the IPv4 one as
 * the dashboard (a rare, inexplicable 403 — it surfaced as a flaky e2e).
 */
describe.skipIf(!HAS_IPV6_LOOPBACK)(
  'ProxyEngine does not mistake an IPv4 server for an IPv6 listener on the same port number (issue #205)',
  () => {
    it('relays to 127.0.0.1:P while the protected listener is [::1]:P, and still refuses ::1:P', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-proxy-engine-test-'));
      const ipv6Dashboard = net.createServer(respondOk);
      const engine = new ProxyEngine();
      let ipv4Server: net.Server | undefined;
      try {
        // The "dashboard" on [::1]:P, then an unrelated server on 127.0.0.1:P — same port number.
        const port = await new Promise<number>((resolve) =>
          ipv6Dashboard.listen(0, '::1', () => resolve((ipv6Dashboard.address() as net.AddressInfo).port)),
        );
        ipv4Server = net.createServer(respondOk);
        await new Promise<void>((resolve, reject) => {
          ipv4Server!.once('error', reject);
          ipv4Server!.listen(port, '127.0.0.1', () => resolve());
        });
        await new Promise<void>((resolve, reject) =>
          engine.listen({ port: 0, host: '127.0.0.1', sslCaDir: dir }, (e) => (e ? reject(e) : resolve())),
        );
        engine.protectLocalPort(port, '::1');

        const toIpv4 = await rawExchange(
          engine.httpPort,
          `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
        );
        expect(toIpv4).toMatch(/^HTTP\/1\.1 200/);

        const toIpv6 = await rawExchange(
          engine.httpPort,
          `GET http://[::1]:${port}/ HTTP/1.1\r\nHost: [::1]:${port}\r\nConnection: close\r\n\r\n`,
        );
        expect(toIpv6).toMatch(/^HTTP\/1\.1 403/);
      } finally {
        engine.close();
        ipv6Dashboard.close();
        ipv4Server?.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
