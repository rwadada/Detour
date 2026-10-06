import { PROTOCOL_VERSION } from '@/shared/api';
import { isProtocolMismatch } from '../model/createProxyInfoStore';
import { useProxyInfoStore } from '../model/proxyInfoStore';

/**
 * Shown across the top of the app when the server speaks a different wire
 * protocol than this page was built for (issue #209) — typically a cached
 * page or installed PWA that outlived a Detour update. Without it the
 * mismatch only ever shows up as a broken view or controls that do nothing.
 */
export function ProtocolMismatchBanner() {
  const mismatch = useProxyInfoStore((s) => isProtocolMismatch(s));
  const serverVersion = useProxyInfoStore((s) => s.serverProtocolVersion);

  if (!mismatch) return null;

  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--status-5xx)]/10 px-3 py-1.5 text-xs"
    >
      <span className="text-[var(--foreground)]">
        <strong className="font-semibold">This page is out of date.</strong> It speaks protocol {PROTOCOL_VERSION} but
        Detour is running {serverVersion === null ? 'an older one' : `protocol ${serverVersion}`}, so some views and
        controls may not work. Reload to get the matching dashboard.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="shrink-0 rounded px-2 py-0.5 font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
      >
        Reload
      </button>
    </div>
  );
}
