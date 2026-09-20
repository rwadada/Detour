import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import { DetourEventBus } from '../eventBus';
import { CertAuthority } from '../proxy/engine/certAuthority';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * `tlsKeyCert` (issue #159): serving the dashboard over HTTPS once `--lan`
 * exposes it to the network, using a leaf cert from Detour's own
 * already-trusted CA. Covers both the on/off switch itself and that the
 * presented cert is genuinely the one `getMultiHostKeyCert` minted — not
 * just "some TLS handshake happened".
 */
describe('startDashboardServer — TLS (issue #159)', () => {
  let certDir: string;
  /** A scratch config path (Copilot review, PR #175) — without this, `startDashboardServer` falls back to the real `~/.detour/config.json`, so a developer machine with a dashboard password already set would get `authRequired` instead of `backlog` as the first message and make these tests environment-dependent. */
  let configPath: string;
  let eventBus: DetourEventBus;
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[];

  beforeEach(() => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-dashboard-tls-test-'));
    configPath = path.join(certDir, 'config.json');
    eventBus = new DetourEventBus();
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await handle?.stop();
    handle = undefined;
    fs.rmSync(certDir, { recursive: true, force: true });
  });

  function waitForMessage(
    socket: WebSocket,
    predicate: (message: DashboardServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<DashboardServerMessage> {
    return new Promise((resolve, reject) => {
      // Detaches every listener this call added and clears its timer,
      // whichever of resolve/reject/timeout fires first (Copilot review) —
      // without this, a socket used across several `waitForMessage` calls
      // (or one that errors early) accumulates 'message'/'error' listeners
      // and leaves timers pending.
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        socket.off('error', onError);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for a matching message'));
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as DashboardServerMessage;
        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      socket.on('message', onMessage);
      socket.on('error', onError);
    });
  }

  it('serves plain HTTP/WS when tlsKeyCert is omitted (the default)', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`);
    sockets.push(socket);
    const message = await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(message.type).toBe('backlog');
  });

  it('serves HTTPS/WSS when a tlsKeyCert is given, and traffic flows normally over it', async () => {
    const ca = CertAuthority.load(certDir);
    const tlsKeyCert = ca.getMultiHostKeyCert(['localhost', '127.0.0.1']);
    handle = await startDashboardServer({ port: 0, tlsKeyCert, userConfigPath: configPath }, eventBus);

    // `rejectUnauthorized: false`: this test's throwaway CertAuthority isn't
    // in any trust store, same as a real one is until a user installs it —
    // the point here is that the handshake completes and traffic flows at
    // all, not re-testing certificate trust (CertAuthority.test.ts already
    // covers the cert itself being validly CA-signed).
    const socket = new WebSocket(`wss://localhost:${handle.port}/ws`, { rejectUnauthorized: false });
    sockets.push(socket);
    const message = await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(message.type).toBe('backlog');
  });

  it("the presented cert's SAN covers every host getMultiHostKeyCert was given", async () => {
    const ca = CertAuthority.load(certDir);
    const tlsKeyCert = ca.getMultiHostKeyCert(['localhost', '127.0.0.1']);
    handle = await startDashboardServer({ port: 0, tlsKeyCert, userConfigPath: configPath }, eventBus);

    const cert = await new Promise<tls.PeerCertificate>((resolve, reject) => {
      const socket = tls.connect({ host: 'localhost', port: handle!.port, rejectUnauthorized: false }, () => {
        resolve(socket.getPeerCertificate());
        socket.destroy();
      });
      socket.on('error', reject);
    });
    expect(cert.subjectaltname).toMatch(/DNS:\s*localhost\b/);
    expect(cert.subjectaltname).toMatch(/IP Address:\s*127\.0\.0\.1\b/);
  });

  it('a plain (non-TLS) client cannot speak to the HTTPS listener', async () => {
    const ca = CertAuthority.load(certDir);
    const tlsKeyCert = ca.getMultiHostKeyCert(['localhost', '127.0.0.1']);
    handle = await startDashboardServer({ port: 0, tlsKeyCert, userConfigPath: configPath }, eventBus);

    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`);
    sockets.push(socket);
    await new Promise<void>((resolve) => {
      // A plain-HTTP handshake against a TLS-only port fails one way or
      // another (a protocol-mismatch error, or the server simply never
      // completing the upgrade) — either is "did not connect normally",
      // which is all this asserts.
      socket.once('error', () => resolve());
      socket.once('unexpected-response', () => resolve());
      socket.once('open', () => resolve()); // shouldn't happen; the outer expect below catches it
    });
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
  });
});
