import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { RuleProfileSummary } from '../../domain/rules/profile';
import type { RulesFile } from '../../domain/rules/types';
import { fsFileWatcher, fsRulesFileReader, fsRulesFileWriter } from '../fs/rulesFileSource';
import { listRuleProfiles, readRuleProfile, writeRuleProfile } from '../fs/ruleProfileStore';
import type { RuleProfileStore } from '../../usecase/ports/ruleProfileStore';
import { RuleEngine } from '../../usecase/ruleEngine';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * Covers the Rules editor / Rules Profiles wiring (issue #19) added to
 * `startDashboardServer`: the rest of the file's WS surface (intercept/
 * focus/throttle/backlog/…) is already covered end-to-end via
 * `cli.e2e.test.ts`'s real CLI subprocess — this exercises just the new
 * surface directly against a real `RuleEngine`/filesystem, the same way
 * `ruleEngine.test.ts` does, since spinning up a whole CLI process per case
 * here would mostly re-test that same plumbing.
 */
describe('startDashboardServer — Rules editor / Rules Profiles (issue #19)', () => {
  let dir: string;
  let rulesPath: string;
  let profilesDir: string;
  let eventBus: DetourEventBus;
  let ruleEngine: RuleEngine | undefined;
  let ruleProfileStore: RuleProfileStore;
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[];

  const routeRule = (name: string): RulesFile['rules'][number] => ({
    name,
    match: { url: 'https://api.example.com/*' },
    action: { type: 'route', host: 'x' },
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-dashboard-rules-test-'));
    rulesPath = path.join(dir, 'rules.json');
    profilesDir = path.join(dir, 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(rulesPath, JSON.stringify({ rules: [routeRule('a')] }));
    ruleProfileStore = {
      list: () => listRuleProfiles(profilesDir),
      read: (name) => readRuleProfile(name, profilesDir),
      write: (name, data) => writeRuleProfile(name, data, profilesDir),
    };
    eventBus = new DetourEventBus();
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    ruleEngine?.close();
    ruleEngine = undefined;
    await handle?.stop();
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function connect(): WebSocket {
    const socket = new WebSocket(`ws://localhost:${handle?.port}/ws`);
    sockets.push(socket);
    return socket;
  }

  /** Resolves with the first message matching `predicate`, rejecting after `timeoutMs`. */
  function waitForMessage(
    socket: WebSocket,
    predicate: (message: DashboardServerMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<DashboardServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for a matching message`)), timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as DashboardServerMessage;
        if (predicate(message)) {
          clearTimeout(timer);
          socket.off('message', onMessage);
          resolve(message);
        }
      };
      socket.on('message', onMessage);
      socket.on('error', reject);
    });
  }

  async function startWithRuleEngine(): Promise<void> {
    ruleEngine = RuleEngine.load({
      filePath: rulesPath,
      reader: fsRulesFileReader,
      writer: fsRulesFileWriter,
      watcher: fsFileWatcher,
      debounceMs: 10,
      onReload: (info) => eventBus.emit('rulesReloaded', { filePath: rulesPath, ruleCount: info.ruleCount }),
      onReloadError: (message) => eventBus.emit('error', { errorKind: 'RULES_RELOAD_ERROR', message }),
    });
    handle = await startDashboardServer({ port: 0, ruleEngine, ruleProfileStore }, eventBus);
  }

  it('sends the currently active rules right after connecting', async () => {
    await startWithRuleEngine();
    const socket = connect();
    const message = await waitForMessage(socket, (m) => m.type === 'rules');
    expect(message).toEqual({ type: 'rules', data: { rules: [routeRule('a')] } });
  });

  it('sends `rules: null` when no rules file is configured for this session', async () => {
    handle = await startDashboardServer({ port: 0, ruleProfileStore }, eventBus);
    const socket = connect();
    const message = await waitForMessage(socket, (m) => m.type === 'rules');
    expect(message).toEqual({ type: 'rules', data: null });
  });

  it('setRules saves valid edits, which land back as a `rules` broadcast once reloaded', async () => {
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules'); // initial snapshot

    socket.send(JSON.stringify({ type: 'setRules', data: { rules: [routeRule('a'), routeRule('b')] } }));
    const updated = await waitForMessage(socket, (m) => m.type === 'rules' && m.data?.rules.length === 2);

    expect(updated).toEqual({ type: 'rules', data: { rules: [routeRule('a'), routeRule('b')] } });
    expect(JSON.parse(fs.readFileSync(rulesPath, 'utf8')).rules).toHaveLength(2);
  });

  it('setRules on invalid rules broadcasts a RULES_WRITE_ERROR and leaves the file untouched', async () => {
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules');
    const before = fs.readFileSync(rulesPath, 'utf8');

    socket.send(
      JSON.stringify({ type: 'setRules', data: { rules: [{ name: 'bad', match: {}, action: { type: 'bogus' } }] } }),
    );
    const error = await waitForMessage(socket, (m) => m.type === 'error');

    expect(error).toMatchObject({ type: 'error', event: { errorKind: 'RULES_WRITE_ERROR' } });
    expect(fs.readFileSync(rulesPath, 'utf8')).toBe(before);
  });

  it('setRules without a configured rules file broadcasts an error instead of throwing', async () => {
    handle = await startDashboardServer({ port: 0, ruleProfileStore }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules');

    socket.send(JSON.stringify({ type: 'setRules', data: { rules: [] } }));
    const error = await waitForMessage(socket, (m) => m.type === 'error');

    expect(error).toMatchObject({
      type: 'error',
      event: { errorKind: 'RULES_WRITE_ERROR', message: expect.stringMatching(/no rules file/i) },
    });
  });

  it('createRuleProfile("sample") saves the starter template and broadcasts the updated profile list', async () => {
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'ruleProfiles');

    socket.send(JSON.stringify({ type: 'createRuleProfile', name: 'starter', template: 'sample' }));
    const message = await waitForMessage(
      socket,
      (m) => m.type === 'ruleProfiles' && (m as { profiles: RuleProfileSummary[] }).profiles.length === 1,
    );

    const profiles = (message as { profiles: RuleProfileSummary[] }).profiles;
    expect(profiles[0]?.name).toBe('starter');
    expect(profiles[0]?.ruleCount).toBeGreaterThan(0);
  });

  it('createRuleProfile("blank") saves an empty ruleset', async () => {
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'ruleProfiles');

    socket.send(JSON.stringify({ type: 'createRuleProfile', name: 'empty', template: 'blank' }));
    await waitForMessage(
      socket,
      (m) => m.type === 'ruleProfiles' && (m as { profiles: RuleProfileSummary[] }).profiles.length === 1,
    );

    expect(readRuleProfile('empty', profilesDir).rules).toEqual([]);
  });

  it('saveActiveRulesAsProfile snapshots the currently active rules under a new name', async () => {
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'ruleProfiles');

    socket.send(JSON.stringify({ type: 'saveActiveRulesAsProfile', name: 'snapshot' }));
    await waitForMessage(
      socket,
      (m) => m.type === 'ruleProfiles' && (m as { profiles: RuleProfileSummary[] }).profiles.length === 1,
    );

    expect(readRuleProfile('snapshot', profilesDir).rules).toEqual([routeRule('a')]);
  });

  it('applyRuleProfile writes the profile into the active rules file, landing as a `rules` broadcast', async () => {
    writeRuleProfile('two-rules', { rules: [routeRule('a'), routeRule('b')] }, profilesDir);
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules');

    socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'two-rules' }));
    const updated = await waitForMessage(socket, (m) => m.type === 'rules' && m.data?.rules.length === 2);

    expect(updated).toEqual({ type: 'rules', data: { rules: [routeRule('a'), routeRule('b')] } });
  });

  it('applyRuleProfile on a nonexistent profile broadcasts a RULE_PROFILE_ERROR', async () => {
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules');

    socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'nope' }));
    const error = await waitForMessage(socket, (m) => m.type === 'error');

    expect(error).toMatchObject({ type: 'error', event: { errorKind: 'RULE_PROFILE_ERROR' } });
  });
});
