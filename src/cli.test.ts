import { describe, expect, it } from 'vitest';
import { resolveDashboardPort } from './cli';

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
