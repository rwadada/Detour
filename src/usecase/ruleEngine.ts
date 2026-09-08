import path from 'node:path';
import { compileRule, findMatchingRule, type CompiledRule, type MatchableRequest } from '../domain/rules/matcher';
import type { Rule, RulesFile } from '../domain/rules/types';
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
  onReload?: (info: { ruleCount: number }) => void;
  onReloadError?: (message: string) => void;
  /** Reads/validates rules.json — injected so this UseCase never touches the filesystem directly (see infra/fs/rulesFileSource.ts). */
  reader: RulesFileReader;
  /** Watches rules.json for changes — injected for the same reason. Required unless `watch` is false. */
  watcher?: FileWatcher;
  /** Validates/writes rules.json — injected for the same reason. Required to call `write()` (issue #19's Rules editor); omit for a read-only engine. */
  writer?: RulesFileWriter;
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
  private compiledRules: CompiledRule[];
  /** See `RulesFile.$activeProfile`'s doc comment — mirrors whatever the on-disk file's own field currently says, kept in sync by `reload()` the same way `compiledRules` is. */
  private activeProfile: string | undefined;
  private stopWatching?: () => void;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private readonly options: RuleEngineOptions;

  private constructor(filePath: string, data: RulesFile, options: RuleEngineOptions) {
    this.filePath = filePath;
    this.basePath = path.dirname(filePath);
    this.compiledRules = compileRules(data.rules, filePath);
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

  getRules(): readonly Rule[] {
    return this.compiledRules.map((c) => c.rule);
  }

  /** See `RulesFile.$activeProfile`'s doc comment. `undefined` when the current content isn't (or isn't known to still be) any saved profile's. */
  getActiveProfile(): string | undefined {
    return this.activeProfile;
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
      this.activeProfile = data.$activeProfile;
      this.options.onReload?.({ ruleCount: data.rules.length });
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
