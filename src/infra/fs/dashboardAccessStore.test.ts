import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isValidDashboardToken } from '../../domain/auth/dashboardAccess';
import { loadOrCreateDashboardToken, resolveDashboardToken } from './dashboardAccessStore';

describe('loadOrCreateDashboardToken', () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-dashboard-access-store-'));
    tokenPath = path.join(dir, '.detour', 'dashboard-token');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a valid token on first use, and keeps returning the same one (so a restart or update does not lock tabs out)', () => {
    const first = loadOrCreateDashboardToken(tokenPath);
    expect(isValidDashboardToken(first)).toBe(true);
    expect(loadOrCreateDashboardToken(tokenPath)).toBe(first);
    expect(fs.readFileSync(tokenPath, 'utf8').trim()).toBe(first);
  });

  it.skipIf(process.platform === 'win32')('keeps the file and its directory owner-only', () => {
    loadOrCreateDashboardToken(tokenPath);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(tokenPath)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')('tightens a token file that was left world-readable', () => {
    const token = loadOrCreateDashboardToken(tokenPath);
    // Deliberately world-readable: this is the state the code under test must repair.
    // eslint-disable-next-line sonarjs/file-permissions
    fs.chmodSync(tokenPath, 0o644);
    expect(loadOrCreateDashboardToken(tokenPath)).toBe(token);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('replaces an empty or malformed file with a fresh token', () => {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, 'too short\n');
    const token = loadOrCreateDashboardToken(tokenPath);
    expect(token).not.toBe('too short');
    expect(isValidDashboardToken(token)).toBe(true);
  });

  describe('resolveDashboardToken (what `detour start` calls)', () => {
    it('uses DETOUR_DASHBOARD_TOKEN when it is valid, without touching the persisted file', () => {
      const token = resolveDashboardToken({ DETOUR_DASHBOARD_TOKEN: 'my-chosen-token-0123456789' }, tokenPath);
      expect(token).toBe('my-chosen-token-0123456789');
      expect(fs.existsSync(tokenPath)).toBe(false);
    });

    it.each(['short', 'has space in it 0123456789', 'quote"0123456789abcdef'])(
      'throws for a set-but-unusable DETOUR_DASHBOARD_TOKEN (%j) instead of silently ignoring it',
      (bad) => {
        expect(() => resolveDashboardToken({ DETOUR_DASHBOARD_TOKEN: bad }, tokenPath)).toThrow(
          /DETOUR_DASHBOARD_TOKEN must be at least 16 characters/,
        );
      },
    );

    it('falls back to the persisted token when the variable is unset or empty', () => {
      const persisted = loadOrCreateDashboardToken(tokenPath);
      expect(resolveDashboardToken({}, tokenPath)).toBe(persisted);
      expect(resolveDashboardToken({ DETOUR_DASHBOARD_TOKEN: '' }, tokenPath)).toBe(persisted);
    });
  });
});
