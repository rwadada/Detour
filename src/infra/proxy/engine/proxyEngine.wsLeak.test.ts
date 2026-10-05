import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { ProxyEngine } from './proxyEngine';

/** An upstream WS server that pushes a frame every 20ms and reports when its side of the connection closes. */
async function startChattyUpstream() {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  let connected = false;
  let closed = false;
  wss.on('connection', (ws) => {
    connected = true;
    const timer = setInterval(() => ws.readyState === ws.OPEN && ws.send('tick'), 20);
    ws.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
    ws.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    isConnected: () => connected,
    isClosed: () => closed,
    stop: () => {
      wss.clients.forEach((c) => c.terminate());
      server.close();
    },
  };
}

/** Opens a relayed WebSocket through the proxy over a raw TCP socket (so it can be destroyed with no close frame). */
function openRelayedSocket(proxyPort: number, upstreamPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () =>
      socket.write(
        `GET http://127.0.0.1:${upstreamPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    let head = '';
    socket.on('data', (chunk) => {
      head += chunk.toString('latin1');
      if (head.startsWith('HTTP/1.1 101')) resolve(socket);
    });
    socket.on('error', reject);
  });
}

async function withRelay(
  run: (ctx: {
    engine: ProxyEngine;
    proxyPort: number;
    upstream: Awaited<ReturnType<typeof startChattyUpstream>>;
  }) => Promise<void>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-proxy-engine-test-'));
  const upstream = await startChattyUpstream();
  const engine = new ProxyEngine();
  try {
    await new Promise<void>((resolve, reject) =>
      engine.listen({ port: 0, host: '127.0.0.1', sslCaDir: dir }, (e) => (e ? reject(e) : resolve())),
    );
    await run({ engine, proxyPort: engine.httpPort, upstream });
  } finally {
    engine.close();
    upstream.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('ProxyEngine relayed WebSocket cleanup (issue #206)', () => {
  it('closes the upstream leg shortly after the client vanishes without a close frame', async () => {
    await withRelay(async ({ proxyPort, upstream }) => {
      const client = await openRelayedSocket(proxyPort, upstream.port);
      await expect.poll(() => upstream.isConnected()).toBe(true);

      client.destroy();

      await expect.poll(() => upstream.isClosed(), { timeout: 5000 }).toBe(true);
    });
  });

  it('terminates a live relayed WebSocket when the engine closes', async () => {
    await withRelay(async ({ engine, proxyPort, upstream }) => {
      const client = await openRelayedSocket(proxyPort, upstream.port);
      await expect.poll(() => upstream.isConnected()).toBe(true);
      const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));

      engine.close();

      await clientClosed;
      await expect.poll(() => upstream.isClosed(), { timeout: 5000 }).toBe(true);
    });
  });
});
