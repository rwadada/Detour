import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { RuleProfileSummary } from '../../domain/rules/profile';
import type { RulesFile } from '../../domain/rules/types';
import { findUnreachableRules } from '../../domain/rules/unreachableRules';
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
      onReload: (info) =>
        eventBus.emit('rulesReloaded', {
          filePath: rulesPath,
          ruleCount: info.ruleCount,
          unreachableWarnings: info.unreachableWarnings,
        }),
      onReloadError: (message) => eventBus.emit('error', { errorKind: 'RULES_RELOAD_ERROR', message }),
    });
    handle = await startDashboardServer({ port: 0, ruleEngine, ruleProfileStore }, eventBus);
  }

  it('sends the currently active rules right after connecting', async () => {
    await startWithRuleEngine();
    const socket = connect();
    const message = await waitForMessage(socket, (m) => m.type === 'rules');
    expect(message).toEqual({
      type: 'rules',
      data: { rules: [routeRule('a')] },
      unreachableWarnings: findUnreachableRules([routeRule('a')]),
    });
  });

  it('sends `rules: null` when no rules file is configured for this session', async () => {
    handle = await startDashboardServer({ port: 0, ruleProfileStore }, eventBus);
    const socket = connect();
    const message = await waitForMessage(socket, (m) => m.type === 'rules');
    expect(message).toEqual({ type: 'rules', data: null, unreachableWarnings: [] });
  });

  it('setRules saves valid edits, which land back as a `rules` broadcast once reloaded', async () => {
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules'); // initial snapshot

    socket.send(JSON.stringify({ type: 'setRules', data: { rules: [routeRule('a'), routeRule('b')] } }));
    const updated = await waitForMessage(socket, (m) => m.type === 'rules' && m.data?.rules.length === 2);

    expect(updated).toEqual({
      type: 'rules',
      data: { rules: [routeRule('a'), routeRule('b')] },
      unreachableWarnings: findUnreachableRules([routeRule('a'), routeRule('b')]),
    });
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

  it('saveActiveRulesAsProfile snapshots the currently active rules under a new name, and marks the active file as that profile', async () => {
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'ruleProfiles');

    socket.send(JSON.stringify({ type: 'saveActiveRulesAsProfile', name: 'snapshot' }));
    await waitForMessage(
      socket,
      (m) => m.type === 'ruleProfiles' && (m as { profiles: RuleProfileSummary[] }).profiles.length === 1,
    );

    expect(readRuleProfile('snapshot', profilesDir).rules).toEqual([routeRule('a')]);
    // The saved profile file itself never carries `$activeProfile` (it
    // wouldn't mean anything there) — only the active rules.json does, via
    // its own debounced file-watch-driven reload (same `socket` — this is
    // the *second* `rules` broadcast it ever receives, the first being the
    // initial post-connect snapshot).
    const updated = await waitForMessage(socket, (m) => m.type === 'rules' && m.data?.$activeProfile === 'snapshot');
    expect(updated).toEqual({
      type: 'rules',
      data: { rules: [routeRule('a')], $activeProfile: 'snapshot' },
      unreachableWarnings: findUnreachableRules([routeRule('a')]),
    });
  });

  it('applyRuleProfile writes the profile into the active rules file, landing as a `rules` broadcast with $activeProfile set to it', async () => {
    writeRuleProfile('two-rules', { rules: [routeRule('a'), routeRule('b')] }, profilesDir);
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules');

    socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'two-rules' }));
    const updated = await waitForMessage(socket, (m) => m.type === 'rules' && m.data?.rules.length === 2);

    expect(updated).toEqual({
      type: 'rules',
      data: { rules: [routeRule('a'), routeRule('b')], $activeProfile: 'two-rules' },
      unreachableWarnings: findUnreachableRules([routeRule('a'), routeRule('b')]),
    });
  });

  it('setRules clears $activeProfile even when a profile was applied just before it', async () => {
    writeRuleProfile('two-rules', { rules: [routeRule('a'), routeRule('b')] }, profilesDir);
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules');

    socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'two-rules' }));
    await waitForMessage(socket, (m) => m.type === 'rules' && m.data?.$activeProfile === 'two-rules');

    // Edited (still 2 rules, same content even) and saved through the
    // ordinary Rules editor path — per `RulesFile.$activeProfile`'s doc
    // comment, that alone clears the marker regardless of what the content
    // ends up looking like.
    socket.send(JSON.stringify({ type: 'setRules', data: { rules: [routeRule('a'), routeRule('b')] } }));
    const updated = await waitForMessage(
      socket,
      (m) => m.type === 'rules' && m.data?.rules.length === 2 && m.data.$activeProfile === undefined,
    );

    expect(updated).toEqual({
      type: 'rules',
      data: { rules: [routeRule('a'), routeRule('b')] },
      unreachableWarnings: findUnreachableRules([routeRule('a'), routeRule('b')]),
    });
  });

  it('applyRuleProfile on a nonexistent profile broadcasts a RULE_PROFILE_ERROR', async () => {
    await startWithRuleEngine();
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules');

    socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'nope' }));
    const error = await waitForMessage(socket, (m) => m.type === 'error');

    expect(error).toMatchObject({ type: 'error', event: { errorKind: 'RULE_PROFILE_ERROR' } });
  });

  it('applyRuleProfile with no ruleEngine and no createRuleEngine broadcasts RULE_PROFILE_ERROR (old behavior, unchanged)', async () => {
    writeRuleProfile('two-rules', { rules: [routeRule('a'), routeRule('b')] }, profilesDir);
    handle = await startDashboardServer({ port: 0, ruleProfileStore }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules' && m.data === null);

    socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'two-rules' }));
    const error = await waitForMessage(socket, (m) => m.type === 'error');

    expect(error).toMatchObject({ type: 'error', event: { errorKind: 'RULE_PROFILE_ERROR' } });
  });

  /**
   * Issue #123: a session started with no `--rules`/auto-detected file has
   * `ruleEngine: undefined` — before `createRuleEngine` existed,
   * `applyRuleProfile` failed outright here even though the profile being
   * switched to had just been created successfully in the very same
   * session (`createRuleProfile` never needed a `ruleEngine` to begin
   * with). This exercises the fix directly against `startDashboardServer`,
   * mirroring how `cli.ts`'s own `createDefaultRuleEngine` behaves: lazily
   * loads a real `RuleEngine` backed by a real file the first time it's
   * needed, at most once.
   */
  it('applyRuleProfile lazily provisions a RuleEngine via createRuleEngine when the session started with none', async () => {
    writeRuleProfile('two-rules', { rules: [routeRule('a'), routeRule('b')] }, profilesDir);
    writeRuleProfile('three-rules', { rules: [routeRule('a'), routeRule('b'), routeRule('c')] }, profilesDir);
    let created = 0;
    const lazyPath = path.join(dir, 'lazy-rules.json');
    const createRuleEngine = () => {
      created++;
      fsRulesFileWriter.write(lazyPath, { rules: [] });
      ruleEngine = RuleEngine.load({
        filePath: lazyPath,
        reader: fsRulesFileReader,
        writer: fsRulesFileWriter,
        watcher: fsFileWatcher,
        debounceMs: 10,
        onReload: (info) =>
          eventBus.emit('rulesReloaded', {
            filePath: lazyPath,
            ruleCount: info.ruleCount,
            unreachableWarnings: info.unreachableWarnings,
          }),
        onReloadError: (message) => eventBus.emit('error', { errorKind: 'RULES_RELOAD_ERROR', message }),
      });
      return ruleEngine;
    };
    handle = await startDashboardServer({ port: 0, ruleProfileStore, createRuleEngine }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules' && m.data === null);

    socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'two-rules' }));
    const first = await waitForMessage(socket, (m) => m.type === 'rules' && m.data?.rules.length === 2);
    expect(first).toEqual({
      type: 'rules',
      data: { rules: [routeRule('a'), routeRule('b')], $activeProfile: 'two-rules' },
      unreachableWarnings: findUnreachableRules([routeRule('a'), routeRule('b')]),
    });
    expect(created).toBe(1);
    expect(fs.existsSync(lazyPath)).toBe(true);

    // A second apply reuses the same engine rather than provisioning another.
    socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'three-rules' }));
    const second = await waitForMessage(socket, (m) => m.type === 'rules' && m.data?.rules.length === 3);
    expect(second).toEqual({
      type: 'rules',
      data: { rules: [routeRule('a'), routeRule('b'), routeRule('c')], $activeProfile: 'three-rules' },
      unreachableWarnings: findUnreachableRules([routeRule('a'), routeRule('b'), routeRule('c')]),
    });
    expect(created).toBe(1);
  });

  /**
   * Copilot review, PR #123: `createRuleEngine` provisioning (a real
   * filesystem write, then `RuleEngine.load`) can throw — the initial fix
   * called it outside `applyRuleProfile`'s own `try`/`catch`, so that
   * exception reached the outer `socket.on('message', ...)` handler's own
   * catch-and-ignore (meant only for a malformed frame), silently dropping
   * the whole message instead of ever broadcasting a `RULE_PROFILE_ERROR` —
   * the dashboard would just look stuck, with nothing telling the user why.
   */
  it('applyRuleProfile broadcasts a RULE_PROFILE_ERROR (not a dropped message) when createRuleEngine itself throws', async () => {
    writeRuleProfile('two-rules', { rules: [routeRule('a'), routeRule('b')] }, profilesDir);
    const createRuleEngine = (): RuleEngine => {
      throw new Error('boom: disk full');
    };
    handle = await startDashboardServer({ port: 0, ruleProfileStore, createRuleEngine }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules' && m.data === null);

    socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'two-rules' }));
    const error = await waitForMessage(socket, (m) => m.type === 'error');

    expect(error).toMatchObject({
      type: 'error',
      event: { errorKind: 'RULE_PROFILE_ERROR', message: expect.stringContaining('boom: disk full') },
    });
  });

  /**
   * Copilot review, PR #123: the initial fix called `ensureRuleEngine()`
   * (and so `createRuleEngine`, with its real side effect of writing a
   * rules file and starting a file watcher) *before* checking whether
   * `ruleProfileStore` was even configured — provisioning an engine for a
   * request that was always going to be rejected regardless, in a session
   * that's missing the *other* half of Rule Profiles entirely.
   */
  it('applyRuleProfile with no ruleProfileStore never calls createRuleEngine', async () => {
    let called = false;
    const createRuleEngine = (): RuleEngine => {
      called = true;
      throw new Error('should never be reached');
    };
    handle = await startDashboardServer({ port: 0, createRuleEngine }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'rules' && m.data === null);

    socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'anything' }));
    const error = await waitForMessage(socket, (m) => m.type === 'error');

    expect(error).toMatchObject({ type: 'error', event: { errorKind: 'RULE_PROFILE_ERROR' } });
    expect(called).toBe(false);
  });
});
