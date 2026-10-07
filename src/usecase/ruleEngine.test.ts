import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileWatcher, fsRulesFileReader, fsRulesFileWriter } from '../infra/fs/rulesFileSource';
import type { Rule } from '../domain/rules/types';
import { RuleEngine } from './ruleEngine';

function writeRules(filePath: string, rules: unknown[]): void {
  fs.writeFileSync(filePath, JSON.stringify({ rules }));
}

const routeRule = (name: string): Rule => ({
  name,
  match: { url: 'https://api.example.com/*' },
  action: { type: 'route', host: 'x' },
});

const scriptRule = (name: string, path = 'hook.js'): Rule => ({
  name,
  match: { url: 'https://api.example.com/*' },
  action: { type: 'script', path },
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

  it('defaults allowExternalScriptPaths to false, and honors an explicit true (issue #98)', () => {
    writeRules(filePath, [routeRule('r1')]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    expect(engine.allowExternalScriptPaths).toBe(false);
    engine.close();
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader, allowExternalScriptPaths: true });
    expect(engine.allowExternalScriptPaths).toBe(true);
  });

  it('defaults allowScripts to false, and honors an explicit true (issue #161)', () => {
    writeRules(filePath, [routeRule('r1')]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    expect(engine.allowScripts).toBe(false);
    engine.close();
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader, allowScripts: true });
    expect(engine.allowScripts).toBe(true);
  });

  it('reports a scriptWarning for every script rule while allowScripts is off, and none once it is on (issue #161)', () => {
    writeRules(filePath, [routeRule('r1'), scriptRule('s1')]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    expect(engine.getScriptWarnings()).toEqual([expect.objectContaining({ ruleName: 's1', ruleIndex: 1 })]);
    engine.close();

    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader, allowScripts: true });
    expect(engine.getScriptWarnings()).toEqual([]);
  });

  it('throws on an initially invalid rules file', () => {
    writeRules(filePath, [{ name: 'bad', match: {}, action: { type: 'bogus' } }]);
    expect(() => RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader })).toThrow();
  });

  it('throws with the file path and offending rule name/index for an invalid urlRegex (issue #97)', () => {
    writeRules(filePath, [
      { name: 'bad-regex', match: { urlRegex: '(unterminated' }, action: { type: 'route', host: 'x' } },
    ]);
    expect(() => RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader })).toThrow(
      /rules\.json[\s\S]*"bad-regex"/,
    );
  });

  it('wraps a compile-time failure (defense in depth past schema validation) with file path and rule context', () => {
    // A reader that skips regex-compilability validation (unlike the real
    // fsRulesFileReader post-#97) so we can exercise RuleEngine's own
    // wrapping of a `compileRule` failure independent of the schema check.
    const badRule: Rule = {
      name: 'sneaky',
      match: { urlRegex: '(unterminated' },
      action: { type: 'route', host: 'x' },
    };
    const reader = { read: () => ({ rules: [badRule] }) };
    expect(() => RuleEngine.load({ filePath, watch: false, reader })).toThrow(
      /Rules file failed to compile.*rules\.json[\s\S]*"sneaky"/,
    );
  });

  it('match() returns the first enabled rule matching a request', () => {
    writeRules(filePath, [routeRule('a'), routeRule('b')]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    const matched = engine.match({ method: 'GET', url: 'https://api.example.com/x' });
    expect(matched?.name).toBe('a');
    expect(engine.match({ method: 'GET', url: 'https://unrelated.example.com/x' })).toBeUndefined();
  });

  it('getUnreachableWarnings() flags a rule provably shadowed by an earlier catch-all, and stays in sync across a reload', () => {
    const catchAll: Rule = { name: 'catch-all', match: { url: '*' }, action: { type: 'mock' } };
    const dead: Rule = { name: 'dead', match: { url: 'https://api.example.com/x' }, action: { type: 'mock' } };
    writeRules(filePath, [catchAll, dead]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    expect(engine.getUnreachableWarnings().map((w) => w.ruleName)).toEqual(['dead']);

    // Reloading with the shadowing rule removed clears the warning.
    writeRules(filePath, [dead]);
    triggerReload(engine);
    expect(engine.getUnreachableWarnings()).toEqual([]);
  });

  it("getUnreachableWarnings() returns a defensive copy — mutating it must not corrupt the engine's own state (Copilot review, PR #150)", () => {
    const catchAll: Rule = { name: 'catch-all', match: { url: '*' }, action: { type: 'mock' } };
    const dead: Rule = { name: 'dead', match: { url: 'https://api.example.com/x' }, action: { type: 'mock' } };
    writeRules(filePath, [catchAll, dead]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });

    const warnings = engine.getUnreachableWarnings() as unknown[];
    warnings.push({ bogus: true });
    expect(engine.getUnreachableWarnings()).toHaveLength(1);
  });

  it('matchAll() collects every matching rewrite rule ahead of the first terminal one', () => {
    const rewriteA: Rule = {
      name: 'rewrite-a',
      match: { url: 'https://api.example.com/*' },
      action: { type: 'rewrite', request: { headers: { set: { a: '1' } } } },
    };
    writeRules(filePath, [rewriteA, routeRule('terminal')]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    const matched = engine.matchAll({ method: 'GET', url: 'https://api.example.com/x' });
    expect(matched.rewrites.map((r) => r.name)).toEqual(['rewrite-a']);
    expect(matched.terminal?.name).toBe('terminal');
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

  it('write() saves rules to disk and, once reloaded, serves them', () => {
    writeRules(filePath, [routeRule('a')]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader, writer: fsRulesFileWriter });

    engine.write([routeRule('a'), routeRule('b')]);

    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).rules).toHaveLength(2);
    // write() itself doesn't hot-swap compiledRules — it lands back through
    // the same reload path a manual file edit would (see RuleEngine.write's
    // doc comment).
    expect(engine.getRules()).toHaveLength(1);
    triggerReload(engine);
    expect(engine.getRules()).toHaveLength(2);
  });

  it('getActiveProfile() reflects $activeProfile from the file at load, and after a reload', () => {
    fs.writeFileSync(filePath, JSON.stringify({ $activeProfile: 'staging', rules: [routeRule('a')] }));
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    expect(engine.getActiveProfile()).toBe('staging');

    writeRules(filePath, [routeRule('a')]); // a plain hand-edit — no $activeProfile at all
    triggerReload(engine);
    expect(engine.getActiveProfile()).toBeUndefined();
  });

  it('write() sets $activeProfile on the file when given one, and getActiveProfile() picks it up once reloaded', () => {
    writeRules(filePath, [routeRule('a')]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader, writer: fsRulesFileWriter });

    engine.write([routeRule('a'), routeRule('b')], { activeProfile: 'staging' });

    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).$activeProfile).toBe('staging');
    triggerReload(engine);
    expect(engine.getActiveProfile()).toBe('staging');
  });

  it('write() without an activeProfile clears whatever $activeProfile was on the file before, once reloaded', () => {
    fs.writeFileSync(filePath, JSON.stringify({ $activeProfile: 'staging', rules: [routeRule('a')] }));
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader, writer: fsRulesFileWriter });
    expect(engine.getActiveProfile()).toBe('staging');

    engine.write([routeRule('a'), routeRule('b')]); // no opts — a plain edit
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).$activeProfile).toBeUndefined();
    triggerReload(engine);
    expect(engine.getActiveProfile()).toBeUndefined();
  });

  it('write() throws (without touching the file) when no writer was configured', () => {
    writeRules(filePath, [routeRule('a')]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    const before = fs.readFileSync(filePath, 'utf8');

    expect(() => engine?.write([routeRule('a'), routeRule('b')])).toThrow(/writer/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('write() throws (without touching the file) on rules that fail validation', () => {
    writeRules(filePath, [routeRule('a')]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader, writer: fsRulesFileWriter });
    const before = fs.readFileSync(filePath, 'utf8');

    expect(() => engine?.write([{ name: 'bad', match: {}, action: { type: 'bogus' } } as never])).toThrow();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it("resolveMockStep() returns a plain mock rule's action unchanged", () => {
    const mockRule: Rule = {
      name: 'm',
      match: { url: 'https://api.example.com/*' },
      action: { type: 'mock', status: 200 },
    };
    writeRules(filePath, [mockRule]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    const [rule] = engine.getRules();
    expect(engine.resolveMockStep(rule!)).toBe(rule!.action);
  });

  it("resolveMockStep() walks a mock rule's responses sequence across successive calls, then sticks on the last entry", () => {
    const mockRule: Rule = {
      name: 'm',
      match: { url: 'https://api.example.com/*' },
      action: { type: 'mock', status: 200, responses: [{ status: 201 }, { status: 202 }] },
    };
    writeRules(filePath, [mockRule]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    const [rule] = engine.getRules();

    expect(engine.resolveMockStep(rule!).status).toBe(201);
    expect(engine.resolveMockStep(rule!).status).toBe(202);
    expect(engine.resolveMockStep(rule!).status).toBe(202);
  });

  it("resolveMockStep()'s call count is tracked per rule, not shared across different rules", () => {
    const rules: Rule[] = [
      {
        name: 'a',
        match: { url: 'https://a.example.com/*' },
        action: { type: 'mock', responses: [{ status: 201 }] },
      },
      {
        name: 'b',
        match: { url: 'https://b.example.com/*' },
        action: { type: 'mock', responses: [{ status: 202 }] },
      },
    ];
    writeRules(filePath, rules);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    const [a, b] = engine.getRules();

    engine.resolveMockStep(a!);
    expect(engine.resolveMockStep(b!).status).toBe(202);
  });

  it("resolveMockStep()'s call count resets to 0 across a reload (fresh Rule objects)", () => {
    const mockRule = (): unknown => ({
      name: 'm',
      match: { url: 'https://api.example.com/*' },
      action: { type: 'mock', responses: [{ status: 201 }, { status: 202 }] },
    });
    writeRules(filePath, [mockRule()]);
    engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });
    const [before] = engine.getRules();
    engine.resolveMockStep(before!);
    expect(engine.resolveMockStep(before!).status).toBe(202);

    writeRules(filePath, [mockRule()]);
    triggerReload(engine);
    const [after] = engine.getRules();
    expect(engine.resolveMockStep(after!).status).toBe(201);
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

  describe('reloading without a notification callback', () => {
    it('still reloads when no onReload was given (only onReloadError)', () => {
      writeRules(filePath, [routeRule('a')]);
      engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });

      writeRules(filePath, [routeRule('a'), routeRule('b')]);
      triggerReload(engine);

      expect(engine.getRules().map((r) => r.name)).toEqual(['a', 'b']);
    });
  });

  describe('writeAndReload() (issue #212)', () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    /** Reports a change the way a healthy `fs.watch` does, whenever the test says so. */
    function controllableWatcher() {
      let notify: () => void = () => undefined;
      return {
        watcher: {
          watch: (_file: string, onChange: () => void) => {
            notify = onChange;
            return () => undefined;
          },
        },
        fire: () => notify(),
      };
    }

    function load(onReload: () => void, watcher = controllableWatcher().watcher) {
      writeRules(filePath, [routeRule('a')]);
      return RuleEngine.load({
        filePath,
        reader: fsRulesFileReader,
        writer: fsRulesFileWriter,
        watcher,
        debounceMs: 10,
        onReload,
      });
    }

    it('has the new rules live by the time it returns, with no watcher involved', () => {
      let reloads = 0;
      engine = load(() => reloads++);

      const info = engine.writeAndReload([routeRule('a'), routeRule('b')], { activeProfile: 'p' });

      expect(info.ruleCount).toBe(2);
      expect(engine.getRules().map((r) => r.name)).toEqual(['a', 'b']);
      expect(engine.getActiveProfile()).toBe('p');
      expect(reloads).toBe(1);
    });

    it('rejects invalid rules without changing anything', () => {
      engine = load(() => undefined);

      expect(() => engine!.writeAndReload([{ name: 'bad' } as unknown as Rule])).toThrow(/validation/);

      expect(engine.getRules().map((r) => r.name)).toEqual(['a']);
    });

    it('throws when no writer was configured', () => {
      writeRules(filePath, [routeRule('a')]);
      engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader });

      expect(() => engine!.writeAndReload([routeRule('b')])).toThrow(/writer/);
    });

    it("skips the watcher's echo of its own write, so a sequential mock is not reset a moment later", async () => {
      let reloads = 0;
      const { watcher, fire } = controllableWatcher();
      engine = load(() => reloads++, watcher);

      engine.writeAndReload([routeRule('a')]);
      const [rule] = engine.getRules();
      // The test's own position in a sequence: any reload would start it over.
      const countsBefore = (engine as unknown as { mockCallCounts: WeakMap<Rule, number> }).mockCallCounts;
      fire(); // the watcher noticing the write
      await wait(100);

      expect(reloads).toBe(1);
      expect((engine as unknown as { mockCallCounts: WeakMap<Rule, number> }).mockCallCounts).toBe(countsBefore);
      expect(engine.getRules()[0]).toBe(rule);
    });

    it('skips every echo of its own write, however many events (and debounce windows) it is spread over', async () => {
      let reloads = 0;
      const { watcher, fire } = controllableWatcher();
      engine = load(() => reloads++, watcher);

      engine.writeAndReload([routeRule('a')]);
      fire();
      await wait(60); // past the 10 ms debounce: the first echo has been handled...
      fire(); // ...and a second one arrives
      await wait(60);

      expect(reloads).toBe(1);
    });

    it('still reloads for a genuine edit made after the write', async () => {
      let reloads = 0;
      const { watcher, fire } = controllableWatcher();
      engine = load(() => reloads++, watcher);

      engine.writeAndReload([routeRule('a')]);
      fire();
      await wait(100);
      writeRules(filePath, [routeRule('a'), routeRule('c')]); // a hand edit
      fire();
      await wait(100);

      expect(reloads).toBe(2);
      expect(engine.getRules().map((r) => r.name)).toEqual(['a', 'c']);
    });

    it('does not run a reload that was already scheduled before the write', async () => {
      let reloads = 0;
      const { watcher, fire } = controllableWatcher();
      engine = load(() => reloads++, watcher);

      fire(); // a reload is now pending...
      engine.writeAndReload([routeRule('a'), routeRule('b')]); // ...but this one supersedes it
      await wait(100);

      expect(reloads).toBe(1);
    });

    it("does not reload a second time from write()'s fallback timer — it must see that writeAndReload already applied the file", async () => {
      // `writeAndReload` calls `write()`, which arms a fallback reload for a
      // watcher that drops the notification. It has just reloaded itself, so
      // the fallback must stand down: a second reload would reset every
      // sequential mock under the caller (what the control API exists to avoid).
      let reloads = 0;
      engine = load(() => reloads++, controllableWatcher().watcher);

      engine.writeAndReload([routeRule('a'), routeRule('b')]);
      await wait(400); // well past the fallback's debounce(10) + grace(100) ms

      expect(reloads).toBe(1);
    });
  });

  describe('resetMockSequences()', () => {
    it('starts sequential mocks over without reloading the rules', () => {
      const mock: Rule = {
        name: 'seq',
        match: { url: 'https://api.example.com/*' },
        action: { type: 'mock', status: 200, responses: [{ status: 201 }, { status: 202 }] },
      };
      fs.writeFileSync(filePath, JSON.stringify({ rules: [mock] }));
      let reloads = 0;
      engine = RuleEngine.load({ filePath, watch: false, reader: fsRulesFileReader, onReload: () => reloads++ });
      const [rule] = engine.getRules();

      expect(engine.resolveMockStep(rule!).status).toBe(201);
      expect(engine.resolveMockStep(rule!).status).toBe(202);
      engine.resetMockSequences();

      expect(engine.resolveMockStep(rule!).status).toBe(201);
      expect(reloads).toBe(0);
      expect(engine.getRules()[0]).toBe(rule);
    });
  });

  /**
   * `write()` must not depend on `fs.watch` to take effect: a write made
   * within a few ms of the watch being created can go unreported while other
   * processes are busy on the filesystem (see `RuleEngine.write`), and a
   * dashboard save would then never show up. These use a watcher that is
   * deterministic — one that reports nothing, and one that reports like a
   * healthy `fs.watch` — instead of the real thing.
   */
  describe('write() when the file watcher is unreliable', () => {
    const GRACE_PAST_DEBOUNCE_MS = 400;

    /** A watcher that never reports a change — what a dropped `fs.watch` notification looks like. */
    const silentWatcher = { watch: () => () => undefined };

    /** A watcher that reports a change as soon as it is told one happened, like a healthy `fs.watch`. */
    function healthyWatcher() {
      let notify: () => void = () => undefined;
      return {
        watcher: {
          watch: (_file: string, onChange: () => void) => {
            notify = onChange;
            return () => undefined;
          },
        },
        fire: () => notify(),
      };
    }

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    function load(watcher: { watch: (file: string, onChange: () => void) => () => void }, onReload: () => void) {
      writeRules(filePath, [routeRule('a')]);
      return RuleEngine.load({
        filePath,
        reader: fsRulesFileReader,
        writer: fsRulesFileWriter,
        watcher: watcher as never,
        debounceMs: 10,
        onReload,
      });
    }

    it('still reloads — by itself — when the watcher never reports the write', async () => {
      let reloads = 0;
      engine = load(silentWatcher, () => reloads++);

      engine.write([routeRule('a'), routeRule('b')], { activeProfile: 'p' });
      await wait(GRACE_PAST_DEBOUNCE_MS);

      expect(reloads).toBe(1);
      expect(engine.getRules().map((r) => r.name)).toEqual(['a', 'b']);
      expect(engine.getActiveProfile()).toBe('p');
    });

    it('does not reload a second time when the watcher did report the write', async () => {
      let reloads = 0;
      const { watcher, fire } = healthyWatcher();
      engine = load(watcher, () => reloads++);

      engine.write([routeRule('a'), routeRule('b')]);
      fire();
      await wait(GRACE_PAST_DEBOUNCE_MS);

      expect(reloads).toBe(1);
    });

    it('covers several quick writes with a single fallback reload that sees the latest content', async () => {
      let reloads = 0;
      engine = load(silentWatcher, () => reloads++);

      engine.write([routeRule('a'), routeRule('b')]);
      engine.write([routeRule('a'), routeRule('b'), routeRule('c')]);
      await wait(GRACE_PAST_DEBOUNCE_MS);

      expect(reloads).toBe(1);
      expect(engine.getRules().map((r) => r.name)).toEqual(['a', 'b', 'c']);
    });

    it('does not reload after being closed', async () => {
      let reloads = 0;
      engine = load(silentWatcher, () => reloads++);

      engine.write([routeRule('a'), routeRule('b')]);
      engine.close();
      await wait(GRACE_PAST_DEBOUNCE_MS);

      expect(reloads).toBe(0);
    });

    it('leaves an engine that is not watching alone (its writes were never picked up automatically)', async () => {
      let reloads = 0;
      writeRules(filePath, [routeRule('a')]);
      engine = RuleEngine.load({
        filePath,
        reader: fsRulesFileReader,
        writer: fsRulesFileWriter,
        watch: false,
        onReload: () => reloads++,
      });

      engine.write([routeRule('a'), routeRule('b')]);
      await wait(GRACE_PAST_DEBOUNCE_MS);

      expect(reloads).toBe(0);
    });
  });
});
