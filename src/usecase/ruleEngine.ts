import path from 'node:path';
import { compileRule, findMatchingRule, type CompiledRule, type MatchableRequest } from '../domain/rules/matcher';
import type { Rule } from '../domain/rules/types';
import type { FileWatcher } from './ports/fileWatcher';
import type { RulesFileReader } from './ports/rulesFileReader';

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
  private stopWatching?: () => void;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private readonly options: RuleEngineOptions;

  private constructor(filePath: string, rules: Rule[], options: RuleEngineOptions) {
    this.filePath = filePath;
    this.basePath = path.dirname(filePath);
    this.compiledRules = rules.map(compileRule);
    this.options = options;
  }

  /** Loads rules.json (throwing on an invalid initial file) and starts watching it unless disabled. */
  static load(options: RuleEngineOptions): RuleEngine {
    const filePath = path.resolve(options.filePath);
    const { rules } = options.reader.read(filePath);
    const engine = new RuleEngine(filePath, rules, options);
    if (options.watch !== false) engine.startWatching();
    return engine;
  }

  match(req: MatchableRequest): Rule | undefined {
    return findMatchingRule(this.compiledRules, req);
  }

  getRules(): readonly Rule[] {
    return this.compiledRules.map((c) => c.rule);
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
      const { rules } = this.options.reader.read(this.filePath);
      this.compiledRules = rules.map(compileRule);
      this.options.onReload?.({ ruleCount: rules.length });
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
