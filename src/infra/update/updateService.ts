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
  let cached: { latest: string | null; failure: string | null; expiresAt: number; fetchedAt: number } | undefined;
  let inFlight: Promise<string | null> | undefined;

  const refresh = async (): Promise<string | null> => {
    let latest: string | null;
    let failure: string | null = null;
    try {
      latest = await deps.fetchLatestVersion();
    } catch (err) {
      latest = null;
      failure = err instanceof Error ? err.message : String(err);
    }
    cached = {
      latest,
      failure,
      expiresAt: now() + (latest === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS),
      fetchedAt: now(),
    };
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
    lastFailure: () => cached?.failure ?? null,
    startUpdate: deps.startUpdater,
  };
}
