import { spawn } from 'node:child_process';
import { splitTrackDevicesFrames, usbDevicesIn } from '../../domain/adbReverse/devices';
import type { CommandRunner } from '../../usecase/ports/commandRunner';

/** A long-running child process whose stdout is read as it arrives — the seam `adb track-devices` goes through, so the watcher can be tested without `adb`. */
export interface StreamingProcess {
  onData(listener: (chunk: Buffer) => void): void;
  /** Fires once, when the process ends for any reason (including a failure to start). */
  onExit(listener: () => void): void;
  kill(): void;
}

export type SpawnStreaming = (command: string, args: string[]) => StreamingProcess;

export const spawnStreaming: SpawnStreaming = (command, args) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let exitListener: (() => void) | undefined;
  let exited = false;
  const fireExit = () => {
    if (exited) return;
    exited = true;
    exitListener?.();
  };
  // A missing `adb` surfaces as an 'error' event, not an exit: both end the process.
  child.once('error', fireExit);
  child.once('exit', fireExit);
  return {
    onData: (listener) => child.stdout.on('data', listener),
    onExit: (listener) => {
      exitListener = listener;
      if (exited) listener();
    },
    kill: () => {
      child.kill();
    },
  };
};

export interface AdbReverseWatcherOptions {
  /** The proxy port to forward: `adb reverse tcp:<port> tcp:<port>`. */
  port: number;
  /** Runs the one-shot `adb reverse` commands. */
  runner: CommandRunner;
  spawn?: SpawnStreaming;
  /** How long to wait before starting `adb track-devices` again after it ended (the `adb` server restarted, or `adb` is not installed). */
  restartDelayMs?: number;
  /** One line per event worth telling the user about (a device got its reverse); never throws. */
  log?: (message: string) => void;
}

export interface AdbReverseWatcher {
  stop(): void;
  isRunning(): boolean;
  /** How many USB devices are currently connected, as of the last list `adb` sent. */
  connectedUsbDevices(): number;
}

const DEFAULT_RESTART_DELAY_MS = 5000;

/**
 * Keeps `adb reverse tcp:<port> tcp:<port>` in place for every USB device that
 * is connected, for as long as it runs.
 *
 * Why this exists: a reverse lives in the `adb` connection to the device, so it
 * is gone as soon as the cable is pulled or the `adb` server restarts — while
 * the device's proxy setting (`localhost:<port>`, written by `detour setup`)
 * stays, pointing at nothing. Following `adb track-devices` and re-applying the
 * reverse each time a USB device shows up closes that gap with no action from
 * the user.
 *
 * Details that matter:
 * - Every list `adb` sends re-applies to every USB device in it, not just the
 *   new ones: `--no-rebind` makes an existing reverse a harmless failure, and a
 *   reverse lost without the device ever leaving the list is repaired too.
 * - `--no-rebind` also means a port someone else already forwards is left
 *   alone rather than taken over.
 * - If `adb track-devices` ends (the server restarted, or `adb` is missing),
 *   it is started again after a delay, until `stop()`.
 */
export function startAdbReverseWatcher(options: AdbReverseWatcherOptions): AdbReverseWatcher {
  const spawnProcess = options.spawn ?? spawnStreaming;
  const restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  const log = options.log ?? (() => {});
  const port = `tcp:${options.port}`;

  let stopped = false;
  let current: StreamingProcess | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let usbCount = 0;
  /** Devices that already had the reverse applied since they last (re)appeared — only to keep the log to one line per reconnect. */
  const logged = new Set<string>();

  const apply = async (serial: string) => {
    try {
      await options.runner.run('adb', ['-s', serial, 'reverse', '--no-rebind', port, port]);
      if (!logged.has(serial)) {
        logged.add(serial);
        log(`adb reverse ${port} restored for ${serial}`);
      }
    } catch {
      // Already in place (--no-rebind), held by another tool, or the device went away
      // again before this ran — nothing to repair either way.
    }
  };

  const onList = (list: string) => {
    // Data `adb track-devices` had already written when it was killed can still arrive after
    // `stop()`; it must not put a reverse back that the user just switched off.
    if (stopped) return;
    const devices = usbDevicesIn(list);
    usbCount = devices.length;
    for (const serial of [...logged]) if (!devices.includes(serial)) logged.delete(serial);
    for (const serial of devices) void apply(serial);
  };

  const start = () => {
    if (stopped) return;
    let pending: Buffer = Buffer.alloc(0);
    const process = spawnProcess('adb', ['track-devices']);
    current = process;
    process.onData((chunk) => {
      const { lists, rest } = splitTrackDevicesFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const list of lists) onList(list);
    });
    process.onExit(() => {
      if (current === process) current = undefined;
      usbCount = 0;
      logged.clear();
      if (stopped) return;
      restartTimer = setTimeout(start, restartDelayMs);
      restartTimer.unref?.();
    });
  };

  start();

  return {
    stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      current?.kill();
      current = undefined;
    },
    isRunning: () => !stopped,
    connectedUsbDevices: () => usbCount,
  };
}
