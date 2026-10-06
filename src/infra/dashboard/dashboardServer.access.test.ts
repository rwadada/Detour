import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

const TOKEN = 'a-very-secret-dashboard-token-0123456789';
// Same well-formed fixture `dashboardServer.dashboardPassword.test.ts` uses.
const VALID_HASH_FIXTURE = `${'a'.repeat(32)}:${'b'.repeat(128)}`;

/**
 * Issue #205: the dashboard demands a secret by default. The proxy listens on
 * every interface, so "the dashboard only binds localhost" never kept a
 * network neighbour out (it could be reached *through* the proxy); a token,
 * traded for an HttpOnly cookie on the first visit, does.
 */
describe('startDashboardServer — access token (issue #205)', () => {
  let dir: string;
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-dashboard-access-test-'));
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await handle?.stop();
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Plain `http.request` rather than `fetch`, so the redirect and `Set-Cookie` can be inspected as they are. */
  function get(requestPath: string): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: 'localhost', port: handle?.port, path: requestPath }, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      });
      req.on('error', reject);
    });
  }

  function connect(query = '', headers: Record<string, string> = {}): WebSocket {
    const socket = new WebSocket(`ws://localhost:${handle?.port}/ws${query}`, { headers });
    sockets.push(socket);
    return socket;
  }

  /** Every message a socket receives during `ms`, in order. */
  function collect(socket: WebSocket, ms = 150): Promise<DashboardServerMessage[]> {
    return new Promise((resolve) => {
      const seen: DashboardServerMessage[] = [];
      socket.on('message', (raw) => seen.push(JSON.parse(raw.toString()) as DashboardServerMessage));
      setTimeout(() => resolve(seen), ms);
    });
  }

  const types = (messages: DashboardServerMessage[]) => messages.map((m) => m.type);

  describe('the first visit', () => {
    it('trades a valid ?token= for an HttpOnly cookie and redirects without the token in the URL', async () => {
      handle = await startDashboardServer({ port: 0, accessToken: TOKEN }, new DetourEventBus());

      const res = await get(`/?token=${TOKEN}&keep=1`);

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/?keep=1');
      const cookie = String(res.headers['set-cookie']?.[0]);
      expect(cookie).toMatch(/^detour_dashboard_session=[0-9a-f]{64}; /);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).not.toContain('Secure'); // plain-HTTP dashboard
      // The long-lived secret itself never goes into the cookie jar.
      expect(cookie).not.toContain(TOKEN);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('answers a wrong token with 403 and no cookie', async () => {
      handle = await startDashboardServer({ port: 0, accessToken: TOKEN }, new DetourEventBus());

      const res = await get('/?token=not-the-token');

      expect(res.statusCode).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('still serves the SPA itself without a token — it carries nothing sensitive, and has to load to ask for one', async () => {
      handle = await startDashboardServer({ port: 0, accessToken: TOKEN }, new DetourEventBus());

      const res = await get('/');

      expect(res.statusCode).not.toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('the WebSocket', () => {
    it('sends nothing but authRequired (method: token) to a client with no credential', async () => {
      handle = await startDashboardServer({ port: 0, accessToken: TOKEN }, new DetourEventBus());

      const messages = await collect(connect());

      expect(messages).toEqual([{ type: 'authRequired', method: 'token' }]);
    });

    it('sends the snapshot to a client that presents the token on the URL', async () => {
      handle = await startDashboardServer({ port: 0, accessToken: TOKEN, proxyPort: 18080 }, new DetourEventBus());

      const messages = await collect(connect(`?token=${TOKEN}`));

      expect(types(messages)).toContain('proxyInfo');
      expect(types(messages)).not.toContain('authRequired');
    });

    it('sends the snapshot to a client holding the cookie from the first visit', async () => {
      handle = await startDashboardServer({ port: 0, accessToken: TOKEN, proxyPort: 18080 }, new DetourEventBus());
      const visit = await get(`/?token=${TOKEN}`);
      const cookie = String(visit.headers['set-cookie']?.[0]).split(';')[0]!;

      const messages = await collect(connect('', { cookie }));

      expect(types(messages)).toContain('proxyInfo');
    });

    it('treats a wrong token, or a forged cookie, as no credential at all', async () => {
      handle = await startDashboardServer({ port: 0, accessToken: TOKEN, proxyPort: 18080 }, new DetourEventBus());

      const wrongToken = await collect(connect('?token=nope'));
      const forgedCookie = await collect(connect('', { cookie: `detour_dashboard_session=${'0'.repeat(64)}` }));
      // The token itself is not the cookie value (the cookie is derived from it).
      const tokenAsCookie = await collect(connect('', { cookie: `detour_dashboard_session=${TOKEN}` }));

      for (const messages of [wrongToken, forgedCookie, tokenAsCookie]) {
        expect(messages).toEqual([{ type: 'authRequired', method: 'token' }]);
      }
    });

    it('does not let `login` with an arbitrary password stand in for the token', async () => {
      handle = await startDashboardServer({ port: 0, accessToken: TOKEN, proxyPort: 18080 }, new DetourEventBus());
      const socket = connect();
      const seen = collect(socket, 300);
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));

      socket.send(JSON.stringify({ type: 'login', password: 'anything' }));

      // Refused (`authFailed`), and still no snapshot: never `proxyInfo` & co.
      expect(types(await seen)).toEqual(['authRequired', 'authFailed']);
    });

    it('ignores control messages from a socket that is not authenticated', async () => {
      const eventBus = new DetourEventBus();
      let intercept = 0;
      eventBus.on('setIntercept', () => intercept++);
      handle = await startDashboardServer({ port: 0, accessToken: TOKEN }, eventBus);
      const socket = connect();
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));

      socket.send(JSON.stringify({ type: 'setIntercept', enabled: false }));
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(intercept).toBe(0);
    });
  });

  describe('with a dashboard password configured', () => {
    it('keeps asking for the password — the token alone does not get past it', async () => {
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ dashboardPasswordHash: VALID_HASH_FIXTURE }), { mode: 0o600 });
      handle = await startDashboardServer(
        { port: 0, accessToken: TOKEN, proxyPort: 18080, userConfigPath: configPath },
        new DetourEventBus(),
      );

      const messages = await collect(connect(`?token=${TOKEN}`));

      expect(messages).toEqual([{ type: 'authRequired', method: 'password' }]);
    });
  });

  describe('without a token configured', () => {
    it('leaves the dashboard open, as the unit tests and older callers expect', async () => {
      handle = await startDashboardServer({ port: 0, proxyPort: 18080 }, new DetourEventBus());

      const messages = await collect(connect());

      expect(types(messages)).toContain('proxyInfo');
    });
  });
});
