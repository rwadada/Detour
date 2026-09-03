import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { CliExitError } from '../../domain/daemon/errors';

/** How long `spawnDaemonChild` waits for the child to report readiness before giving up and killing it. */
const DEFAULT_READY_TIMEOUT_MS = 20_000;

export interface DaemonReadyInfo {
  pid: number;
  proxyPort: number;
  /** Absent when the daemon was started with `--headless`. */
  dashboardPort?: number;
}

interface SpawnDaemonChildOptions {
  /** The entry script to re-invoke (`process.argv[1]` — works whether the parent itself is running via `tsx src/cli.ts`, `node bin/detour.js`, or a global install). */
  scriptPath: string;
  /** Full argv to hand the child after `scriptPath` (e.g. `['start', '--port', '8080', ...]`) — deliberately excludes `--detach` itself, since the child runs in the foreground path. */
  args: string[];
  /** Absolute path the child's stdout/stderr are appended to. */
  logFile: string;
  readyTimeoutMs?: number;
}

type ChildMessage =
  | { type: 'ready'; proxyPort: number; dashboardPort?: number }
  | { type: 'error'; message: string; exitCode: number };

function isChildMessage(value: unknown): value is ChildMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type: unknown }).type;
  return type === 'ready' || type === 'error';
}

/**
 * Spawns `scriptPath args` as a detached background process (daemon mode,
 * issue #20's `--detach`) and waits for it to report readiness over IPC
 * before resolving — so by the time `detour start --detach` itself returns,
 * the daemon is genuinely accepting traffic, not merely forked. Mirrors the
 * child-side `signalDaemonReady`/`signalDaemonError` below, which are what
 * actually send that message.
 *
 * The child's stdout/stderr are redirected to `logFile` (there's no
 * terminal to print to once the parent exits); the 'ipc' channel exists
 * solely for this startup handshake — the child disconnects it as soon as
 * it signals ready/error, so the child's continued lifetime never depends
 * on the parent (already `unref`'d here) staying alive.
 */
export function spawnDaemonChild(options: SpawnDaemonChildOptions): Promise<DaemonReadyInfo> {
  const logFd = fs.openSync(options.logFile, 'a');
  const child = spawn(
    process.execPath,
    // `process.execArgv` carries whatever Node-level flags launched *this*
    // process — critically, in dev, `tsx`'s own `--require .../preflight.cjs
    // --import .../loader.mjs` (registered as real argv flags, not
    // `NODE_OPTIONS`, so they wouldn't otherwise survive a fresh `node`
    // invocation). Without re-passing these, the child would try to load
    // `src/cli.ts`'s TypeScript/ESM source as plain CommonJS and fail
    // immediately. In prod (`bin/detour.js` running the built `dist/cli.js`
    // under plain `node`), this is simply `[]` — a no-op.
    [...process.execArgv, options.scriptPath, ...options.args],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      // Lets the child report its own log file back in its `RunState` (see
      // `runStateStore.ts`) for `detour status` to display, without adding a
      // CLI flag purely for that — the child never chose this path itself.
      env: { ...process.env, DETOUR_LOG_FILE: options.logFile },
    },
  );

  return new Promise((resolve, reject) => {
    const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      cleanup();
      child.kill();
      reject(
        new Error(`timed out after ${timeoutMs}ms waiting for the daemon to become ready — check ${options.logFile}`),
      );
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onMessage = (raw: unknown): void => {
      if (!isChildMessage(raw)) return;
      cleanup();
      child.disconnect();
      child.unref();
      if (raw.type === 'ready') {
        resolve({ pid: child.pid!, proxyPort: raw.proxyPort, dashboardPort: raw.dashboardPort });
      } else {
        reject(new CliExitError(raw.message, raw.exitCode));
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new Error(`the daemon process exited before it finished starting (code ${code}) — check ${options.logFile}`),
      );
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/** Whether the current process was spawned by `spawnDaemonChild` above (has a live IPC channel to a waiting parent). */
export function isDaemonChild(): boolean {
  return typeof process.send === 'function';
}

/**
 * Tells a waiting `spawnDaemonChild` parent that startup succeeded, then
 * drops the IPC channel — a no-op when not running as a daemon child (see
 * `isDaemonChild`), so callers can call this unconditionally after a
 * successful `detour start` regardless of how it was launched.
 */
export function signalDaemonReady(info: { proxyPort: number; dashboardPort?: number }): void {
  if (typeof process.send !== 'function') return;
  process.send({ type: 'ready', ...info } satisfies ChildMessage, () => process.disconnect());
}

/** Same as `signalDaemonReady`, for a startup failure — `exitCode` propagates to the parent's own exit code (see `CliExitError`). */
export function signalDaemonError(message: string, exitCode: number): void {
  if (typeof process.send !== 'function') return;
  process.send({ type: 'error', message, exitCode } satisfies ChildMessage, () => process.disconnect());
}
