import fs from 'node:fs';
import type { ScriptModule } from '../../domain/rules/scriptAction';
import type { ScriptModuleLoader } from '../../usecase/ports/scriptModuleLoader';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  module: ScriptModule;
}

const cache = new Map<string, CacheEntry>();

function isScriptModule(value: unknown): value is ScriptModule {
  if (typeof value !== 'object' || value === null) return false;
  const mod = value as Record<string, unknown>;
  return (
    (mod.beforeRequest === undefined || typeof mod.beforeRequest === 'function') &&
    (mod.beforeResponse === undefined || typeof mod.beforeResponse === 'function')
  );
}

/** Clears the module cache — exported for tests only, so each test starts from a clean slate regardless of shared file paths (e.g. reused tmp filenames) or leftover state from a previous test. */
export function __resetScriptModuleCacheForTests(): void {
  cache.clear();
}

/**
 * Loads (and caches) a `script` rule's CommonJS module off disk
 * (`module.exports = { beforeRequest, beforeResponse }`, matching this
 * project's own module system — see `package.json`'s `"type": "commonjs"`).
 * Re-checks the file's mtime/size on every call and transparently reloads
 * when either changed, so editing a script takes effect without restarting
 * `detour` — the same live-reload experience `rules.json` itself already
 * has (issue #9). `require.cache` is deliberately cleared for the file
 * before re-requiring it; otherwise Node would just hand back the module it
 * already loaded once, stale content and all.
 */
export const fsScriptModuleLoader: ScriptModuleLoader = {
  load(filePath: string): ScriptModule {
    const stat = fs.statSync(filePath);
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.module;
    }
    const resolved = require.resolve(filePath);
    delete require.cache[resolved];
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- scripts are loaded by a runtime-resolved path (a rules.json `script.path`), which a static `import` can't express.
    const exported: unknown = require(resolved);
    if (!isScriptModule(exported)) {
      throw new Error(
        `script module at "${filePath}" must export an object with optional \`beforeRequest\`/\`beforeResponse\` function properties`,
      );
    }
    cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, module: exported });
    return exported;
  },
};
