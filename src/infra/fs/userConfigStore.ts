import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Persistent user preferences for `detour start`, distinct from a run's
 * per-invocation flags (`--port`, `--rules`, etc.) and from the ephemeral
 * per-port state in `runStateStore.ts`. Currently just the one knob
 * (`defaultDetach`), set via `detour config --default-detach <on|off>` and
 * read back by `resolveShouldDetach` in cli.ts — grows here as more
 * "remember this across invocations" settings show up.
 */
export interface UserConfig {
  /** When `true`, `detour start` runs detached (as if `--detach` were passed) unless overridden by `--detach`/`--foreground` on that invocation. Undefined (the file's absent, or the key was never set) means "off" — foreground stays the out-of-the-box default. */
  defaultDetach?: boolean;
  /** Keys this version of detour doesn't know about (an older config written by a future version, hand-edited extras, …) — kept around so `writeUserConfig`'s read-modify-write merge doesn't drop them. */
  [key: string]: unknown;
}

/** Mirrors `resolveRunDir`/`resolveDumpDir`/`resolveCertDir`'s `~/.detour/<subdir>` convention — this one has no subdirectory of its own since it's a single file, not a collection. */
export function resolveUserConfigPath(): string {
  return path.join(os.homedir(), '.detour', 'config.json');
}

/**
 * Reads `~/.detour/config.json` (or `configPath`, overridable for tests).
 * A missing file is the common case (nothing has ever been configured) and
 * quietly resolves to `{}`, but a file that exists and fails to parse, or
 * doesn't hold the expected shape, throws — same "fail loudly on a broken
 * config rather than silently ignore it" stance as `loadRulesFile`.
 */
export function loadUserConfig(configPath: string = resolveUserConfigPath()): UserConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }

  const config = parsed as UserConfig;
  if (config.defaultDetach !== undefined && typeof config.defaultDetach !== 'boolean') {
    throw new Error(`${configPath}: "defaultDetach" must be a boolean (got: ${JSON.stringify(config.defaultDetach)})`);
  }
  return config;
}

/**
 * Merges `patch` into the config on disk and writes it back — reads with
 * `loadUserConfig` first so setting one key never clobbers others already
 * saved there. Creates `~/.detour/` if this is the first thing ever written
 * under it (unlike `resolveRunDir`/`resolveDumpDir`, there's no earlier
 * guaranteed writer that would have created the parent directory already).
 */
export function writeUserConfig(patch: UserConfig, configPath: string = resolveUserConfigPath()): UserConfig {
  const merged = { ...loadUserConfig(configPath), ...patch };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
