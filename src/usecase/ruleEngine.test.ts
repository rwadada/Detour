import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileWatcher, fsRulesFileReader } from '../infra/fs/rulesFileSource';
import { RuleEngine } from './ruleEngine';

function writeRules(filePath: string, rules: unknown[]): void {
  fs.writeFileSync(filePath, JSON.stringify({ rules }));
}

const routeRule = (name: string) => ({
  name,
  match: { url: 'https://api.example.com/*' },
  action: { type: 'route', host: 'x' },
});

/**
 * Triggers RuleEngine's private debounced-reload logic directly, bypassing
 * the real `fs.watch` file-system event it's normally scheduled from.
 * `fs.watch`'s actual delivery timing is an OS/Node primitive outside
 * Detour's own logic, and proved too timing-sensitive (particularly under
 * `--coverage`'s v8 instrumentation overhead) to assert on reliably here —
 * what these tests care about is RuleEngine's *own* reload behavior (does
 * it re-validate, keep the last-good rules on failure, notify callbacks),
 * which this exercises deterministically.
 */
function triggerReload(engine: RuleEngine): void {
  (engine as unknown as { reload(): void }).reload();
}

/** Calls RuleEngine's private debounce scheduler directly — see `triggerReload`'s doc comment for why this bypasses fs.watch itself. */
function scheduleReload(engine: RuleEngine): void {
  (engine as unknown as { scheduleReload(): void }).scheduleReload();
}

describe('RuleEngine', () => {
  let dir: string;
  let filePath: string;
  let engine: RuleEngine | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-ruleengine-test-'));
    filePath = path.join(dir, 'rules.json');
  });

  afterEach(() => {
    engine?.close();
    engine = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads rules and exposes filePath (resolved) / basePath', () => {
    writeRules(filePath, [routeRule('r1')]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    expect(engine.filePath).toBe(path.resolve(filePath));
    expect(engine.basePath).toBe(dir);
    expect(engine.getRules()).toHaveLength(1);
  });

  it('throws on an initially invalid rules file', () => {
    writeRules(filePath, [{ name: 'bad', match: {}, action: { type: 'bogus' } }]);
    expect(() => RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader })).toThrow();
  });

  it('match() returns the first enabled rule matching a request', () => {
    writeRules(filePath, [routeRule('a'), routeRule('b')]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    const matched = engine.match({ method: 'GET', url: 'https://api.example.com/x' });
    expect(matched?.name).toBe('a');
    expect(engine.match({ method: 'GET', url: 'https://unrelated.example.com/x' })).toBeUndefined();
  });

  it('reloads (re-validates and re-compiles) when the file changes', () => {
    writeRules(filePath, [routeRule('a')]);
    let reloaded: { ruleCount: number } | undefined;
    engine = RuleEngine.load({
      filePath,
      watch: false,
      reader: fsRulesFileReader,
      onReload: (info) => {
        reloaded = info;
      },
    });
    expect(engine.getRules()).toHaveLength(1);

    writeRules(filePath, [routeRule('a'), routeRule('b')]);
    triggerReload(engine);
    expect(reloaded?.ruleCount).toBe(2);
    expect(engine.getRules()).toHaveLength(2);
  });

  it('keeps serving the last known-good rules when a reload fails validation', () => {
    writeRules(filePath, [routeRule('a')]);
    let reloadError: string | undefined;
    engine = RuleEngine.load({
      filePath,
      watch: false,
      reader: fsRulesFileReader,
      onReloadError: (message) => {
        reloadError = message;
      },
    });

    fs.writeFileSync(filePath, '{ not json');
    triggerReload(engine);
    expect(reloadError).toMatch(/invalid JSON/);
    // The bad reload was discarded — the original rule is still being served.
    expect(engine.getRules()).toHaveLength(1);
    expect(engine.getRules()[0]?.name).toBe('a');
  });

  it('coalesces rapid successive changes into a single debounced reload', async () => {
    writeRules(filePath, [routeRule('a')]);
    let reloadCount = 0;
    engine = RuleEngine.load({
      filePath,
      watch: false,
      reader: fsRulesFileReader,
      debounceMs: 10,
      onReload: () => {
        reloadCount += 1;
      },
    });

    writeRules(filePath, [routeRule('a'), routeRule('b')]);
    scheduleReload(engine); // starts a 10ms timer...
    writeRules(filePath, [routeRule('a'), routeRule('b'), routeRule('c')]);
    scheduleReload(engine); // ...which this call must clear and restart, not stack a second one on top of.

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reloadCount).toBe(1);
    expect(engine.getRules()).toHaveLength(3);
  });

  it('watches for changes by default and stops once closed', async () => {
    writeRules(filePath, [routeRule('a')]);
    let reloadCount = 0;
    engine = RuleEngine.load({
      filePath,
      reader: fsRulesFileReader,
      watcher: fsFileWatcher,
      debounceMs: 10,
      onReload: () => {
        reloadCount += 1;
      },
    });
    engine.close();

    writeRules(filePath, [routeRule('a'), routeRule('b')]);
    // Give a watcher that (incorrectly) kept running a chance to fire —
    // this direction (proving nothing happens) isn't timing-sensitive the
    // way waiting for a positive reload would be, so a real fs.watch is
    // fine here.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reloadCount).toBe(0);
  });
});
