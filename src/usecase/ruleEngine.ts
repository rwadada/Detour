import path from 'node:path';
import {
  compileRule,
  findMatchingRule,
  findMatchingRules,
  type CompiledRule,
  type MatchableRequest,
  type MatchedRules,
} from '../domain/rules/matcher';
import { pickMockAction } from '../domain/rules/mockSequence';
import { findDisabledScriptWarnings, type ScriptGateWarning } from '../domain/rules/scriptGate';
import type { MockAction, Rule, RulesFile } from '../domain/rules/types';
import { findUnreachableRules, type UnreachableRuleWarning } from '../domain/rules/unreachableRules';
import type { FileWatcher } from './ports/fileWatcher';
import type { RulesFileReader } from './ports/rulesFileReader';
import type { RulesFileWriter } from './ports/rulesFileWriter';

/**
 * Compiles every rule, wrapping any failure with the rules file's path and
 * the offending rule's name/index. `validateRulesData` (domain/rules/schema.ts)
 * already rejects an un-compilable `urlRegex`/`urlRegexFlags` before a file
 * ever reaches here, so this should be unreachable in practice — but it's
 * cheap insurance against a reader that skips that check (or a future
 * `match`/`compileRule` mismatch) leaving a bare RegExp error with no clue
 * which file or rule caused it (see issue #97).
 */
