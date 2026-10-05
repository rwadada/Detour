import { useState } from 'react';
import type { UpdateInfo, UpdatePhase } from '../model/createUpdateStore';
import { useUpdateStore } from '../model/store';

const BUTTON = 'rounded px-2 py-0.5 font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20 disabled:opacity-50';

function BannerText({
  info,
  phase,
  message,
  confirming,
}: {
  info: UpdateInfo;
  phase: UpdatePhase;
  message: string | undefined;
  confirming: boolean;
}) {
  if (phase === 'updating') {
    return (
      <>Updating to Detour {info.latest}… Detour will restart and this page will reload (this can take a minute).</>
    );
  }
  if (phase === 'failed' && !confirming) return <>Update failed: {message}</>;
  return (
    <>
      <strong className="font-semibold">Detour {info.latest}</strong> is available (you have {info.current}).
      {!info.canUpdate && ' Run `detour update` in a terminal to upgrade.'}
      {confirming &&
        ' Every running Detour instance will restart. This list of finished requests is carried over where possible; other instances lose their captured traffic.'}
    </>
  );
}

/**
 * Shown across the top of the app when a newer Detour release exists. The
 * Update button is two-step (an inline confirm, not a native dialog) since it
 * restarts this very process; whether it's offered at all is the server's
 * call (`canUpdate`) — otherwise the user is pointed at `detour update`.
 */
export function UpdateBanner() {
  const info = useUpdateStore((s) => s.info);
  const phase = useUpdateStore((s) => s.phase);
  const message = useUpdateStore((s) => s.message);
  const dismissedVersion = useUpdateStore((s) => s.dismissedVersion);
  const startUpdate = useUpdateStore((s) => s.startUpdate);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const [confirming, setConfirming] = useState(false);

  if (!info?.updateAvailable || (phase === 'idle' && dismissedVersion === info.latest)) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--accent)]/10 px-3 py-1.5 text-xs"
    >
      <span className="text-[var(--foreground)]">
        <BannerText info={info} phase={phase} message={message} confirming={confirming} />
      </span>
      {phase !== 'updating' && (
        <div className="flex shrink-0 items-center gap-2">
          {info.canUpdate && !confirming && (
            <button type="button" className={BUTTON} onClick={() => setConfirming(true)}>
              {phase === 'failed' ? 'Retry' : 'Update now'}
            </button>
          )}
          {info.canUpdate && confirming && (
            <>
              <button
                type="button"
                className={BUTTON}
                onClick={() => {
                  setConfirming(false);
                  startUpdate();
                }}
              >
                Restart and update
              </button>
              <button type="button" className={BUTTON} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          )}
          {!confirming && (
            <button type="button" className={BUTTON} onClick={dismiss}>
              Later
            </button>
          )}
        </div>
      )}
    </div>
  );
}
