import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isValidPasswordHash } from '../../domain/auth/passwordHash';
import { isValidProxyAuthCredentials, type ProxyAuthCredentials } from '../../domain/auth/proxyAuth';
import { invalidHostPatternReason } from '../../domain/focus/focusPolicy';
import { ensureOwnerOnlyDir, writeOwnerOnlyFile } from './ownerOnly';

/**
 * Persistent user preferences for `detour start`, distinct from a run's
 * per-invocation flags (`--port`, `--rules`, etc.) and from the ephemeral
 * per-port state in `runStateStore.ts`. Set via `detour config` (or the
 * dashboard's Settings panel, which reads/writes the same file over the
 * `userConfig`/`setUserConfig` WebSocket messages — see
 * `dashboardServer.ts`) and read back by `resolveShouldDetach`/
 * `resolveDashboardHost` in cli.ts — grows here as more "remember this
 * across invocations" settings show up.
 */
export interface UserConfig {
  /** When `true`, `detour start` runs detached (as if `--detach` were passed) unless overridden by `--detach`/`--foreground` on that invocation. Undefined (the file's absent, or the key was never set) means "off" — foreground stays the out-of-the-box default. */
  defaultDetach?: boolean;
  /** When `true`, `detour start` binds the *dashboard* to every network interface (`0.0.0.0`) instead of just `localhost`, unless overridden by `--lan`/`--no-lan` on that invocation. Undefined means "off" — `localhost`-only stays the out-of-the-box default for the dashboard, since LAN access lets anything on the network try for the dashboard's secret. Never affects the proxy, which always binds to every interface regardless — see cli.ts's `PROXY_HOST`. */
  lanAccess?: boolean;
  /**
   * A hashed password (see `domain/auth/passwordHash.ts`'s `hashPassword`)
   * that a browser must submit (over the `/ws` connection's `login` message —
   * see `dashboardServer.ts`) before the dashboard server will send it any
   * live traffic, rules, or accept any control message. `null`/undefined
   * means no password is required — the out-of-the-box default, unauthenticated
   * like every other dashboard feature. Set via `detour config
   * --dashboard-password <value>` (`"off"` clears it) or the dashboard's
   * Settings panel; never stored in plaintext. Unlike `defaultDetach`/
   * `lanAccess` above, this takes effect immediately for new connections —
   * it gates a WebSocket message, not a TCP bind fixed at process spawn.
   */
  dashboardPasswordHash?: string | null;
  /**
   * Credentials every client must present (`Proxy-Authorization: Basic …`)
   * before the *proxy* will serve it — issue #158, the proxy-side
   * counterpart to `dashboardPasswordHash` above. `null`/undefined means no
   * authentication, the out-of-the-box default: an open forward proxy
   * anything on the network can point itself at, which is exactly what this
   * exists to let you close.
   *
   * Set via `detour config --proxy-auth <user:pass>` (`"off"` clears it);
   * the password is stored only as the scrypt hash `hashPassword` produces,
   * never in plaintext. Unlike the dashboard password, this is read once at
   * `detour start` (it gates a TCP-level handshake, not a WebSocket
   * message), so changing it needs a restart to take effect — and
   * `--proxy-auth` on `detour start` overrides it for that one run.
   */
  proxyAuth?: ProxyAuthCredentials | null;
  /** Auto TLS passthrough (see `ProxyServerOptions.autoPassthrough`) for `detour start` unless overridden by `--auto-passthrough`/`--no-auto-passthrough` on that invocation. Undefined means "on" — the out-of-the-box default. Set via `detour config --auto-passthrough on|off`; read at `detour start`, so a change needs a restart. */
  autoPassthrough?: boolean;
  /** Intercept's state at `detour start` (issue #301) unless overridden by `--intercept`/`--no-intercept` on that invocation. Undefined means "on". Set via `detour config --intercept on|off`; read at `detour start`, so a change needs a restart (the dashboard toggle changes only the running session). */
  intercept?: boolean;
  /** Focus host patterns at `detour start` (issue #301) unless overridden by `--focus`/`--no-focus` on that invocation. Undefined or empty means Focus off (every host is intercepted). Set via `detour config --focus <patterns>` (`"off"` clears it); read at `detour start`. */
  focusHosts?: string[];
  /** Keys this version of detour doesn't know about (an older config written by a future version, hand-edited extras, …) — kept around so `writeUserConfig`'s read-modify-write merge doesn't drop them. */
  [key: string]: unknown;
}

