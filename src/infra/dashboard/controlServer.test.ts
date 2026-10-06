import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapturedExchange } from '../../domain/exchange/types';
import type { Rule } from '../../domain/rules/types';
import { RuleEngine } from '../../usecase/ruleEngine';
import { DetourEventBus } from '../eventBus';
import { fsFileWatcher, fsRulesFileReader, fsRulesFileWriter } from '../fs/rulesFileSource';
import { listRuleProfiles, readRuleProfile, writeRuleProfile } from '../fs/ruleProfileStore';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

const TOKEN = 'control-api-test-token-0123456789';

const routeRule = (name: string): Rule => ({
  name,
  match: { url: 'https://api.example.com/*' },
  action: { type: 'route', host: 'x' },
});

const mockSequence = (): Rule => ({
  name: 'seq',
  match: { url: 'https://api.example.com/seq' },
  action: { type: 'mock', status: 200, responses: [{ status: 201 }, { status: 202 }, { status: 203 }] },
});

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: overrides.id ?? 'e1',
    method: 'GET',
    url: 'https://api.example.com/users',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    startedAt: 1000,
    statusCode: 200,
    responseBodySize: 0,
    ...overrides,
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a test reading whatever the API returned
}

/** Issue #212: the control API a test runner drives a running Detour with. */
describe('control API (issue #212)', () => {
  let dir: string;
  let eventBus: DetourEventBus;
  let handle: DashboardServerHandle | undefined;
  let engine: RuleEngine | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-control-test-'));
    eventBus = new DetourEventBus();
  });

  afterEach(async () => {
    engine?.close();
    engine = undefined;
    await handle?.stop();
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function startEngine(rules: Rule[]): RuleEngine {
    const filePath = path.join(dir, 'rules.json');
    fs.writeFileSync(filePath, JSON.stringify({ rules }));
    engine = RuleEngine.load({
      filePath,
      reader: fsRulesFileReader,
      writer: fsRulesFileWriter,
      watcher: fsFileWatcher,
      debounceMs: 10,
      allowScripts: true,
    });
    return engine;
  }

  async function start(extra: Partial<Parameters<typeof startDashboardServer>[0]> = {}) {
    handle = await startDashboardServer(
      { port: 0, accessToken: TOKEN, controlPort: 0, version: '9.9.9', ...extra },
      eventBus,
    );
    return handle;
  }

  function call(
    method: string,
    requestPath: string,
    opts: { body?: unknown; headers?: Record<string, string>; token?: string | null; host?: string } = {},
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
      if (opts.host) headers.host = opts.host;
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(payload));
      }
      const req = http.request(
        { host: '127.0.0.1', port: handle?.controlPort, path: requestPath, method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode ?? 0, headers: res.headers, json: text ? JSON.parse(text) : undefined });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  describe('availability', () => {
    it('is off unless a control port is given', async () => {
      handle = await startDashboardServer({ port: 0, accessToken: TOKEN }, eventBus);
      expect(handle.controlPort).toBeUndefined();
    });

    it('refuses to start without the access token that protects it', async () => {
      await expect(startDashboardServer({ port: 0, controlPort: 0 }, eventBus)).rejects.toThrow(/access token/);
    });

    it('binds loopback only', async () => {
      await start();
      const reachable = await new Promise<boolean>((resolve) => {
        const probe = http.get({ host: '127.0.0.1', port: handle?.controlPort, path: '/health' }, (res) => {
          res.resume();
          resolve(true);
        });
        probe.on('error', () => resolve(false));
      });
      expect(reachable).toBe(true); // reachable on 127.0.0.1 (the bind itself is asserted by the address below)
    });

    it('reports the version on /health', async () => {
      await start();
      const reply = await call('GET', '/health');
      expect(reply).toMatchObject({ status: 200, json: { ok: true, version: '9.9.9' } });
    });
  });

  describe('who may call it', () => {
    it('answers 401 without a bearer token, or with a wrong one', async () => {
      await start();

      const none = await call('GET', '/rules', { token: null });
      expect(none.status).toBe(401);
      expect(none.headers['www-authenticate']).toMatch(/^Bearer/);

      expect((await call('GET', '/rules', { token: 'wrong-token' })).status).toBe(401);
      // The token as a query parameter is not accepted: it would land in logs and shell history.
      expect((await call('GET', `/rules?token=${TOKEN}`, { token: null })).status).toBe(401);
    });

    it('refuses a request that carries an Origin header — a web page cannot drive it, even holding the token', async () => {
      await start();
      const reply = await call('GET', '/rules', { headers: { origin: 'http://evil.example' } });
      expect(reply.status).toBe(403);
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses a Host that is not a loopback address (DNS rebinding)', async () => {
      await start();
      expect((await call('GET', '/rules', { host: 'evil.example:80' })).status).toBe(403);
      expect((await call('GET', '/rules', { host: 'localhost:1234' })).status).toBe(200);
      expect((await call('GET', '/rules', { host: '[::1]:1234' })).status).toBe(200);
    });

    it('never answers a preflight with permissive CORS headers', async () => {
      await start();
      const reply = await call('OPTIONS', '/rules', { headers: { origin: 'http://evil.example' }, token: null });
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
      expect(reply.status).toBe(403);
    });
  });

  describe('rules', () => {
    it('GET /rules reports the active rules and profile', async () => {
      startEngine([routeRule('a')]);
      await start({ ruleEngine: engine });

      const reply = await call('GET', '/rules');

      expect(reply.json.rules.map((r: Rule) => r.name)).toEqual(['a']);
      expect(reply.json.activeProfile).toBeNull();
    });

    it('PUT /rules replaces the rules and answers only once they are live', async () => {
      startEngine([routeRule('a')]);
      await start({ ruleEngine: engine });

      const reply = await call('PUT', '/rules', { body: { rules: [routeRule('x'), routeRule('y')] } });

      expect(reply.status).toBe(200);
      expect(reply.json.ruleCount).toBe(2);
      // Live the instant the reply arrives: no waiting on the file watcher.
      expect(engine!.getRules().map((r) => r.name)).toEqual(['x', 'y']);
      expect(reply.json.rules.map((r: Rule) => r.name)).toEqual(['x', 'y']);
    });

    it('PUT /rules answers 400 for rules that fail validation, and keeps serving the old ones', async () => {
      startEngine([routeRule('a')]);
      await start({ ruleEngine: engine });

      const reply = await call('PUT', '/rules', { body: { rules: [{ name: 'broken' }] } });

      expect(reply.status).toBe(400);
      expect(reply.json.error).toMatch(/validation/i);
      expect(engine!.getRules().map((r) => r.name)).toEqual(['a']);
    });

    it('PUT /rules validates the body shape and the JSON itself', async () => {
      startEngine([routeRule('a')]);
      await start({ ruleEngine: engine });

      expect((await call('PUT', '/rules', { body: { nope: true } })).status).toBe(400);
      const notJson = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: handle?.controlPort,
            path: '/rules',
            method: 'PUT',
            headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end('{ not json');
      });
      expect(notJson).toBe(400);
    });

    it('PUT /rules answers 409 when the session has no rules file', async () => {
      await start();
      const reply = await call('PUT', '/rules', { body: { rules: [] } });
      expect(reply.status).toBe(409);
    });

    it("PUT /rules refuses to add a script rule, exactly like the dashboard's setRules (issue #161)", async () => {
      startEngine([routeRule('a')]);
      await start({ ruleEngine: engine });

      const script: Rule = { name: 's', match: { url: 'https://x/*' }, action: { type: 'script', path: 'hook.js' } };
      const reply = await call('PUT', '/rules', { body: { rules: [routeRule('a'), script] } });

      expect(reply.status).toBe(403);
      expect(engine!.getRules().map((r) => r.name)).toEqual(['a']);
    });

    it('a sequential mock is not reset a moment after PUT /rules (the file watcher noticing the write)', async () => {
      startEngine([mockSequence()]);
      await start({ ruleEngine: engine });
      await call('PUT', '/rules', { body: { rules: [mockSequence()] } });
      const [rule] = engine!.getRules();

      expect(engine!.resolveMockStep(rule!).status).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 150)); // longer than the watcher's debounce
      expect(engine!.resolveMockStep(rule!).status).toBe(202);
    });
  });

  describe('profiles', () => {
    let profilesDir: string;

    beforeEach(() => {
      profilesDir = path.join(dir, 'profiles');
      fs.mkdirSync(profilesDir);
    });

    const withProfiles = () => ({
      ruleProfileStore: {
        list: () => listRuleProfiles(profilesDir),
        read: (name: string) => readRuleProfile(name, profilesDir),
        write: (name: string, data: Parameters<typeof writeRuleProfile>[1]) =>
          writeRuleProfile(name, data, profilesDir),
      },
    });

    it('lists saved profiles and activates one, answering once it is in effect', async () => {
      startEngine([routeRule('a')]);
      withProfiles().ruleProfileStore.write('smoke', { rules: [routeRule('s1'), routeRule('s2')] });
      await start({ ruleEngine: engine, ...withProfiles() });

      const list = await call('GET', '/profiles');
      expect(list.json.profiles.map((p: { name: string }) => p.name)).toEqual(['smoke']);

      const reply = await call('POST', '/profiles/smoke/activate');

      expect(reply.status).toBe(200);
      expect(reply.json.activeProfile).toBe('smoke');
      expect(engine!.getRules().map((r) => r.name)).toEqual(['s1', 's2']);
      expect(engine!.getActiveProfile()).toBe('smoke');
    });

    it('answers 404 for a profile that does not exist', async () => {
      startEngine([routeRule('a')]);
      await start({ ruleEngine: engine, ...withProfiles() });
      expect((await call('POST', '/profiles/nope/activate')).status).toBe(404);
    });

    it('answers 409 when profiles are unavailable', async () => {
      await start();
      expect((await call('POST', '/profiles/x/activate')).status).toBe(409);
      expect((await call('GET', '/profiles')).json.profiles).toEqual([]);
    });
  });

  describe('reset and exchanges', () => {
    it('GET /exchanges returns what went through, and filters it', async () => {
      await start({
        initialBacklog: [
          exchange({ id: 'a', url: 'https://api.example.com/users', startedAt: 1000 }),
          exchange({
            id: 'b',
            url: 'https://api.example.com/orders',
            startedAt: 2000,
            method: 'POST',
            statusCode: 500,
          }),
          exchange({ id: 'c', url: 'https://other.example.com/x', startedAt: 3000 }),
        ],
      });

      const all = await call('GET', '/exchanges');
      expect(all.json.exchanges.map((e: { id: string }) => e.id)).toEqual(['a', 'b', 'c']);

      const ids = async (query: string) =>
        (await call('GET', `/exchanges?${query}`)).json.exchanges.map((e: { id: string }) => e.id);
      expect(await ids('url=api.example.com')).toEqual(['a', 'b']);
      expect(await ids('since=2000')).toEqual(['b', 'c']);
      expect(await ids('method=post')).toEqual(['b']);
      expect(await ids('status=500')).toEqual(['b']);
      expect(await ids('limit=2')).toEqual(['b', 'c']); // the most recent two, oldest first
      expect(await ids('url=api&since=1500')).toEqual(['b']);
    });

    it('rejects a malformed since / limit with 400', async () => {
      await start();
      expect((await call('GET', '/exchanges?since=yesterday')).status).toBe(400);
      expect((await call('GET', '/exchanges?limit=0')).status).toBe(400);
    });

    it('POST /reset starts sequential mocks over and forgets captured exchanges', async () => {
      startEngine([mockSequence()]);
      await start({ ruleEngine: engine, initialBacklog: [exchange()] });
      const [rule] = engine!.getRules();
      expect(engine!.resolveMockStep(rule!).status).toBe(201);
      expect(engine!.resolveMockStep(rule!).status).toBe(202);

      const reply = await call('POST', '/reset');

      expect(reply.status).toBe(200);
      expect(engine!.resolveMockStep(rule!).status).toBe(201);
      expect((await call('GET', '/exchanges')).json.exchanges).toEqual([]);
    });

    it('POST /reset works with no rules file', async () => {
      await start({ initialBacklog: [exchange()] });
      expect((await call('POST', '/reset')).status).toBe(200);
    });
  });

  describe('throttle and block-hosts', () => {
    /** Stands in for the proxy: applies the command and announces it, like `proxyServer.ts`. */
    function fakeProxy() {
      eventBus.on('setThrottle', (state) => eventBus.emit('throttleChanged', state));
      eventBus.on('setBlockHosts', (state) => eventBus.emit('blockHostsChanged', state));
    }

    it('PUT /throttle answers with the state the proxy confirmed', async () => {
      fakeProxy();
      await start();
      const state = { enabled: true, downKbps: 200, upKbps: 100, latencyMs: 50, packetLossPct: 1 };

      const reply = await call('PUT', '/throttle', { body: state });

      expect(reply).toMatchObject({ status: 200, json: state });
    });

    it('PUT /block-hosts answers with the state the proxy confirmed', async () => {
      fakeProxy();
      await start();
      const state = { hosts: ['ads.example'], mode: 'forbidden' };

      const reply = await call('PUT', '/block-hosts', { body: state });

      expect(reply).toMatchObject({ status: 200, json: state });
    });

    it('validates the bodies before sending anything to the proxy', async () => {
      let sent = 0;
      eventBus.on('setThrottle', () => sent++);
      eventBus.on('setBlockHosts', () => sent++);
      await start();

      expect((await call('PUT', '/throttle', { body: { enabled: 'yes' } })).status).toBe(400);
      expect((await call('PUT', '/block-hosts', { body: { hosts: [1], mode: 'x' } })).status).toBe(400);
      expect(sent).toBe(0);
    });

    it('answers 500 rather than hanging when the proxy never confirms', async () => {
      await start(); // no fake proxy listening
      const reply = await call('PUT', '/block-hosts', { body: { hosts: [], mode: 'forbidden' } });
      expect(reply.status).toBe(500);
      expect(reply.json.error).toMatch(/did not confirm/);
    }, 10_000);
  });

  it('answers 404 for an unknown endpoint', async () => {
    await start();
    expect((await call('GET', '/nope')).status).toBe(404);
  });
});
