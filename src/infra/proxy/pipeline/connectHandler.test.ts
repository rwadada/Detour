/* eslint-disable sonarjs/no-hardcoded-ip -- address fixtures */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProxyRuntimeState } from '../../../usecase/proxyRuntimeState';
import { DetourEventBus } from '../../eventBus';
import { ProxyEngine } from '../engine/proxyEngine';
import { createConnectHandler } from './connectHandler';
import { createInterceptOffConnectHandler } from './interceptOffConnect';

/** A TCP server that greets every connection with its own name, so a tunnel can tell which one it reached. */
function namedServer(name: string): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => socket.end(`${name}\n`));
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port })),
  );
}

/** Sends a raw CONNECT and returns the status line, plus whatever the tunnel delivers after it. */
function connect(proxyPort: number, target: string, hostHeader: string | undefined): Promise<string> {
  return new Promise((resolve) => {
    const hostLine = hostHeader ? 'Host: ' + hostHeader + '\r\n' : '';
    const socket = net.connect(proxyPort, '127.0.0.1', () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\n${hostLine}\r\n`),
    );
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString();
    });
    socket.on('close', () => resolve(received));
    socket.on('error', () => resolve(received));
    setTimeout(() => socket.destroy(), 2000);
  });
}

describe('CONNECT routing follows the request-target, not the Host header', () => {
  it('relays a passthrough tunnel to the request-target even when the Host header names a protected listener', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-connect-target-test-'));
    const eventBus = new DetourEventBus();
    const runtimeState = new ProxyRuntimeState({ ruleEngine: undefined });
    runtimeState.update({ interceptEnabled: false });
    const engine = new ProxyEngine();
    engine.onConnect(
      createConnectHandler({
        eventBus,
        runtimeState,
        handleInterceptOffConnect: createInterceptOffConnectHandler({ eventBus, runtimeState }),
      }),
    );
    const allowed = await namedServer('allowed');
    const protectedOne = await namedServer('protected');
    try {
      await new Promise<void>((resolve, reject) =>
        engine.listen({ port: 0, host: '127.0.0.1', sslCaDir: dir }, (e) => (e ? reject(e) : resolve())),
      );
      engine.protectLocalPort(protectedOne.port);

      // The self-target guard judges the request-target; the relay must too.
      const steered = await connect(engine.httpPort, `127.0.0.1:${allowed.port}`, `127.0.0.1:${protectedOne.port}`);
      expect(steered).toMatch(/^HTTP\/1\.1 200/);
      expect(steered).toContain('allowed');
      expect(steered).not.toContain('protected');

      // And a CONNECT that names the protected listener itself is still refused, whatever its Host says.
      const direct = await connect(engine.httpPort, `127.0.0.1:${protectedOne.port}`, `127.0.0.1:${allowed.port}`);
      expect(direct).toMatch(/^HTTP\/1\.1 403/);

      // A CONNECT without a Host header (HTTP/1.0 style) is relayed to its request-target instead of a 502.
      const noHost = await connect(engine.httpPort, `127.0.0.1:${allowed.port}`, undefined);
      expect(noHost).toMatch(/^HTTP\/1\.1 200/);
      expect(noHost).toContain('allowed');
    } finally {
      engine.close();
      allowed.server.close();
      protectedOne.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('judges Block Hosts on the request-target too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-connect-target-test-'));
    const eventBus = new DetourEventBus();
    const runtimeState = new ProxyRuntimeState({ ruleEngine: undefined });
    runtimeState.update({ interceptEnabled: false, blockHostsState: { hosts: ['127.0.0.1:*'], mode: 'forbidden' } });
    const blockedEvents: string[] = [];
    eventBus.on('error', (event) => blockedEvents.push(event.message));
    const engine = new ProxyEngine();
    engine.onConnect(
      createConnectHandler({
        eventBus,
        runtimeState,
        handleInterceptOffConnect: createInterceptOffConnectHandler({ eventBus, runtimeState }),
      }),
    );
    const allowed = await namedServer('allowed');
    try {
      await new Promise<void>((resolve, reject) =>
        engine.listen({ port: 0, host: '127.0.0.1', sslCaDir: dir }, (e) => (e ? reject(e) : resolve())),
      );
      const blocked = await connect(engine.httpPort, `127.0.0.1:${allowed.port}`, 'unblocked.example:443');
      expect(blocked).toMatch(/^HTTP\/1\.1 403/);
      expect(blockedEvents).toEqual([`blocked CONNECT to 127.0.0.1:${allowed.port} (forbidden)`]);
    } finally {
      engine.close();
      allowed.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
