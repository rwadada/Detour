import fs from 'node:fs';
import path from 'node:path';
import { compileRule, findMatchingRule, type CompiledRule, type MatchableRequest } from './matcher';
import { loadRulesFile } from './loader';
import type { Rule } from './types';

export interface RuleEngineOptions {
  /** Path to rules.json. Resolved relative to the current working directory if not absolute. */
  filePath: string;
  /** Watch the file and reload on change. Defaults to true. */
  watch?: boolean;
  /** Debounce window for coalescing the several fs events one save can produce, in ms. */
  debounceMs?: number;
  onReload?: (info: { ruleCount: number }) => void;
  onReloadError?: (message: string) => void;
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
  private watcher?: fs.FSWatcher;
  private debounceTimer?: NodeJS.Timeout;
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
    const { rules } = loadRulesFile(filePath);
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
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    // Watch the containing directory (not the file itself): editors that
    // save atomically (write temp file + rename) replace the inode, which
    // a watch on the file itself can silently stop tracking.
    this.watcher = fs.watch(dir, (_eventType, filename) => {
      if (filename && filename !== base) return;
      this.scheduleReload();
    });
    this.watcher.on('error', (err) => {
      this.options.onReloadError?.(`Error watching the rules file: ${err.message}`);
    });
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.reload(), this.options.debounceMs ?? 150);
  }

  private reload(): void {
    try {
      const { rules } = loadRulesFile(this.filePath);
      this.compiledRules = rules.map(compileRule);
      this.options.onReload?.({ ruleCount: rules.length });
    } catch (err) {
      // Keep serving the last known-good rules rather than crash the proxy.
      this.options.onReloadError?.(err instanceof Error ? err.message : String(err));
    }
  }

  close(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
  }
}
