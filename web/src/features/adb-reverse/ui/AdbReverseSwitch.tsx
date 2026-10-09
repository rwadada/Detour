import { cn } from '@/shared/lib/utils';
import { useAdbReverseStore } from '../model/store';

/**
 * Sidebar row: keep `adb reverse` in place for USB Android devices, so a phone set up over USB
 * keeps reaching this proxy after the cable is pulled and plugged back in (`--adb-reverse`).
 * Renders nothing when the server has no such switch (no `adbReverseState` ever arrives).
 *
 * A client that did not prove the password or access token sees the state but cannot change
 * it — the server would refuse, so the switch is disabled and says why rather than looking
 * clickable and doing nothing.
 */
export function AdbReverseSwitch() {
  const info = useAdbReverseStore((s) => s.info);
  const pending = useAdbReverseStore((s) => s.pending);
  const setEnabled = useAdbReverseStore((s) => s.setEnabled);

  if (!info) return null;

  const disabled = !info.canChange || pending;
  const devices = info.usbDevices === 1 ? '1 USB device' : `${info.usbDevices} USB devices`;

  return (
    <section>
      <h2 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Android (USB)</h2>
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={info.enabled}
          aria-label="Keep adb reverse in place for USB Android devices"
          disabled={disabled}
          onClick={() => setEnabled(!info.enabled)}
          className={cn(
            'relative h-4 w-7 shrink-0 rounded-full border transition-colors disabled:opacity-50',
            info.enabled ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--muted)] bg-transparent',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-2.5 w-2.5 rounded-full transition-all',
              info.enabled ? 'left-3.5 bg-[var(--bg)]' : 'left-0.5 bg-[var(--muted)]',
            )}
          />
        </button>
        <span className="text-xs">Keep adb reverse</span>
      </div>
      <p role="status" className="mt-1.5 text-xs text-[var(--muted)]">
        {info.enabled
          ? `Restoring tcp:${info.port} on every USB device that connects — ${devices} now.`
          : `Off: unplugging the cable drops tcp:${info.port} until detour setup is run again.`}
      </p>
      {!info.canChange && (
        <p className="mt-1 text-xs text-[var(--muted)]">
          Open the Dashboard URL that detour start printed (with the access token) to change this.
        </p>
      )}
    </section>
  );
}
