import { useUpdateStore } from '../model/store';

const BUTTON =
  'rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--row-hover)] disabled:opacity-50';

/** The server's own words for what failed ("could not reach GitHub … (ENOTFOUND)", "GitHub returned HTTP 403 …"), capitalised; a generic line when it sent none. */
function unreachableMessage(failure: string | undefined): string {
  if (!failure) return "Couldn't check for updates.";
  return `${failure.charAt(0).toUpperCase()}${failure.slice(1)}.`;
}

/**
 * Sidebar row showing the running version with a "Check for updates" button —
 * the way to re-check on demand, since the server otherwise caches the release
 * lookup for hours. Renders nothing when this install has no update check
 * (no `updateInfo` ever arrives). A found update is announced by the banner;
 * this only reports the outcome of the click in words.
 */
export function UpdateCheck() {
  const info = useUpdateStore((s) => s.info);
  const checkState = useUpdateStore((s) => s.checkState);
  const phase = useUpdateStore((s) => s.phase);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);

  if (!info) return null;

  const checking = checkState === 'checking';
  let result: string | null = null;
  if (checkState === 'timeout') result = 'No answer from Detour. Try again.';
  else if (checkState === 'checked') {
    if (info.latest === null) result = unreachableMessage(info.failure);
    else if (info.updateAvailable) result = `Detour ${info.latest} is available.`;
    else result = "You're up to date.";
  }

  return (
    <section>
      <h2 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Version</h2>
      <div className="flex items-center gap-2">
        <span className="font-mono-ui text-xs">{info.current}</span>
        <button type="button" className={BUTTON} disabled={checking || phase === 'updating'} onClick={checkForUpdate}>
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      {result && (
        <p role="status" className="mt-1.5 text-xs text-[var(--muted)]">
          {result}
        </p>
      )}
    </section>
  );
}
