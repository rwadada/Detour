import { Target, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useLogStore } from '@/store/useLogStore';

/**
 * Header control for the "Focus" host allowlist (issue #12): restricts MITM
 * interception to a set of `*`/`?` glob host patterns instead of every host
 * the proxy sees. Mirrors the adjacent Intercept On/Off toggle's styling,
 * but needs a small editable list rather than a single boolean, so it's a
 * button that opens a dropdown panel instead of toggling directly.
 */
export function FocusControl() {
  const focusHosts = useLogStore((s) => s.focusHosts);
  const setFocus = useLogStore((s) => s.setFocus);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Closes the panel on an outside click or Escape — there's no dialog
  // library in this project (see web/package.json), so this is hand-rolled.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const addHost = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (!focusHosts.includes(trimmed)) setFocus([...focusHosts, trimmed]);
    setDraft('');
  };

  const removeHost = (host: string) => setFocus(focusHosts.filter((h) => h !== host));

  const active = focusHosts.length > 0;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
          active ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--muted)] text-[var(--muted)]',
        )}
        title={
          active
            ? `Focus is on — MITM applies only to: ${focusHosts.join(', ')}`
            : 'Focus is off — every host is intercepted; click to restrict to specific hosts'
        }
      >
        <Target className="h-3 w-3" />
        {active ? `Focus (${focusHosts.length})` : 'Focus: All'}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-64 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2.5 shadow-lg">
          <p className="mb-2 text-xs text-[var(--muted)]">
            Only MITM-decrypt hosts matching one of these patterns (<code className="font-mono-ui">*</code>/
            <code className="font-mono-ui">?</code> wildcards, e.g. <code className="font-mono-ui">*.example.com</code>
            ). Empty means every host is intercepted. Add <code className="font-mono-ui">:port</code> to target a
            non-default port.
          </p>
          {focusHosts.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {focusHosts.map((host) => (
                <button
                  key={host}
                  type="button"
                  onClick={() => removeHost(host)}
                  className="group inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 font-mono-ui text-[10px]"
                  title={`Remove ${host} from Focus`}
                >
                  {host}
                  <X className="h-2.5 w-2.5 opacity-60 group-hover:opacity-100" />
                </button>
              ))}
            </div>
          )}
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addHost();
              }
            }}
            placeholder="api.example.com"
            className="h-7 text-xs"
          />
        </div>
      )}
    </div>
  );
}