/** Mirrors `resolveRunDir`/`resolveDumpDir`/`resolveCertDir`'s `~/.detour/<subdir>` convention — this one has no subdirectory of its own since it's a single file, not a collection. */
export function resolveUserConfigPath(): string {
  return path.join(os.homedir(), '.detour', 'config.json');
}

/**
 * `UserConfig`'s explicitly-typed fields, named separately from `UserConfig`
 * itself so `WRITABLE_KEYS` below can be checked against them: `UserConfig`
 * carries a `[key: string]: unknown` index signature (so it can hold keys
 * this version of detour doesn't know about — see its own doc comment),
 * and TypeScript collapses `keyof` on any type with an index signature down
 * to that signature's key type (`string`, here) — so `keyof UserConfig`
 * can't actually catch a typo'd field name the way `keyof
 * KnownUserConfigFields` (no index signature to collapse into) can.
 */
type KnownUserConfigFields = Required<
  Pick<
    UserConfig,
    | 'defaultDetach'
    | 'lanAccess'
    | 'dashboardPasswordHash'
    | 'proxyAuth'
    | 'autoPassthrough'
    | 'intercept'
    | 'focusHosts'
  >
>;

/**
 * Every field `writeUserConfig` will actually apply from a `patch` — see
 * its doc comment for why this is a whitelist rather than a plain object
 * spread of the whole patch.
 */
const WRITABLE_KEYS = [
  'defaultDetach',
  'lanAccess',
  'dashboardPasswordHash',
  'proxyAuth',
  'autoPassthrough',
  'intercept',
  'focusHosts',
] as const satisfies readonly (keyof KnownUserConfigFields)[];

/**
 * Shared by `loadUserConfig` (validating whatever's already on disk) and
 * `writeUserConfig` (validating the merged result *before* it's written) —
 * without the latter, a `setUserConfig` WebSocket message with a malformed
 * value (a stray frontend bug, a hand-crafted frame, or — once `--lan`/
 * `lanAccess` is on — literally anything else on the network) would write
 * straight through with no check at all, corrupting the file for every
 * `detour start`/`detour config` invocation afterwards until someone
 * noticed and hand-edited it.
 */
function validateUserConfig(config: UserConfig, configPath: string): void {
  if (config.defaultDetach !== undefined && typeof config.defaultDetach !== 'boolean') {
    throw new Error(`${configPath}: "defaultDetach" must be a boolean (got: ${JSON.stringify(config.defaultDetach)})`);
  }
  if (config.lanAccess !== undefined && typeof config.lanAccess !== 'boolean') {
    throw new Error(`${configPath}: "lanAccess" must be a boolean (got: ${JSON.stringify(config.lanAccess)})`);
  }
  if (config.autoPassthrough !== undefined && typeof config.autoPassthrough !== 'boolean') {
    throw new Error(
      `${configPath}: "autoPassthrough" must be a boolean (got: ${JSON.stringify(config.autoPassthrough)})`,
    );
  }
  if (config.intercept !== undefined && typeof config.intercept !== 'boolean') {
    throw new Error(`${configPath}: "intercept" must be a boolean (got: ${JSON.stringify(config.intercept)})`);
  }
  if (
    config.focusHosts !== undefined &&
    // Each one a pattern that could match a host (the same check as `--focus`): a blank entry normalizes away, and
    // a URL or a space-joined pair never matches — either way the saved Focus would not be what it looks like.
    (!Array.isArray(config.focusHosts) ||
      !config.focusHosts.every((host) => typeof host === 'string' && invalidHostPatternReason(host) === undefined))
  ) {
    throw new Error(
      `${configPath}: "focusHosts" must be an array of host patterns like "api.example.com" or "*.example.net" (got: ${JSON.stringify(config.focusHosts)})`,
    );
  }
  if (
    config.dashboardPasswordHash !== undefined &&
    config.dashboardPasswordHash !== null &&
    // Validates the *whole* `<saltHex>:<hashHex>` shape, not just "is a
    // non-empty string" — `verifyPassword` uses this exact same
    // check (see its own doc comment), so anything that fails it can never
    // actually verify a password either way. Left unchecked here, such a
    // value would still leave `dashboardServer.ts`'s `dashboardPasswordSet`
    // reporting "on" while every login attempt against it fails: an
    // unrecoverable lockout with no way out except editing the config file
    // or `detour config --dashboard-password off` by hand, rather than
    // failing loudly right here where it was written.
    (typeof config.dashboardPasswordHash !== 'string' || !isValidPasswordHash(config.dashboardPasswordHash))
  ) {
    throw new Error(
      `${configPath}: "dashboardPasswordHash" must be a valid hash produced by hashPassword, or null (got: ${JSON.stringify(config.dashboardPasswordHash)})`,
    );
  }
  // Same reasoning as `dashboardPasswordHash` above, one step worse in
  // consequence: a malformed `proxyAuth` (issue #158) would make
  // `detour start` demand credentials that nothing can ever satisfy, so
  // every single request through the proxy would 407 with no hint as to why.
  if (config.proxyAuth !== undefined && config.proxyAuth !== null && !isValidProxyAuthCredentials(config.proxyAuth)) {
    throw new Error(
      `${configPath}: "proxyAuth" must be { "username": <non-empty string>, "passwordHash": <a hash produced by hashPassword> }, or null (got: ${JSON.stringify(config.proxyAuth)})`,
    );
  }
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
  validateUserConfig(config, configPath);
  return config;
}

