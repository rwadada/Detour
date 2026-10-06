import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateDashboardToken,
  isValidDashboardToken,
  MIN_DASHBOARD_TOKEN_LENGTH,
} from '../../domain/auth/dashboardAccess';

/** `~/.detour/dashboard-token` — the persisted dashboard access token (issue #205). */
export function resolveDashboardTokenPath(): string {
  return path.join(os.homedir(), '.detour', 'dashboard-token');
}

/**
 * Returns the dashboard's access token, creating and persisting one the first
 * time.
 *
 * Persisted rather than regenerated on every start for two reasons: a
 * `detour update` (or any restart) would otherwise lock a still-open
 * dashboard tab out until its owner copied a new URL, and cookies are scoped
 * to a host, not a port — two Detour instances on different ports share one
 * cookie jar entry, so they have to agree on the secret behind it.
 *
 * The file sits next to the CA private key and holds an equivalent kind of
 * local secret, so it gets the same treatment: `~/.detour` owner-only, the
 * file 0600.
 */
export function loadOrCreateDashboardToken(tokenPath: string = resolveDashboardTokenPath()): string {
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (isValidDashboardToken(existing)) {
      // A file left readable by something else is not secret any more.
      if (process.platform !== 'win32') fs.chmodSync(tokenPath, 0o600);
      return existing;
    }
  } catch {
    // Missing or unreadable: make a new one below.
  }
  const token = generateDashboardToken();
  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  // `wx`-free on purpose: an invalid/empty leftover file has to be replaced.
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(tokenPath, 0o600);
  return token;
}

/**
 * The token `detour start` uses: `DETOUR_DASHBOARD_TOKEN` when set (for
 * scripts and tests that need a known value), otherwise the persisted one.
 * A set-but-unusable value is an error rather than being silently ignored —
 * falling back would leave the caller holding a token the dashboard does not
 * actually accept.
 */
export function resolveDashboardToken(env: NodeJS.ProcessEnv = process.env, tokenPath?: string): string {
  const fromEnv = env.DETOUR_DASHBOARD_TOKEN;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!isValidDashboardToken(fromEnv)) {
      throw new Error(
        `DETOUR_DASHBOARD_TOKEN must be at least ${MIN_DASHBOARD_TOKEN_LENGTH} characters from A-Z a-z 0-9 . _ ~ -`,
      );
    }
    return fromEnv;
  }
  return loadOrCreateDashboardToken(tokenPath);
}
