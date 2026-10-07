import { normalizeVersion, parseVersion } from '../../domain/update/version';

const LATEST_RELEASE_URL = 'https://api.github.com/repos/rwadada/Detour/releases/latest';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * What a rejected `fetch()` actually failed on. Node's message is just "fetch
 * failed"; the reason (`ENOTFOUND`, `ECONNREFUSED`, a certificate error, …) is
 * on `cause`, and a timeout is a `TimeoutError` with its own message.
 */
export function describeFetchFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'TimeoutError') return `no answer within ${REQUEST_TIMEOUT_MS / 1000}s`;
  const cause = err.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' && code !== '' ? `${code}: ${cause.message}` : cause.message;
  }
  return err.message;
}

/** Version (no leading `v`) of the newest published GitHub release. */
export async function fetchLatestReleaseVersion(): Promise<string> {
  let response: Response;
  try {
    response = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'detour-update-check' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`could not reach GitHub to check for updates (${describeFetchFailure(err)})`, { cause: err });
  }
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status} when checking for updates`);
  }
  const body = (await response.json()) as { tag_name?: unknown };
  if (typeof body.tag_name !== 'string' || !parseVersion(body.tag_name)) {
    throw new Error('GitHub returned an unrecognised release tag');
  }
  return normalizeVersion(body.tag_name);
}
