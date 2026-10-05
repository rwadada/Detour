import type { UpdateService } from '../../domain/update/updateService';

const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
/** A forced re-check within this long of the last real lookup reuses it, so "Check now" spam can't burn GitHub's anonymous rate limit. */
const FORCE_MIN_INTERVAL_MS = 30 * 1000;

export interface UpdateServiceDeps {
  currentVersion: string;
  canSelfUpdate: boolean;
  fetchLatestVersion: () => Promise<string>;
  startUpdater: (onExit: (exitCode: number | null) => void) => Promise<void>;
  now?: () => number;
}

/** Wraps the release lookup in a cache (long for success, short for failure so an offline machine isn't re-polled per connection). */
export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const now = deps.now ?? Date.now;
  let cached: { latest: string | null; expiresAt: number; fetchedAt: number } | undefined;
  let inFlight: Promise<string | null> | undefined;

  const refresh = async (): Promise<string | null> => {
    let latest: string | null;
    try {
      latest = await deps.fetchLatestVersion();
    } catch {
      latest = null;
    }
    cached = { latest, expiresAt: now() + (latest === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS), fetchedAt: now() };
    return latest;
  };

  return {
    currentVersion: deps.currentVersion,
    canSelfUpdate: deps.canSelfUpdate,
    async getLatestVersion(options) {
      const fresh = cached && now() < cached.expiresAt;
      const recentEnough = cached && now() - cached.fetchedAt < FORCE_MIN_INTERVAL_MS;
      if (cached && (options?.force ? recentEnough : fresh)) return cached.latest;
      inFlight ??= refresh().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    startUpdate: deps.startUpdater,
  };
}