function compileRules(rules: readonly Rule[], filePath: string): CompiledRule[] {
  return rules.map((rule, index) => {
    try {
      return compileRule(rule);
    } catch (err) {
      const label = rule.name ? `"${rule.name}"` : `#${index}`;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Rules file failed to compile: ${filePath}\n  - rules[${index}] (${label}): ${reason}`, {
        cause: err,
      });
    }
  });
}

export interface RuleEngineOptions {
  /** Path to rules.json. Resolved relative to the current working directory if not absolute. */
  filePath: string;
  /** Watch the file and reload on change. Defaults to true. */
  watch?: boolean;
  /** Debounce window for coalescing the several fs events one save can produce, in ms. */
  debounceMs?: number;
  onReload?: (info: {
    ruleCount: number;
    unreachableWarnings: UnreachableRuleWarning[];
    scriptWarnings: ScriptGateWarning[];
  }) => void;
  onReloadError?: (message: string) => void;
  /** Reads/validates rules.json — injected so this UseCase never touches the filesystem directly (see infra/fs/rulesFileSource.ts). */
  reader: RulesFileReader;
  /** Watches rules.json for changes — injected for the same reason. Required unless `watch` is false. */
  watcher?: FileWatcher;
  /** Validates/writes rules.json — injected for the same reason. Required to call `write()` (issue #19's Rules editor); omit for a read-only engine. */
  writer?: RulesFileWriter;
  /**
   * Issue #98's `detour start --allow-external-script-paths` opt-in:
   * whether a `script.path`/`mock.bodyFile` may resolve outside `basePath`
   * (an absolute path, or `../` traversal) instead of being rejected at
   * rule-match time. Defaults to `false` — a rules.json write (e.g. via the
   * dashboard's `setRules`) otherwise can't point either at an arbitrary
   * file on disk. See `resolveRulePath`'s doc comment.
   */
  allowExternalScriptPaths?: boolean;
  /**
   * Issue #161's `detour start --allow-scripts` opt-in: whether a `script`
   * rule's `beforeRequest`/`beforeResponse` hooks actually run at all.
   * Defaults to `false` — a `script` module runs as arbitrary JavaScript
   * with detour's own process permissions (up to and including its CA
   * private key), and `setRules` can otherwise reach an existing one over
   * the network with nothing but a dashboard password (or nothing at all)
   * in the way. Doesn't affect whether `script` rules are *matched* (they
   * still take priority the same way any other terminal rule would); see
   * `findDisabledScriptWarnings` for what a `script` rule does when this is
   * off, and `infra/proxy/scriptModuleLoader.ts`'s `tryLoadScriptModule`
   * for where that's actually enforced.
   */
  allowScripts?: boolean;
}

/**
 * Loads `rules.json`, compiles its rules for fast matching, and (by
 * default) watches the file so edits take effect without restarting the
 * proxy. A reload that fails validation is logged (via `onReloadError`)
 * and discarded — the previously loaded rules keep serving traffic.
 */
export class RuleEngine {
  readonly filePath: string;
  /** Directory rules.json lives in — the base for relative paths like `mock.bodyFile`. */
  readonly basePath: string;
  /** See `RuleEngineOptions.allowExternalScriptPaths`'s doc comment. */
  readonly allowExternalScriptPaths: boolean;
  /** See `RuleEngineOptions.allowScripts`'s doc comment. */
  readonly allowScripts: boolean;
  private compiledRules: CompiledRule[];
  /** See `findUnreachableRules`'s doc comment — recomputed alongside `compiledRules` in the constructor and `reload()`, so it's always in sync with whatever rules are actually loaded. */
  private unreachableWarnings: UnreachableRuleWarning[];
  /** See `findDisabledScriptWarnings`'s doc comment — kept in sync the same way `unreachableWarnings` is. */
  private scriptWarnings: ScriptGateWarning[];
  /** See `RulesFile.$activeProfile`'s doc comment — mirrors whatever the on-disk file's own field currently says, kept in sync by `reload()` the same way `compiledRules` is. */
  private activeProfile: string | undefined;
  /**
   * How many times each `mock` rule with a `responses` sequence has
   * matched so far, keyed by `Rule` object identity (issue #181's
   * sequential responses — see `MockAction.responses`'s doc comment and
   * `resolveMockAction` below). A `WeakMap` rather than tracking this on
   * the rule itself: rules are plain data owned by callers too (e.g. the
   * dashboard's Rules editor), and reloading rules.json (or a hand-edit
   * that happens to produce byte-identical content) always parses a brand
   * new set of `Rule` objects — so recreating this alongside
   * `compiledRules` in `reload()` is enough to reset every rule's count
   * back to 0 without needing to identify *which* rules changed.
   */
  private mockCallCounts = new WeakMap<Rule, number>();
  private stopWatching?: () => void;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private readonly options: RuleEngineOptions;

  private constructor(filePath: string, data: RulesFile, options: RuleEngineOptions) {
    this.filePath = filePath;
    this.basePath = path.dirname(filePath);
    this.allowExternalScriptPaths = options.allowExternalScriptPaths ?? false;
    this.allowScripts = options.allowScripts ?? false;
    this.compiledRules = compileRules(data.rules, filePath);
    this.unreachableWarnings = findUnreachableRules(data.rules);
    this.scriptWarnings = findDisabledScriptWarnings(data.rules, this.allowScripts);
    this.activeProfile = data.$activeProfile;
    this.options = options;
  }

  /** Loads rules.json (throwing on an invalid initial file) and starts watching it unless disabled. */
  static load(options: RuleEngineOptions): RuleEngine {
    const filePath = path.resolve(options.filePath);
    const data = options.reader.read(filePath);
    const engine = new RuleEngine(filePath, data, options);
    if (options.watch !== false) engine.startWatching();
    return engine;
  }

  match(req: MatchableRequest): Rule | undefined {
    return findMatchingRule(this.compiledRules, req);
  }

  /** See `findMatchingRules`'s doc comment — used for the main HTTP(S) request/response path, where `rewrite` rules stack instead of shadowing one another. */
  matchAll(req: MatchableRequest): MatchedRules {
    return findMatchingRules(this.compiledRules, req);
  }

  getRules(): readonly Rule[] {
    return this.compiledRules.map((c) => c.rule);
  }

  /** See `findUnreachableRules`'s doc comment. A defensive copy, like `getRules()` — a caller mutating the returned array must not corrupt this engine's own internal state. */
  getUnreachableWarnings(): readonly UnreachableRuleWarning[] {
    return [...this.unreachableWarnings];
  }

  /** See `findDisabledScriptWarnings`'s doc comment. A defensive copy, same reasoning as `getUnreachableWarnings()`. */
  getScriptWarnings(): readonly ScriptGateWarning[] {
    return [...this.scriptWarnings];
  }

  /** See `RulesFile.$activeProfile`'s doc comment. `undefined` when the current content isn't (or isn't known to still be) any saved profile's. */
  getActiveProfile(): string | undefined {
    return this.activeProfile;
  }

  /**
   * Resolves the effective `mock` action for one match of `rule` — see
   * `MockAction.responses`'s doc comment (issue #181). Named distinctly
   * from `usecase/resolveMockAction.ts`'s unrelated `resolveMockAction`
   * function (which turns an already-*chosen* action's `body`/`bodyFile`
   * into a `MockResponse`) to avoid the two being mistaken for each other.
   * `rule.action` must be a `mock` action; the only caller
   * (`requestHandler`'s mock branch) already knows this, having just
   * checked `terminal.action.type === 'mock'` itself.
   *
   * Advances (and owns) the call counter as a side effect: each call
   * consumes the next step in `rule.action.responses`, so this must be
   * called at most once per actual match, not speculatively. Rules with no
   * `responses` never touch the counter at all, returning `rule.action`
   * unchanged — same as `pickMockAction` itself.
   */
  resolveMockStep(rule: Rule): MockAction {
    const action = rule.action as MockAction;
    if (!action.responses || action.responses.length === 0) return action;
    const callIndex = this.mockCallCounts.get(rule) ?? 0;
    this.mockCallCounts.set(rule, callIndex + 1);
    return pickMockAction(action, callIndex);
  }

  /**
   * Validates and saves `rules` to disk (issue #19's Rules editor). Doesn't
   * update `compiledRules`/`activeProfile` itself — the write lands back
   * through the same `fs.watch`-driven reload path a manual edit would (see
   * `reload()`), keeping "edited from the dashboard" and "edited in a text
   * editor" a single code path instead of two. Throws (without writing
   * anything) if `rules` fails validation, or no `writer` was configured.
   *
   * `activeProfile` sets `RulesFile.$activeProfile` on the written file —
   * omit it (the common case: a plain dashboard/hand edit) to clear
   * whatever it was before, rather than carry the old one forward onto
   * content that, post-edit, may no longer actually match it.
   */
  write(rules: Rule[], opts?: { activeProfile?: string }): void {
    if (!this.options.writer) throw new Error('RuleEngine: a `writer` is required to save rule edits');
    this.options.writer.write(this.filePath, { rules, $activeProfile: opts?.activeProfile });
  }

  private startWatching(): void {
    if (!this.options.watcher) {
      throw new Error('RuleEngine: a `watcher` is required when `watch` is not false');
    }
    this.stopWatching = this.options.watcher.watch(
      this.filePath,
      () => this.scheduleReload(),
      (message) => this.options.onReloadError?.(`Error watching the rules file: ${message}`),
    );
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.reload(), this.options.debounceMs ?? 150);
  }

  private reload(): void {
    try {
      const data = this.options.reader.read(this.filePath);
      this.compiledRules = compileRules(data.rules, this.filePath);
      // Fresh `Rule` objects just got parsed above — see `mockCallCounts`'s
      // own doc comment on why a brand new `WeakMap` is enough to reset
      // every sequential mock rule's count back to 0 here.
      this.mockCallCounts = new WeakMap();
      this.unreachableWarnings = findUnreachableRules(data.rules);
      this.scriptWarnings = findDisabledScriptWarnings(data.rules, this.allowScripts);
      this.activeProfile = data.$activeProfile;
      // Defensive copy — same reasoning as `getUnreachableWarnings()`, so a
      // listener mutating what it's handed can't corrupt this engine's own
      // internal state.
      this.options.onReload?.({
        ruleCount: data.rules.length,
        unreachableWarnings: [...this.unreachableWarnings],
        scriptWarnings: [...this.scriptWarnings],
      });
    } catch (err) {
      // Keep serving the last known-good rules rather than crash the proxy.
      this.options.onReloadError?.(err instanceof Error ? err.message : String(err));
    }
  }

  close(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.stopWatching?.();
  }
}
