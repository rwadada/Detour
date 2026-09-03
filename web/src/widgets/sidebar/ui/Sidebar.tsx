import { BookOpen, Check, ChevronLeft, ChevronRight, Copy, Route } from 'lucide-react';
import { useState } from 'react';
import { RulesEditorButton } from '@/features/rules-editor';
import { RuleProfilesControl } from '@/features/rules-profiles';
import { useConnectionStatus } from '@/shared/api';
import { cn } from '@/shared/lib/utils';
import { useProxyInfoStore } from '../model/createProxyInfoStore';
import { COLLAPSED_WIDTH, EXPANDED_WIDTH, useSidebarStore } from '../model/createSidebarStore';

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
        <Route className="h-5 w-5 shrink-0 text-[var(--accent)]" />
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
        </div>
      ) : (
        <div className="flex-1 space-y-4 overflow-y-auto p-3">
          <ProxyUrlSection />
          <section>
            <h2 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Rules</h2>
            <div className="flex flex-wrap items-center gap-1.5">
              <RuleProfilesControl />
              <RulesEditorButton />
            </div>
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
  const [copied, setCopied] = useState(false);

  if (proxyPort === null) return null; // pre-issue-#24 server, or the message hasn't arrived yet
  const url = `http://${window.location.hostname}:${proxyPort}`;

  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section>
      <h2 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Proxy URL</h2>
      <button
        type="button"
        onClick={copy}
        title="Copy proxy URL"
        className="flex w-full items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-1.5 text-left font-mono-ui text-xs hover:bg-[var(--row-hover)]"
      >
        <span className="min-w-0 flex-1 truncate">{url}</span>
        {copied ? (
          <Check className="h-3 w-3 shrink-0 text-[var(--status-2xx)]" />
        ) : (
          <Copy className="h-3 w-3 shrink-0 text-[var(--muted)]" />
        )}
      </button>
    </section>
  );
}