/**
 * Merges `patch` into the config on disk and writes it back — reads with
 * `loadUserConfig` first so setting one key never clobbers others already
 * saved there. Creates `~/.detour/` if this is the first thing ever written
 * under it (unlike `resolveRunDir`/`resolveDumpDir`, there's no earlier
 * guaranteed writer that would have created the parent directory already).
 *
 * Only ever copies `WRITABLE_KEYS` out of `patch` — deliberately not a
 * plain `{ ...existing, ...patch }` spread. `patch` is only ever
 * type-checked as `UserConfig` at compile time, which a `JSON.parse`d
 * `setUserConfig` WebSocket message defeats entirely; spreading it wholesale
 * would persist whatever extra keys it happened to carry (`__proto__`
 * included — harmless against *this* object per plain-object spread
 * semantics, but there's no reason to trust or store it either way).
 * `existing`'s own unknown keys are still preserved untouched — this only
 * narrows what's accepted *from the patch*, the same "don't drop what a
 * future version or a hand-edit left there" contract `UserConfig`'s index
 * signature documents.
 *
 * Validates the merged result before writing, same as `loadUserConfig` does
 * on read — the one place a malformed value (`lanAccess: 'yes'`, say) gets
 * caught before it reaches disk.
 */
export function writeUserConfig(patch: UserConfig, configPath: string = resolveUserConfigPath()): UserConfig {
  const merged: UserConfig = { ...loadUserConfig(configPath) };
  for (const key of WRITABLE_KEYS) copyIfDefined(merged, patch, key);
  validateUserConfig(merged, configPath);
  // `~/.detour` owner-only (this may be the first thing ever written under it),
  // and the file a new 0600 one renamed into place: it can carry
  // `dashboardPasswordHash`/`proxyAuth.passwordHash`, which someone with read
  // access could brute-force offline, so the new content must never sit under
  // an older file's looser permissions, even for an instant (issue #96).
  ensureOwnerOnlyDir(path.dirname(configPath));
  writeOwnerOnlyFile(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/**
 * Copies `source[key]` into `target[key]` when it's not `undefined` —
 * factored out of `writeUserConfig`'s loop above so the assignment stays
 * generic over a single `K`, rather than the loop's own `key` (typed as the
 * whole `WRITABLE_KEYS` union). Now that `KnownUserConfigFields` no longer
 * has every field the same type (`dashboardPasswordHash` is `string | null`
 * alongside the boolean `defaultDetach`/`lanAccess`), indexing both objects
 * with an uncorrelated union key lets TypeScript pick mismatched branches
 * across the two accesses; binding it to one `K` per call fixes each access
 * to the same field's own type instead.
 */
function copyIfDefined<K extends keyof KnownUserConfigFields>(target: UserConfig, source: UserConfig, key: K): void {
  const value = source[key];
  if (value !== undefined) target[key] = value;
}
