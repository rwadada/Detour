import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installProcessCrashGuards, resolveDashboardPort, shouldAutoOpenDashboard } from './cli';

/**
 * `resolveDashboardPort` is the one piece of pure, synchronous logic in
 * `cli.ts` (a callback-driven composition root otherwise exercised by
 * `cli.e2e.test.ts` — see vitest.config.ts's coverage comment) — issue #24's
 * port spec change: `--dashboard-port` defaults to `--port + 1000` instead
 * of a fixed `4040`.
 */
describe('resolveDashboardPort (issue #24)', () => {
  it('defaults to proxyPort + 1000 when --dashboard-port is omitted', () => {
    expect(resolveDashboardPort(8080, undefined)).toBe(9080);
  });

  it('honors an explicit --dashboard-port over the default', () => {
    expect(resolveDashboardPort(8080, '4040')).toBe(4040);
  });

  it('keeps 0 (ephemeral) as ephemeral rather than deriving 1000 — a real port would defeat the point of asking for an OS-assigned one', () => {
    expect(resolveDashboardPort(0, undefined)).toBe(0);
  });

  it('still honors an explicit --dashboard-port 0 alongside proxyPort 0', () => {
    expect(resolveDashboardPort(0, '0')).toBe(0);
  });

  it('rejects an explicit --dashboard-port outside 0-65535', () => {
    expect(() => resolveDashboardPort(8080, '70000')).toThrow(/--dashboard-port/);
  });

  it('throws rather than silently overflowing when the derived port would exceed 65535', () => {
    expect(() => resolveDashboardPort(65000, undefined)).toThrow(/65535/);
  });
});

/**
 * `shouldAutoOpenDashboard` decides whether `detour start` fires the
 * dashboard open in a browser automatically. Pulled out as pure logic so
 * its three exclusions (see cli.ts's doc comment on it) are each testable
 * without spawning a real CLI process.
 */
describe('shouldAutoOpenDashboard', () => {
  it('opens when open is requested, the port is real, and the dashboard is built', () => {
    expect(shouldAutoOpenDashboard({ open: true, dashboardPort: 9080, built: true })).toBe(true);
  });

  it('skips when --no-open was passed', () => {
    expect(shouldAutoOpenDashboard({ open: false, dashboardPort: 9080, built: true })).toBe(false);
  });

  it('skips an ephemeral dashboardPort of 0 (test-only --port 0 / --dashboard-port 0)', () => {
    expect(shouldAutoOpenDashboard({ open: true, dashboardPort: 0, built: true })).toBe(false);
  });

  it('skips when the dashboard has not been built yet', () => {
    expect(shouldAutoOpenDashboard({ open: true, dashboardPort: 9080, built: false })).toBe(false);
  });
});

/**
 * `installProcessCrashGuards` (issue #94) keeps the process alive across an
 * unanticipated `uncaughtException`/`unhandledRejection` instead of dying —
 * but must still mark the eventual exit as a failure (`process.exitCode`),
 * or a short-lived command that hits one would silently exit 0.
 */
describe('installProcessCrashGuards (issue #94)', () => {
  const originalExitCode = process.exitCode;
  // Snapshotting and removing only the listeners *this suite* adds, rather
  // than `removeAllListeners` — the latter would also wipe out listeners
  // installed by the test runner itself (vitest registers its own for
  // reporting unhandled errors in other tests), a global side effect this
  // suite has no business causing.
  let uncaughtBefore: readonly NodeJS.UncaughtExceptionListener[];
  let rejectionBefore: readonly NodeJS.UnhandledRejectionListener[];

  beforeEach(() => {
    uncaughtBefore = process.listeners('uncaughtException');
    rejectionBefore = process.listeners('unhandledRejection');
  });

  afterEach(() => {
    for (const listener of process.listeners('uncaughtException')) {
      if (!uncaughtBefore.includes(listener)) process.removeListener('uncaughtException', listener);
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!rejectionBefore.includes(listener)) process.removeListener('unhandledRejection', listener);
    }
    process.exitCode = originalExitCode;
  });

  it('sets a non-zero exitCode on an uncaught exception, without crashing', () => {
    installProcessCrashGuards();
    process.exitCode = 0;
    process.emit('uncaughtException', new Error('boom'));
    expect(process.exitCode).toBe(1);
  });

  it('sets a non-zero exitCode on an unhandled rejection, without crashing', () => {
    installProcessCrashGuards();
    process.exitCode = 0;
    process.emit(
      'unhandledRejection',
      new Error('boom'),
      Promise.reject().catch(() => {}),
    );
    expect(process.exitCode).toBe(1);
  });
});
