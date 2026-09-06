import { BookOpen, Check, ChevronLeft, ChevronRight, Copy, QrCode as QrCodeIcon } from 'lucide-react';
import { useState } from 'react';
import { RulesEditorButton } from '@/features/rules-editor';
import { RuleProfilesControl } from '@/features/rules-profiles';
import { SettingsButton } from '@/features/settings-panel';
import { getDashboardConnection, useConnectionStatus } from '@/shared/api';
import { useCopyToClipboard } from '@/shared/lib/useCopyToClipboard';
import { cn } from '@/shared/lib/utils';
import { DetourLogo } from '@/shared/ui';
import { createProxyInfoStore } from '../model/createProxyInfoStore';
import { COLLAPSED_WIDTH, EXPANDED_WIDTH, useSidebarStore } from '../model/createSidebarStore';
import { QrCode } from './QrCode';

// The app's real proxy-info store, wired to the real dashboard connection.
// Defined here (rather than in `model/createProxyInfoStore.ts`) so that
// module stays a pure factory with no import-time side effect — importing
// it in a test never opens a real WebSocket. See the factory's own doc
// comment.
const useProxyInfoStore = createProxyInfoStore(getDashboardConnection());

const STATUS_LABEL: Record<string, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  closed: 'Disconnected',
};
const STATUS_DOT: Record<string, string> = {
  connecting: 'bg-[var(--status-3xx)]',
  open: 'bg-[var(--status-2xx)]',
  closed: 'bg-[var(--status-5xx)]',
};

export function Sidebar() {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  const status = useConnectionStatus();

  return (
    <aside
      style={{ width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
      className="flex h-full shrink-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--sidebar)] transition-[width] duration-150"
    >
      <div className={cn('flex items-center gap-2 border-b border-[var(--border)] p-3', collapsed && 'justify-center')}>
        {/* decorative only when expanded — collapsed, the icon rail has no adjacent "Detour" text, so it stays the accessible label for the whole sidebar. */}
        <DetourLogo className="h-6 w-6 shrink-0 rounded-[5px]" decorative={!collapsed} />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold tracking-tight">Detour</div>
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
              <span
                className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[status], status === 'open' && 'animate-pulse')}
              />
              {STATUS_LABEL[status]}
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="shrink-0 rounded p-1 text-[var(--muted)] hover:bg-[var(--row-hover)] hover:text-[var(--foreground)]"
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
        </button>
      </div>

      {collapsed ? (
        <div className="flex flex-col items-center gap-2 py-3">
          <RulesEditorButton />
          <SettingsButton />
        </div>
      ) : (
        <div className="flex-1 space-y-4 overflow-y-auto p-3">
          <ProxyUrlSection />
          <LanAccessSection />
          <section>
            <h2 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Rules</h2>
            <div className="flex flex-wrap items-center gap-1.5">
              <RuleProfilesControl />
              <RulesEditorButton />
            </div>
          </section>
          <section>
            <h2 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Settings</h2>
            <SettingsButton />
          </section>
          <a
            href="https://github.com/rwadada/Detour#readme"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--accent)]"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Setup &amp; docs
          </a>
        </div>
      )}
    </aside>
  );
}

/** The proxy's address, derived from `useProxyInfoStore`'s port plus the page's own host — the dashboard and the proxy it fronts are always reached at the same host, only the port differs. */
function ProxyUrlSection() {
  const proxyPort = useProxyInfoStore((s) => s.proxyPort);
  const [showQr, setShowQr] = useState(false);
  // Hooks must run unconditionally on every render — `url` falls back to ''
  // rather than skipping `useCopyToClipboard` outright, so the early return
  // below (still needed to render nothing) comes after every hook call.
  const url = proxyPort === null ? '' : `http://${window.location.hostname}:${proxyPort}`;
  const { copied, copy } = useCopyToClipboard(url);

  if (proxyPort === null) return null; // pre-issue-#24 server, or the message hasn't arrived yet

  return (
    <section>
      <h2 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Proxy URL</h2>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={copy}
          title="Copy proxy URL"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-1.5 text-left font-mono-ui text-xs hover:bg-[var(--row-hover)]"
        >
          <span className="min-w-0 flex-1 truncate">{url}</span>
          {copied ? (
            <Check className="h-3 w-3 shrink-0 text-[var(--status-2xx)]" />
          ) : (
            <Copy className="h-3 w-3 shrink-0 text-[var(--muted)]" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setShowQr((v) => !v)}
          title={showQr ? 'Hide QR code' : 'Show QR code — scan with a phone to point its proxy settings here'}
          className={cn(
            'shrink-0 rounded-md border p-1.5',
            showQr
              ? 'border-[var(--accent)] text-[var(--accent)]'
              : 'border-[var(--border)] text-[var(--muted)] hover:bg-[var(--row-hover)]',
          )}
        >
          <QrCodeIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {showQr && (
        <div className="mt-2 flex justify-center">
          <QrCode value={url} />
        </div>
      )}
    </section>
  );
}

/**
 * Only rendered while bound to every network interface (`--lan`/
 * `lanAccess`, issue #66) — lists every address this machine actually has,
 * so whoever's running Detour knows what to hand another device instead of
 * only ever seeing the address the *current* browser tab happens to be
 * viewing the dashboard from (which is `localhost` unless this very tab was
 * itself opened over LAN — `ProxyUrlSection` above has exactly that
 * limitation). The dashboard's own port isn't sent by the server at all —
 * this tab is already looking at it, as `window.location.port`.
 */
function LanAccessSection() {
  const lanAddresses = useProxyInfoStore((s) => s.lanAddresses);
  const proxyPort = useProxyInfoStore((s) => s.proxyPort);

  if (lanAddresses.length === 0) return null;
  // A plain variable rather than inlining `window.location.port` into the
  // template below — `:${port}` nested inside the outer `http://${address}…`
  // template is a nested template literal, which this codebase's lint config
  // (sonarjs/no-nested-template-literals) forbids.
  const dashboardPortSuffix = window.location.port ? `:${window.location.port}` : '';

  return (
    <section>
      <h2 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">LAN Access</h2>
      <p className="mb-1.5 text-[10px] text-[var(--muted)]">Reachable from other devices on this network at:</p>
      <div className="flex flex-col gap-2">
        {lanAddresses.map((address) => (
          <div key={address} className="flex flex-col gap-1">
            <CopyableUrl label="Dashboard" url={`http://${address}${dashboardPortSuffix}`} />
            {proxyPort !== null && <CopyableUrl label="Proxy" url={`http://${address}:${proxyPort}`} />}
          </div>
        ))}
      </div>
    </section>
  );
}

/** One copyable `label: url` row — the LAN Access list's per-address building block (`ProxyUrlSection`'s single URL button inlines the same behavior since it only ever needs one). */
function CopyableUrl({ label, url }: { label: string; url: string }) {
  const { copied, copy } = useCopyToClipboard(url);

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${label.toLowerCase()} URL`}
      className="flex min-w-0 items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-1.5 text-left font-mono-ui text-xs hover:bg-[var(--row-hover)]"
    >
      <span className="shrink-0 text-[var(--muted)]">{label}</span>
      <span className="min-w-0 flex-1 truncate">{url}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-[var(--status-2xx)]" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 text-[var(--muted)]" />
      )}
    </button>
  );
}
